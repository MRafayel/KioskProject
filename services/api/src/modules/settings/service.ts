import { createHash } from "node:crypto";

import {
  getPrintSettingsResponseSchema,
  printCapabilitiesResponseSchema,
  printSettingsSnapshotSchema,
  updatePrintSettingsResponseSchema,
  type GetPrintSettingsResponse,
  type PrintCapabilitiesResponse,
  type PrintSettingsSnapshot,
  type SessionState,
  type UpdatePrintSettingsBody,
  type UpdatePrintSettingsResponse
} from "@printing-kiosk/contracts";
import { invalidateSessionPricing, Prisma, type PrismaClient } from "@printing-kiosk/database";
import {
  buildSettingsManifest,
  canonicalManifestJson,
  normalizePrintSettings,
  PrintSettingsError,
  transitionSession,
  type NormalizedPrintSettings,
  type PrintSettingsLimits
} from "@printing-kiosk/domain";

import { readPrinterCapabilities } from "./capabilities.js";
import type { Clock, RandomSource } from "../sessions/crypto.js";
import { digestIdempotencyKey, hashRequest } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { isRetryableTransactionError, isUniqueConstraintError } from "../sessions/transactions.js";

const CONFIGURABLE_STATES: SessionState[] = ["FILES_UPLOADED", "CONFIGURING"];
const LOCKED_STATES: SessionState[] = ["AWAITING_PAYMENT", "PAID", "PRINTING"];
const MAX_TRANSACTION_ATTEMPTS = 5;

interface PrintSettingsServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  idempotencyPepper: string;
  idempotencyTtlHours: number;
  limits: PrintSettingsLimits;
}

interface UpdateSettingsInput {
  kioskId: string;
  credentialId: string;
  sessionId: string;
  body: UpdatePrintSettingsBody;
  expectedVersion: number;
  idempotencyKey: string;
  requestId: string;
}

interface ReadSettingsInput {
  kioskId: string;
  sessionId: string;
}

export class PrintSettingsService {
  public constructor(private readonly options: PrintSettingsServiceOptions) {}

