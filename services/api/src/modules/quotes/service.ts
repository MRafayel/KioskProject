import {
  createQuoteResponseSchema,
  getQuoteResponseSchema,
  priceQuoteSchema,
  type CreateQuoteResponse,
  type GetQuoteResponse,
  type PriceQuote,
  type SessionState
} from "@printing-kiosk/contracts";
import { invalidateSessionPricing, Prisma, type PrismaClient } from "@printing-kiosk/database";
import {
  normalizePrintSettings,
  PrintSettingsError,
  type DuplexMode,
  type Orientation,
  type PaperSize,
  type PrintSettingsLimits,
  type ScalingMode
} from "@printing-kiosk/domain";
import { calculateQuote, PricingError, type PricingRuleSet } from "@printing-kiosk/pricing";

import { readPrinterCapabilities } from "../settings/capabilities.js";
import { hashManifest } from "../settings/service.js";
import type { Clock, RandomSource } from "../sessions/crypto.js";
import { digestIdempotencyKey, hashRequest } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { isRetryableTransactionError, isUniqueConstraintError } from "../sessions/transactions.js";

const QUOTABLE_STATES: SessionState[] = ["CONFIGURING"];
const LOCKED_STATES: SessionState[] = ["AWAITING_PAYMENT", "PAID", "PRINTING"];
const PROCESSING_FILE_STATUSES = ["UPLOADING", "QUARANTINED", "VALIDATING"];
const MAX_TRANSACTION_ATTEMPTS = 5;

interface QuoteServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  idempotencyPepper: string;
  idempotencyTtlHours: number;
  quoteTtlSeconds: number;
  limits: PrintSettingsLimits;
}

interface CreateQuoteInput {
  kioskId: string;
  credentialId: string;
  sessionId: string;
  settingsRevision: number;
  idempotencyKey: string;
  requestId: string;
}

interface GetQuoteInput {
  kioskId: string;
  sessionId: string;
  quoteId: string;
}

export class QuoteService {
  public constructor(private readonly options: QuoteServiceOptions) {}