  public async update(input: UpdateSettingsInput): Promise<UpdatePrintSettingsResponse> {
    const action = `settings.update:${input.sessionId}`;
    const requestHash = hashRequest({
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      body: fingerprintSettingsRequest(input.body)
    });

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            const now = this.options.clock.now();
            await lockSession(transaction, input.sessionId, input.kioskId);

            const replay = await findIdempotency(
              transaction,
              input.kioskId,
              action,
              input.idempotencyKey,
              this.options.idempotencyPepper,
              now
            );
            if (replay) {
              assertMatchingRequest(replay.requestHash, requestHash);
              return updatePrintSettingsResponseSchema.parse(replay.responseBody);
            }

            const session = await transaction.printSession.findFirstOrThrow({
              where: { id: input.sessionId, kioskId: input.kioskId },
              include: { kiosk: { select: { capabilities: true, capabilitiesVersion: true } } }
            });
            assertSessionUsable(session, now);
            if (session.stateVersion !== input.expectedVersion) {
              throw new ApiError(412, "STALE_SESSION_VERSION", "The session version is stale.", {
                expectedVersion: input.expectedVersion,
                currentVersion: session.stateVersion
              });
            }

            const files = await transaction.uploadedFile.findMany({
              where: { sessionId: session.id, status: "READY" },
              orderBy: { ordinal: "asc" },
              select: {
                id: true,
                pageCount: true,
                processingRevision: true,
                contentSha256: true
              }
            });
            const selectable = files.flatMap((file) =>
              file.pageCount !== null && file.contentSha256 !== null
                ? [
                    {
                      id: file.id,
                      pageCount: file.pageCount,
                      processingRevision: file.processingRevision,
                      contentSha256: file.contentSha256
                    }
                  ]
                : []
            );
            if (selectable.length === 0) {
              throw new ApiError(
                409,
                "NO_READY_DOCUMENTS",
                "This session has no validated document to configure."
              );
            }

            const capabilities = readPrinterCapabilities(session.kiosk, this.options.limits);
            const normalized = normalizeOrFail(input.body, {
              files: selectable,
              capabilities,
              limits: this.options.limits
            });
            const manifestHash = hashManifest(normalized);

            const latest = await transaction.printSettingRevision.findFirst({
              where: { sessionId: session.id },
              orderBy: { revision: "desc" },
              select: { revision: true }
            });
            const revision = (latest?.revision ?? 0) + 1;

            const stored = await transaction.printSettingRevision.create({
              data: {
                id: this.options.random.uuid(now),
                sessionId: session.id,
                revision,
                paperSize: normalized.paperSize,
                scaling: normalized.scaling,
                collate: normalized.collate,
                colorMode: normalized.colorMode,
                selections: normalized.files.map((file) => ({
                  fileId: file.fileId,
                  position: file.position,
                  pageCount: file.pageCount,
                  processingRevision: file.processingRevision,
                  contentSha256: file.contentSha256,
                  pageRanges: file.pageRanges.map(([start, end]) => [start, end]),
                  pageRangeText: file.pageRangeText,
                  selectedPages: file.selectedPages,
                  copies: file.copies,
                  duplex: file.duplex,
                  orientation: file.orientation,
                  printedSides: file.printedSides,
                  physicalSheets: file.physicalSheets
                })),
                selectedPages: normalized.selectedPages,
                printedSides: normalized.printedSides,
                physicalSheets: normalized.physicalSheets,
                capabilityVersion: normalized.capabilityVersion,
                manifestHash,
                createdByActorType: "KIOSK",
                createdByActorId: input.credentialId,
                createdAt: now
              }
            });

            // The saved revision replaces whatever was priced before it, so any
            // live quote dies in the same transaction that writes the revision.
            const invalidation = await invalidateSessionPricing(transaction, {
              sessionId: session.id,
              reason: "SETTINGS_CHANGED",
              now,
              startingSequence: session.eventSequence,
              newEventId: () => this.options.random.uuid(now),
              clearSettingsRevision: false
            });

            const nextState: SessionState =
              session.state === "CONFIGURING"
                ? "CONFIGURING"
                : transitionSession(
                    { state: session.state as SessionState, version: session.stateVersion },
                    "CONFIGURING",
                    input.expectedVersion
                  ).state;
            const nextVersion = session.stateVersion + 1;
            const nextSequence = invalidation.nextSequence + 1;

            const updated = await transaction.printSession.updateMany({
              where: { id: session.id, stateVersion: input.expectedVersion },
              data: {
                state: nextState,
                stateVersion: nextVersion,
                eventSequence: nextSequence,
                currentSettingsRevision: revision,
                updatedAt: now
              }
            });
            if (updated.count !== 1) {
              throw new ApiError(412, "STALE_SESSION_VERSION", "The session version is stale.", {
                expectedVersion: input.expectedVersion,
                currentVersion: session.stateVersion
              });
            }

            const settings = toSettingsSnapshot(stored, normalized);
            const response = updatePrintSettingsResponseSchema.parse({
              settings,
              sessionState: nextState,
              sessionVersion: nextVersion,
              quoteInvalidated: invalidation.invalidatedQuoteId !== null
            });

            await Promise.all([
              transaction.outboxEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  aggregateType: "PRINT_SESSION",
                  aggregateId: session.id,
                  sequence: nextSequence,
                  type: "settings.updated",
                  payload: {
                    sessionId: session.id,
                    settingsRevision: revision,
                    state: nextState,
                    version: nextVersion,
                    selectedPages: normalized.selectedPages,
                    printedSides: normalized.printedSides,
                    physicalSheets: normalized.physicalSheets
                  }
                }
              }),
              transaction.auditEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  occurredAt: now,
                  actorType: "KIOSK",
                  actorId: input.credentialId,
                  kioskId: input.kioskId,
                  sessionId: session.id,
                  action: "settings.updated",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: {
                    revision,
                    printedSides: normalized.printedSides,
                    physicalSheets: normalized.physicalSheets,
                    quoteInvalidated: invalidation.invalidatedQuoteId !== null
                  }
                }
              }),
              transaction.idempotencyRecord.create({
                data: {
                  id: this.options.random.uuid(now),
                  actorId: input.kioskId,
                  action,
                  keyDigest: digestIdempotencyKey(
                    input.kioskId,
                    action,
                    input.idempotencyKey,
                    this.options.idempotencyPepper
                  ),
                  requestHash,
                  responseStatus: 200,
                  responseBody: response,
                  resourceId: stored.id,
                  createdAt: now,
                  expiresAt: addHours(now, this.options.idempotencyTtlHours)
                }
              })
            ]);

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        // Two saves that raced for the same revision number are a concurrency
        // conflict, not a client error: the retry re-reads the session and
        // either allocates the next revision or reports the stale version.
        if (isRetryableTransactionError(error) || isUniqueConstraintError(error)) continue;
        throw mapSettingsError(error);
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The session changed concurrently. Please retry."
    );
  }

  public async get(input: ReadSettingsInput): Promise<GetPrintSettingsResponse> {
    const session = await this.options.database.printSession.findFirst({
      where: { id: input.sessionId, kioskId: input.kioskId },
      select: { id: true, currentSettingsRevision: true }
    });
    if (!session) throw sessionNotFound();
    if (session.currentSettingsRevision === null) {
      return getPrintSettingsResponseSchema.parse({ settings: null });
    }

    const stored = await this.options.database.printSettingRevision.findUnique({
      where: {
        sessionId_revision: {
          sessionId: session.id,
          revision: session.currentSettingsRevision
        }
      }
    });
    if (!stored) return getPrintSettingsResponseSchema.parse({ settings: null });

    return getPrintSettingsResponseSchema.parse({ settings: toStoredSettingsSnapshot(stored) });
  }

  public async capabilities(input: ReadSettingsInput): Promise<PrintCapabilitiesResponse> {
    const session = await this.options.database.printSession.findFirst({
      where: { id: input.sessionId, kioskId: input.kioskId },
      select: { kiosk: { select: { capabilities: true, capabilitiesVersion: true } } }
    });
    if (!session) throw sessionNotFound();

    const capabilities = readPrinterCapabilities(session.kiosk, this.options.limits);
    // A snapshot that does not clearly promise monochrome describes a device
    // this product cannot sell from. Reporting that plainly matters: the
    // response schema requires at least one colour mode, so without this the
    // kiosk would be told its own perfectly valid request was malformed.
    if (capabilities.colorModes.length === 0) {
      throw new ApiError(503, "PRINTER_UNAVAILABLE", "This kiosk cannot print right now.", {
        capabilityVersion: capabilities.version
      });
    }

    return printCapabilitiesResponseSchema.parse({
      capabilityVersion: capabilities.version,
      paperSizes: capabilities.paperSizes,
      duplexModes: capabilities.duplexModes,
      orientations: capabilities.orientations,
      scalingModes: capabilities.scalingModes,
      colorModes: capabilities.colorModes,
      maxCopies: capabilities.maxCopies,
      maxSelectedPages: this.options.limits.maxSelectedPages,
      maxPrintedSides: this.options.limits.maxPrintedSides
    });
  }
}

/** sha256 over the canonical manifest string; the quote is bound to this. */
export function hashManifest(settings: NormalizedPrintSettings): string {
  return createHash("sha256")
    .update(canonicalManifestJson(buildSettingsManifest(settings)), "utf8")
    .digest("hex");
}

export interface StoredSettingsRevision {
  revision: number;
  paperSize: string;
  scaling: string;
  collate: boolean;
  colorMode: string;
  selections: unknown;
  selectedPages: number;
  printedSides: number;
  physicalSheets: number;
  createdAt: Date;
}

export function toStoredSettingsSnapshot(stored: StoredSettingsRevision): PrintSettingsSnapshot {
  const selections = Array.isArray(stored.selections) ? stored.selections : [];
  return printSettingsSnapshotSchema.parse({
    revision: stored.revision,
    paperSize: stored.paperSize,
    scaling: stored.scaling,
    collate: stored.collate,
    colorMode: stored.colorMode,
    files: selections.map((selection) => {
      const record = selection as Record<string, unknown>;
      return {
        fileId: record.fileId,
        position: record.position,
        pageCount: record.pageCount,
        pageRanges: record.pageRanges,
        pageRangeText: record.pageRangeText,
        selectedPages: record.selectedPages,
        copies: record.copies,
        duplex: record.duplex,
        orientation: record.orientation,
        printedSides: record.printedSides,
        physicalSheets: record.physicalSheets
      };
    }),
    selectedPages: stored.selectedPages,
    printedSides: stored.printedSides,
    physicalSheets: stored.physicalSheets,
    createdAt: stored.createdAt.toISOString()
  });
}

function toSettingsSnapshot(
  stored: { revision: number; createdAt: Date },
  normalized: NormalizedPrintSettings
): PrintSettingsSnapshot {
  return printSettingsSnapshotSchema.parse({
    revision: stored.revision,
    paperSize: normalized.paperSize,
    scaling: normalized.scaling,
    collate: normalized.collate,
    colorMode: normalized.colorMode,
    files: normalized.files.map((file) => ({
      fileId: file.fileId,
      position: file.position,
      pageCount: file.pageCount,
      pageRanges: file.pageRanges.map(([start, end]) => [start, end]),
      pageRangeText: file.pageRangeText,
      selectedPages: file.selectedPages,
      copies: file.copies,
      duplex: file.duplex,
      orientation: file.orientation,
      printedSides: file.printedSides,
      physicalSheets: file.physicalSheets
    })),
    selectedPages: normalized.selectedPages,
    printedSides: normalized.printedSides,
    physicalSheets: normalized.physicalSheets,
    createdAt: stored.createdAt.toISOString()
  });
}