  public async create(input: CreateQuoteInput): Promise<CreateQuoteResponse> {
    const action = `quotes.create:${input.sessionId}`;
    const requestHash = hashRequest({
      sessionId: input.sessionId,
      settingsRevision: input.settingsRevision
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
              return this.restoreQuoteReplay(transaction, input, replay.resourceId, now);
            }

            const session = await transaction.printSession.findFirstOrThrow({
              where: { id: input.sessionId, kioskId: input.kioskId },
              include: { kiosk: { select: { capabilities: true, capabilitiesVersion: true } } }
            });
            assertSessionQuotable(session, now);
            if (session.currentSettingsRevision !== input.settingsRevision) {
              throw new ApiError(
                409,
                "SETTINGS_REVISION_STALE",
                "These settings are no longer current.",
                {
                  requestedRevision: input.settingsRevision,
                  currentRevision: session.currentSettingsRevision ?? 0
                }
              );
            }

            const revision = await transaction.printSettingRevision.findUniqueOrThrow({
              where: {
                sessionId_revision: {
                  sessionId: session.id,
                  revision: input.settingsRevision
                }
              }
            });

            // A price may only be issued while nothing about the documents is
            // still in motion, and only when the material the revision
            // described is still exactly what the session holds.
            const processing = await transaction.uploadedFile.count({
              where: { sessionId: session.id, status: { in: PROCESSING_FILE_STATUSES } }
            });
            if (processing > 0) {
              throw new ApiError(
                409,
                "FILES_STILL_PROCESSING",
                "The documents are still being checked."
              );
            }
            await this.assertManifestUnchanged(transaction, session, revision);

            const ruleSet = await this.loadPublishedRuleSet(transaction, now);
            const breakdown = calculateQuote({
              ruleSet,
              usage: {
                service: "PRINT",
                paperSize: revision.paperSize,
                colorMode: revision.colorMode,
                duplex: revision.duplex !== "SIMPLEX",
                selectedPages: revision.selectedPages,
                printedSides: revision.printedSides,
                physicalSheets: revision.physicalSheets
              }
            });

            const existing = await transaction.priceQuote.findFirst({
              where: {
                sessionId: session.id,
                status: "ACTIVE",
                settingsRevision: revision.revision,
                manifestHash: revision.manifestHash,
                ruleSetId: ruleSet.id,
                expiresAt: { gt: now }
              }
            });
            if (existing) {
              // Nothing priced has changed and the quote is still alive, so the
              // customer keeps looking at the same total and the same deadline.
              const response = createQuoteResponseSchema.parse({
                quote: toQuoteSnapshot(existing, now)
              });
              if (session.activeQuoteId !== existing.id) {
                // The live quote is the one the session points at. Repairing it
                // here means no path can leave a payable price unreachable.
                await transaction.printSession.update({
                  where: { id: session.id },
                  data: { activeQuoteId: existing.id, updatedAt: now }
                });
              }
              await this.storeReplay(transaction, {
                actorId: input.kioskId,
                action,
                idempotencyKey: input.idempotencyKey,
                requestHash,
                response,
                resourceId: existing.id,
                now
              });
              return response;
            }

            const invalidation = await invalidateSessionPricing(transaction, {
              sessionId: session.id,
              reason: "SUPERSEDED",
              now,
              startingSequence: session.eventSequence,
              newEventId: () => this.options.random.uuid(now),
              clearSettingsRevision: false
            });

            const expiresAt = new Date(
              Math.min(
                now.getTime() + this.options.quoteTtlSeconds * 1_000,
                session.idleExpiresAt.getTime(),
                session.hardExpiresAt.getTime()
              )
            );
            if (expiresAt.getTime() <= now.getTime()) {
              throw new ApiError(410, "SESSION_EXPIRED", "This session has expired.");
            }

            const quote = await transaction.priceQuote.create({
              data: {
                id: this.options.random.uuid(now),
                sessionId: session.id,
                settingsRevision: revision.revision,
                manifestHash: revision.manifestHash,
                ruleSetId: ruleSet.id,
                pricingVersion: ruleSet.version,
                status: "ACTIVE",
                currency: breakdown.currency,
                currencyExponent: breakdown.currencyExponent,
                selectedPages: breakdown.selectedPages,
                printedSides: breakdown.printedSides,
                physicalSheets: breakdown.physicalSheets,
                printAmountMinor: breakdown.printAmountMinor,
                duplexAdjustmentMinor: breakdown.duplexAdjustmentMinor,
                serviceFeeMinor: breakdown.serviceFeeMinor,
                minimumAdjustmentMinor: breakdown.minimumAdjustmentMinor,
                subtotalMinor: breakdown.subtotalMinor,
                taxMinor: breakdown.taxMinor,
                totalMinor: breakdown.totalMinor,
                expiresAt,
                createdAt: now
              }
            });

            const nextSequence = invalidation.nextSequence + 1;
            await transaction.printSession.update({
              where: { id: session.id },
              data: {
                activeQuoteId: quote.id,
                eventSequence: nextSequence,
                updatedAt: now
              }
            });

            const response = createQuoteResponseSchema.parse({
              quote: toQuoteSnapshot(quote, now)
            });

            await Promise.all([
              transaction.outboxEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  aggregateType: "PRINT_SESSION",
                  aggregateId: session.id,
                  sequence: nextSequence,
                  type: "quote.created",
                  payload: {
                    sessionId: session.id,
                    quoteId: quote.id,
                    settingsRevision: quote.settingsRevision,
                    pricingVersion: quote.pricingVersion,
                    currency: quote.currency,
                    currencyExponent: quote.currencyExponent,
                    totalMinor: quote.totalMinor,
                    expiresAt: quote.expiresAt.toISOString()
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
                  action: "quote.created",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: {
                    quoteId: quote.id,
                    settingsRevision: quote.settingsRevision,
                    pricingVersion: quote.pricingVersion,
                    totalMinor: quote.totalMinor,
                    currency: quote.currency
                  }
                }
              }),
              this.storeReplay(transaction, {
                actorId: input.kioskId,
                action,
                idempotencyKey: input.idempotencyKey,
                requestHash,
                response,
                resourceId: quote.id,
                now
              })
            ]);

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        // A second active quote losing the one-per-session index is the same
        // race, and the retry returns the quote that won it.
        if (isRetryableTransactionError(error) || isUniqueConstraintError(error)) continue;
        throw mapQuoteError(error);
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The session changed concurrently. Please retry."
    );
  }

  public async get(input: GetQuoteInput): Promise<GetQuoteResponse> {
    const quote = await this.options.database.priceQuote.findFirst({
      where: {
        id: input.quoteId,
        sessionId: input.sessionId,
        session: { kioskId: input.kioskId }
      }
    });
    if (!quote) throw new ApiError(404, "QUOTE_NOT_FOUND", "Quote not found.");

    return getQuoteResponseSchema.parse({
      quote: toQuoteSnapshot(quote, this.options.clock.now())
    });
  }

  /**
   * Recompute the manifest from what the session holds now and compare it with
   * the revision the customer is asking to pay for. The stored counts are not
   * trusted on their own: a document that was replaced, reprocessed, or removed
   * changes the hash even when the revision row still looks valid.
   */
  private async assertManifestUnchanged(
    transaction: Prisma.TransactionClient,
    session: {
      id: string;
      kiosk: { capabilities: unknown; capabilitiesVersion: number };
    },
    revision: {
      revision: number;
      manifestHash: string;
      copies: number;
      duplex: string;
      paperSize: string;
      orientation: string;
      scaling: string;
      collate: boolean;
      selections: unknown;
    }
  ): Promise<void> {
    const files = await transaction.uploadedFile.findMany({
      where: { sessionId: session.id, status: "READY" },
      orderBy: { ordinal: "asc" },
      select: { id: true, pageCount: true, processingRevision: true, contentSha256: true }
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

    const selections = readSelections(revision.selections);
    if (selectable.length === 0 || selections.length !== selectable.length) {
      throw documentsChanged();
    }

    const capabilities = readPrinterCapabilities(session.kiosk, this.options.limits);
    let recomputed: string;
    try {
      recomputed = hashManifest(
        normalizePrintSettings(
          {
            fileOrder: selections.map((selection) => selection.fileId),
            fileSelections: selections.map((selection) => ({
              fileId: selection.fileId,
              pageRanges: selection.pageRangeText
            })),
            copies: revision.copies,
            duplex: revision.duplex as DuplexMode,
            paperSize: revision.paperSize as PaperSize,
            orientation: revision.orientation as Orientation,
            scaling: revision.scaling as ScalingMode,
            collate: revision.collate
          },
          { files: selectable, capabilities, limits: this.options.limits }
        )
      );
    } catch (error) {
      // A revision that no longer normalizes — a shorter reprocessed document,
      // a capability that was withdrawn — is a changed manifest, not a bug.
      if (error instanceof PrintSettingsError) throw documentsChanged();
      throw error;
    }

    if (recomputed !== revision.manifestHash) throw documentsChanged();
  }

  private async loadPublishedRuleSet(
    transaction: Prisma.TransactionClient,
    now: Date
  ): Promise<PricingRuleSet> {
    const ruleSet = await transaction.pricingRuleSet.findFirst({
      where: {
        status: "PUBLISHED",
        scope: "GLOBAL",
        // The published-per-scope unique index covers (scope, scope_ref), so
        // the empty scope_ref that a global tariff carries has to be part of
        // the lookup. Without it a stray global row with some other scope_ref
        // would be an equally valid match and the tariff in force would depend
        // on row order.
        scopeRef: "",
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gt: now } }]
      },
      include: { rules: true },
      orderBy: { validFrom: "desc" }
    });
    if (!ruleSet) {
      throw new ApiError(503, "PRICING_UNAVAILABLE", "Pricing is temporarily unavailable.");
    }

    return {
      id: ruleSet.id,
      version: ruleSet.version,
      currency: ruleSet.currency,
      currencyExponent: ruleSet.currencyExponent,
      rounding: ruleSet.rounding as PricingRuleSet["rounding"],
      taxMode: ruleSet.taxMode as PricingRuleSet["taxMode"],
      minimumApplication: ruleSet.minimumApplication as PricingRuleSet["minimumApplication"],
      rules: ruleSet.rules.map((rule) => ({
        service: rule.service,
        paperSize: rule.paperSize,
        colorMode: rule.colorMode,
        unitAmountMinor: rule.unitAmountMinor,
        duplexAdjustmentBasisPoints: rule.duplexAdjustmentBasisPoints,
        serviceFeeMinor: rule.serviceFeeMinor,
        minimumAmountMinor: rule.minimumAmountMinor,
        taxBasisPoints: rule.taxBasisPoints,
        priority: rule.priority
      }))
    };
  }

  private async restoreQuoteReplay(
    transaction: Prisma.TransactionClient,
    input: CreateQuoteInput,
    resourceId: string | null,
    now: Date
  ): Promise<CreateQuoteResponse> {
    const quote = resourceId
      ? await transaction.priceQuote.findFirst({
          where: { id: resourceId, sessionId: input.sessionId }
        })
      : null;
    if (!quote) {
      throw new ApiError(
        409,
        "QUOTE_REPLAY_UNAVAILABLE",
        "The previous quote is no longer available."
      );
    }
    return createQuoteResponseSchema.parse({ quote: toQuoteSnapshot(quote, now) });
  }

  private async storeReplay(
    transaction: Prisma.TransactionClient,
    input: {
      actorId: string;
      action: string;
      idempotencyKey: string;
      requestHash: string;
      response: CreateQuoteResponse;
      resourceId: string;
      now: Date;
    }
  ): Promise<void> {
    await transaction.idempotencyRecord.create({
      data: {
        id: this.options.random.uuid(input.now),
        actorId: input.actorId,
        action: input.action,
        keyDigest: digestIdempotencyKey(
          input.actorId,
          input.action,
          input.idempotencyKey,
          this.options.idempotencyPepper
        ),
        requestHash: input.requestHash,
        responseStatus: 201,
        responseBody: input.response,
        resourceId: input.resourceId,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + this.options.idempotencyTtlHours * 3_600_000)
      }
    });
  }
}