function normalizeOrFail(
  body: UpdatePrintSettingsBody,
  context: Parameters<typeof normalizePrintSettings>[1]
): NormalizedPrintSettings {
  // The contract enums and the domain unions are the same closed sets, so the
  // parsed body is already a valid domain input.
  return normalizePrintSettings(
    {
      fileOrder: body.fileOrder,
      fileSelections: body.fileSelections,
      paperSize: body.paperSize,
      scaling: body.scaling,
      collate: body.collate
    },
    context
  );
}

/**
 * A stable fingerprint of the request. It is only ever compared with another
 * fingerprint, so it needs to be deterministic rather than readable.
 */
function fingerprintSettingsRequest(body: UpdatePrintSettingsBody): string {
  const selections = [...body.fileSelections]
    .sort((left, right) => (left.fileId < right.fileId ? -1 : left.fileId > right.fileId ? 1 : 0))
    .map(
      (selection) =>
        `${selection.fileId}=${selection.pageRanges ?? ""}:${selection.copies}:` +
        `${selection.duplex}:${selection.orientation}`
    )
    .join("|");
  return [
    body.fileOrder.join(">"),
    selections,
    body.paperSize,
    body.scaling,
    body.collate ? "collate" : "no-collate"
  ].join("\n");
}

function assertSessionUsable(
  session: { state: string; idleExpiresAt: Date; hardExpiresAt: Date },
  now: Date
): void {
  if (
    now.getTime() >= session.idleExpiresAt.getTime() ||
    now.getTime() >= session.hardExpiresAt.getTime() ||
    session.state === "EXPIRED"
  ) {
    throw new ApiError(410, "SESSION_EXPIRED", "This session has expired.");
  }
  if (LOCKED_STATES.includes(session.state as SessionState)) {
    throw new ApiError(423, "SETTINGS_LOCKED", "Settings cannot change once payment has started.", {
      currentState: session.state
    });
  }
  if (!CONFIGURABLE_STATES.includes(session.state as SessionState)) {
    throw new ApiError(409, "INVALID_SESSION_STATE", "This session cannot be configured.", {
      currentState: session.state
    });
  }
}

type IdempotencyClient = Pick<PrismaClient, "idempotencyRecord"> | Prisma.TransactionClient;

async function findIdempotency(
  client: IdempotencyClient,
  actorId: string,
  action: string,
  key: string,
  pepper: string,
  now: Date
) {
  const keyDigest = digestIdempotencyKey(actorId, action, key, pepper);
  const record = await client.idempotencyRecord.findUnique({
    where: { actorId_action_keyDigest: { actorId, action, keyDigest } }
  });
  if (!record || record.expiresAt.getTime() > now.getTime()) return record;
  await client.idempotencyRecord.deleteMany({ where: { id: record.id, expiresAt: { lte: now } } });
  return null;
}

function assertMatchingRequest(stored: string, current: string): void {
  if (stored !== current) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request."
    );
  }
}

async function lockSession(
  transaction: Prisma.TransactionClient,
  sessionId: string,
  kioskId: string
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "print_sessions"
    WHERE "id" = ${sessionId}::uuid AND "kiosk_id" = ${kioskId}
    FOR UPDATE
  `;
  if (rows.length === 0) throw sessionNotFound();
}

function mapSettingsError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof PrintSettingsError) return mapDomainSettingsError(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    return sessionNotFound();
  }
  return error;
}

function mapDomainSettingsError(error: PrintSettingsError): ApiError {
  const messages: Record<string, string> = {
    FILE_ORDER_INVALID: "The document order does not match this session.",
    FILE_SELECTION_INVALID: "The page selection does not match this session.",
    PAGE_RANGE_INVALID: "The page range is not valid.",
    PAGE_RANGE_OUT_OF_BOUNDS: "The page range is outside this document.",
    NO_SELECTED_PAGES: "Select at least one page to print.",
    COPIES_OUT_OF_RANGE: "That number of copies is not available.",
    SELECTED_PAGE_LIMIT_EXCEEDED: "That selection has too many pages.",
    PRINTED_SIDE_LIMIT_EXCEEDED: "That job would print too many sides.",
    UNSUPPORTED_PRINT_SETTING: "This kiosk cannot print with those settings."
  };
  return new ApiError(
    422,
    error.code,
    messages[error.code] ?? "These print settings are not supported.",
    error.details
  );
}

function sessionNotFound(): ApiError {
  return new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}