interface StoredSelection {
  fileId: string;
  pageRangeText: string;
}

function readSelections(value: unknown): StoredSelection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return typeof record.fileId === "string" && typeof record.pageRangeText === "string"
      ? [{ fileId: record.fileId, pageRangeText: record.pageRangeText }]
      : [];
  });
}

interface StoredQuote {
  id: string;
  sessionId: string;
  settingsRevision: number;
  pricingVersion: string;
  status: string;
  currency: string;
  currencyExponent: number;
  selectedPages: number;
  printedSides: number;
  physicalSheets: number;
  printAmountMinor: number;
  duplexAdjustmentMinor: number;
  serviceFeeMinor: number;
  minimumAdjustmentMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * An active quote whose deadline has passed is reported as expired without
 * waiting for a background sweep to rewrite the row.
 */
function toQuoteSnapshot(quote: StoredQuote, now: Date): PriceQuote {
  const status =
    quote.status === "ACTIVE" && now.getTime() >= quote.expiresAt.getTime()
      ? "EXPIRED"
      : quote.status;

  return priceQuoteSchema.parse({
    id: quote.id,
    sessionId: quote.sessionId,
    settingsRevision: quote.settingsRevision,
    pricingVersion: quote.pricingVersion,
    status,
    currency: quote.currency.trim(),
    currencyExponent: quote.currencyExponent,
    selectedPages: quote.selectedPages,
    printedSides: quote.printedSides,
    physicalSheets: quote.physicalSheets,
    breakdown: {
      printAmountMinor: quote.printAmountMinor,
      duplexAdjustmentMinor: quote.duplexAdjustmentMinor,
      serviceFeeMinor: quote.serviceFeeMinor,
      minimumAdjustmentMinor: quote.minimumAdjustmentMinor
    },
    subtotalMinor: quote.subtotalMinor,
    taxMinor: quote.taxMinor,
    totalMinor: quote.totalMinor,
    createdAt: quote.createdAt.toISOString(),
    expiresAt: quote.expiresAt.toISOString()
  });
}

function assertSessionQuotable(
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
    throw new ApiError(423, "QUOTE_LOCKED", "The price is locked while payment is in progress.", {
      currentState: session.state
    });
  }
  if (!QUOTABLE_STATES.includes(session.state as SessionState)) {
    throw new ApiError(409, "INVALID_SESSION_STATE", "This session cannot be priced yet.", {
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
  if (rows.length === 0) throw new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
}

function documentsChanged(): ApiError {
  return new ApiError(
    409,
    "DOCUMENTS_CHANGED",
    "The documents changed. Please review the settings again."
  );
}

function mapQuoteError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof PricingError) {
    // A malformed published tariff is an operational fault, never a customer
    // error, and no internal pricing detail crosses the boundary.
    return new ApiError(503, "PRICING_UNAVAILABLE", "Pricing is temporarily unavailable.");
  }
  if (error instanceof PrintSettingsError) return documentsChanged();
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    return new ApiError(409, "SETTINGS_REVISION_STALE", "These settings are no longer current.");
  }
  return error;
}
