import { createHash } from "node:crypto";

import {
  cancelPrintJobResponseSchema,
  createPrintJobResponseSchema,
  getPrintJobResponseSchema,
  printFailureCodeSchema,
  printJobManifestSchema,
  printJobSnapshotSchema,
  printResultConfidenceSchema,
  printWarningCodeSchema,
  type CancelPrintJobResponse,
  type CreatePrintJobResponse,
  type GetPrintJobResponse,
  type PrintJobManifestContract,
  type PrintJobSnapshot,
  type SessionState,
  type SimulatedPrintOutcome
} from "@printing-kiosk/contracts";
import {
  applyPrintJobSettlement,
  Prisma,
  recordPrintJobEvent,
  type PrismaClient
} from "@printing-kiosk/database";
import {
  settlePrintDeviceResult,
  SessionDomainError,
  transitionSession
} from "@printing-kiosk/domain";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { digestIdempotencyKey, hashRequest } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { isRetryableTransactionError, isUniqueConstraintError } from "../sessions/transactions.js";

const MAX_TRANSACTION_ATTEMPTS = 5;
const OPEN_STATUSES = ["QUEUED", "DISPATCHED", "PRINTING"];

export interface PrintJobServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  idempotencyPepper: string;
  idempotencyTtlHours: number;
  printJobTimeoutSeconds: number;
  /** Development scenarios. False in production, checked again per request. */
  testOutcomesEnabled: boolean;
}

interface CreatePrintJobInput {
  kioskId: string;
  credentialId: string;
  sessionId: string;
  paymentId: string;
  simulatedOutcome?: SimulatedPrintOutcome | undefined;
  idempotencyKey: string;
  requestId: string;
}

interface CancelPrintJobInput {
  kioskId: string;
  credentialId: string;
  printJobId: string;
  idempotencyKey: string;
  requestId: string;
}

interface StoredSelection {
  fileId: string;
  position: number;
  pageCount: number;
  processingRevision: number;
  contentSha256: string;
  pageRanges: Array<[number, number]>;
  selectedPages: number;
}

/**
 * Print job orchestration.
 *
 * Three rules hold everywhere in this file. A print job exists only because a
 * capture was applied to the session, and it prints exactly the settings
 * revision that capture paid for — the database re-checks both. Nothing here
 * talks to a device: the HTTP path writes a durable job and returns, and the
 * worker and the local agent do the printing. And no outcome is ever assumed:
 * a job whose result cannot be confirmed becomes `RECOVERY_REQUIRED` rather
 * than a success or a silent failure.
 */
export class PrintJobService {
  public constructor(private readonly options: PrintJobServiceOptions) {}

  public async create(input: CreatePrintJobInput): Promise<CreatePrintJobResponse> {
    const action = `print-jobs.create:${input.sessionId}`;
    const requestHash = hashRequest({
      sessionId: input.sessionId,
      paymentId: input.paymentId,
      simulatedOutcome: input.simulatedOutcome ?? ""
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
              // The stored body describes the moment the job was created; the
              // kiosk needs to know where it stands now, so the row is re-read.
              return createPrintJobResponseSchema.parse({
                printJob: await this.replayJob(transaction, replay.resourceId, input.sessionId)
              });
            }

            const session = await transaction.printSession.findFirstOrThrow({
              where: { id: input.sessionId, kioskId: input.kioskId }
            });

            // A session prints once. A repeated request — a reload, a retried
            // fetch, a fresh idempotency key — returns the job it already has
            // instead of trying to print a second time.
            const existing = await transaction.printJob.findUnique({
              where: { sessionId: session.id }
            });
            if (existing) {
              if (existing.paymentId !== input.paymentId) {
                throw new ApiError(
                  409,
                  "PRINT_JOB_EXISTS",
                  "This session already has a print job.",
                  { printJobId: existing.id }
                );
              }
              return createPrintJobResponseSchema.parse({
                printJob: toPrintJobSnapshot(existing)
              });
            }

            assertSessionPrintable(session.state as SessionState);

            // Only the capture that was applied to this session may print, and
            // only the settings revision it paid for. A database trigger
            // re-checks every part of this on insert.
            const payment = await transaction.payment.findFirst({
              where: {
                id: input.paymentId,
                sessionId: session.id,
                status: "CAPTURED",
                appliedToSession: true
              }
            });
            if (!payment) {
              throw new ApiError(
                409,
                "PRINT_PAYMENT_REQUIRED",
                "This session has no capture that can be printed."
              );
            }

            const settings = await transaction.printSettingRevision.findUnique({
              where: {
                sessionId_revision: {
                  sessionId: session.id,
                  revision: payment.settingsRevision
                }
              }
            });
            if (!settings || settings.manifestHash !== payment.manifestHash) {
              throw new ApiError(
                409,
                "PRINT_SETTINGS_UNAVAILABLE",
                "The settings that were paid for are no longer available."
              );
            }

            const documents = await this.resolveDocuments(transaction, session.id, settings);
            const printJobId = this.options.random.uuid(now);
            const manifest = printJobManifestSchema.parse({
              manifestVersion: 1,
              printJobId,
              sessionId: session.id,
              settingsRevision: settings.revision,
              settingsManifestHash: settings.manifestHash,
              quoteId: payment.quoteId,
              paymentId: payment.id,
              copies: settings.copies,
              duplex: settings.duplex,
              paperSize: settings.paperSize,
              orientation: settings.orientation,
              scaling: settings.scaling,
              collate: settings.collate,
              colorMode: settings.colorMode,
              selectedPages: settings.selectedPages,
              printedSides: settings.printedSides,
              physicalSheets: settings.physicalSheets,
              documents
            });

            const printJob = await transaction.printJob.create({
              data: {
                id: printJobId,
                sessionId: session.id,
                kioskId: input.kioskId,
                quoteId: payment.quoteId,
                paymentId: payment.id,
                settingsRevision: settings.revision,
                settingsManifestHash: settings.manifestHash,
                jobManifest: manifest,
                jobManifestHash: hashPrintManifest(manifest),
                status: "QUEUED",
                resultConfidence: "UNKNOWN",
                copies: settings.copies,
                printedSides: settings.printedSides,
                physicalSheets: settings.physicalSheets,
                availableAt: now,
                deadlineAt: new Date(now.getTime() + this.options.printJobTimeoutSeconds * 1_000),
                // The scenario control never exists in production, and the
                // route has already refused the field when it is disabled.
                simulatedOutcome: this.options.testOutcomesEnabled
                  ? (input.simulatedOutcome ?? null)
                  : null,
                createdByActorType: "KIOSK",
                createdByActorId: input.credentialId,
                createdAt: now,
                updatedAt: now
              }
            });

            const nextSequence = await this.startPrinting(transaction, session, printJob.id, now);
            const response = createPrintJobResponseSchema.parse({
              printJob: toPrintJobSnapshot(printJob)
            });

            await Promise.all([
              recordPrintJobEvent(transaction, {
                id: this.options.random.uuid(now),
                printJobId: printJob.id,
                type: "CREATED",
                status: "QUEUED",
                now,
                detail: { settingsRevision: settings.revision, documents: documents.length }
              }),
              transaction.auditEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  occurredAt: now,
                  actorType: "KIOSK",
                  actorId: input.credentialId,
                  kioskId: input.kioskId,
                  sessionId: session.id,
                  action: "print.created",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: {
                    printJobId: printJob.id,
                    paymentId: payment.id,
                    physicalSheets: settings.physicalSheets,
                    sequence: nextSequence
                  }
                }
              }),
              this.storeReplay(transaction, {
                actorId: input.kioskId,
                action,
                idempotencyKey: input.idempotencyKey,
                requestHash,
                responseStatus: 201,
                response,
                resourceId: printJob.id,
                now
              })
            ]);

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw mapPrintJobError(error);
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The session changed concurrently. Please retry."
    );
  }

  public async get(input: { kioskId: string; printJobId: string }): Promise<GetPrintJobResponse> {
    const printJob = await this.options.database.printJob.findFirst({
      where: { id: input.printJobId, kioskId: input.kioskId }
    });
    // A foreign kiosk is told the job does not exist rather than that it exists
    // and belongs to somebody else.
    if (!printJob) throw printJobNotFound();

    return getPrintJobResponseSchema.parse({ printJob: toPrintJobSnapshot(printJob) });
  }

  /**
   * Stop a print the customer no longer wants.
   *
   * A job the device has not seen can be stopped for certain, and the capture
   * that paid for it becomes money owed back. A job already handed over cannot:
   * the request is recorded, and the device's own answer or the job deadline
   * settles it. Nothing here claims that paper did or did not emerge.
   */
  public async cancel(input: CancelPrintJobInput): Promise<CancelPrintJobResponse> {
    const action = `print-jobs.cancel:${input.printJobId}`;
    const requestHash = hashRequest({ printJobId: input.printJobId });

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            const now = this.options.clock.now();
            const owned = await transaction.printJob.findFirst({
              where: { id: input.printJobId, kioskId: input.kioskId },
              select: { id: true, sessionId: true }
            });
            if (!owned) throw printJobNotFound();
            await lockSession(transaction, owned.sessionId, input.kioskId);

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
              return cancelPrintJobResponseSchema.parse({
                printJob: await this.replayJob(transaction, replay.resourceId, owned.sessionId)
              });
            }

            const printJob = await transaction.printJob.findUniqueOrThrow({
              where: { id: owned.id }
            });
            if (printJob.status === "COMPLETED") {
              throw new ApiError(
                409,
                "PRINT_ALREADY_COMPLETED",
                "This print job has already finished."
              );
            }

            if (!OPEN_STATUSES.includes(printJob.status)) {
              return cancelPrintJobResponseSchema.parse({
                printJob: toPrintJobSnapshot(printJob)
              });
            }

            // Holding a command while artifacts are prepared is not evidence
            // that a device saw it. Only an accepted submission/progress report
            // moves the job to PRINTING and crosses the ambiguous-output boundary.
            const submitted = printJob.status === "PRINTING";

            if (submitted) {
              // The device already has the work. Recording the request is all
              // that can honestly be done; the result decides the rest.
              await transaction.printJob.updateMany({
                where: { id: printJob.id, status: printJob.status },
                data: { cancelRequestedAt: now, updatedAt: now }
              });
              await recordPrintJobEvent(transaction, {
                id: this.options.random.uuid(now),
                printJobId: printJob.id,
                type: "CANCEL_REQUESTED",
                status: printJob.status,
                now
              });
            } else {
              const settlement = settlePrintDeviceResult({
                state: "CANCELED",
                confidence: "CONFIRMED",
                failureCode: "CANCELED_BY_CUSTOMER",
                warningCode: null,
                sheetsProduced: 0
              });
              await applyPrintJobSettlement(transaction, {
                printJobId: printJob.id,
                ...settlement,
                operationId: null,
                ledgerType: "CANCELED",
                actorType: "KIOSK",
                actorId: input.credentialId,
                requestId: input.requestId,
                now,
                newId: () => this.options.random.uuid(now)
              });
            }

            const current = await transaction.printJob.findUniqueOrThrow({
              where: { id: printJob.id }
            });
            const response = cancelPrintJobResponseSchema.parse({
              printJob: toPrintJobSnapshot(current)
            });

            await this.storeReplay(transaction, {
              actorId: input.kioskId,
              action,
              idempotencyKey: input.idempotencyKey,
              requestHash,
              responseStatus: 200,
              response,
              resourceId: current.id,
              now
            });

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw mapPrintJobError(error);
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The session changed concurrently. Please retry."
    );
  }

  /**
   * Freeze the exact print-ready artifacts this job will send to the device.
   *
   * The manifest names object digests, not object keys: the agent asks the
   * control plane for a document by identity and never learns where the bytes
   * live. A selection whose normalized PDF is missing stops the job here rather
   * than at the device, where a customer would already be waiting.
   */
  private async resolveDocuments(
    transaction: Prisma.TransactionClient,
    sessionId: string,
    settings: { selections: unknown }
  ) {
    const selections = readSelections(settings.selections);
    if (selections.length === 0) {
      throw new ApiError(409, "PRINT_SETTINGS_UNAVAILABLE", "There is nothing to print.");
    }

    const documents = [];
    for (const selection of selections) {
      const file = await transaction.uploadedFile.findFirst({
        where: {
          id: selection.fileId,
          sessionId,
          status: "READY",
          processingRevision: selection.processingRevision
        },
        select: { id: true, contentSha256: true, pageCount: true }
      });
      const derivative = file
        ? await transaction.fileDerivative.findFirst({
            where: {
              fileId: file.id,
              processingRevision: selection.processingRevision,
              type: "NORMALIZED_PDF",
              status: "AVAILABLE"
            },
            select: { sha256: true, sizeBytes: true, mimeType: true }
          })
        : null;

      // The document must still be exactly the one that was priced and paid
      // for. A reprocessed or replaced file is a different document.
      if (
        !file ||
        !derivative ||
        file.contentSha256 !== selection.contentSha256 ||
        file.pageCount !== selection.pageCount ||
        derivative.mimeType !== "application/pdf" ||
        derivative.sizeBytes < 1
      ) {
        throw new ApiError(
          409,
          "PRINT_ARTIFACT_UNAVAILABLE",
          "The print-ready document is no longer available."
        );
      }

      documents.push({
        documentId: file.id,
        position: selection.position,
        sha256: derivative.sha256,
        sizeBytes: derivative.sizeBytes,
        pageCount: selection.pageCount,
        pageRanges: selection.pageRanges,
        selectedPages: selection.selectedPages
      });
    }

    return documents.sort((left, right) => left.position - right.position);
  }

  private async startPrinting(
    transaction: Prisma.TransactionClient,
    session: { id: string; state: string; stateVersion: number; eventSequence: number },
    printJobId: string,
    now: Date
  ): Promise<number> {
    // Already printing: an earlier attempt moved the session and then lost its
    // transaction. The event was written with it, so nothing is emitted twice.
    if (session.state === "PRINTING") return session.eventSequence;

    const next = transitionSession(
      { state: session.state as SessionState, version: session.stateVersion },
      "PRINTING",
      session.stateVersion
    );
    const nextSequence = session.eventSequence + 1;
    const moved = await transaction.printSession.updateMany({
      where: { id: session.id, stateVersion: session.stateVersion },
      data: {
        state: next.state,
        stateVersion: next.version,
        eventSequence: nextSequence,
        updatedAt: now
      }
    });
    if (moved.count !== 1) {
      throw new ApiError(
        409,
        "CONCURRENT_SESSION_UPDATE",
        "The session changed concurrently. Please retry."
      );
    }

    await transaction.outboxEvent.create({
      data: {
        id: this.options.random.uuid(now),
        aggregateType: "PRINT_SESSION",
        aggregateId: session.id,
        sequence: nextSequence,
        type: "print.started",
        payload: {
          sessionId: session.id,
          state: next.state,
          version: next.version,
          printJobId
        }
      }
    });

    return nextSequence;
  }

  private async replayJob(
    transaction: Prisma.TransactionClient,
    resourceId: string | null,
    sessionId: string
  ): Promise<PrintJobSnapshot> {
    const printJob = resourceId
      ? await transaction.printJob.findFirst({ where: { id: resourceId, sessionId } })
      : null;
    if (!printJob) {
      throw new ApiError(
        409,
        "PRINT_JOB_REPLAY_UNAVAILABLE",
        "The previous print job is no longer available."
      );
    }
    return toPrintJobSnapshot(printJob);
  }

  private async storeReplay(
    transaction: Prisma.TransactionClient,
    input: {
      actorId: string;
      action: string;
      idempotencyKey: string;
      requestHash: string;
      responseStatus: number;
      response: CreatePrintJobResponse | CancelPrintJobResponse;
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
        responseStatus: input.responseStatus,
        responseBody: input.response,
        resourceId: input.resourceId,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + this.options.idempotencyTtlHours * 3_600_000)
      }
    });
  }
}

interface StoredPrintJob {
  id: string;
  sessionId: string;
  quoteId: string;
  paymentId: string;
  settingsRevision: number;
  status: string;
  resultConfidence: string;
  failureCode: string | null;
  warningCode: string | null;
  copies: number;
  printedSides: number;
  physicalSheets: number;
  sheetsProduced: number | null;
  createdAt: Date;
  deadlineAt: Date;
  completedAt: Date | null;
}

export function toPrintJobSnapshot(printJob: StoredPrintJob): PrintJobSnapshot {
  const failureCode = printFailureCodeSchema.safeParse(printJob.failureCode);
  const warningCode = printWarningCodeSchema.safeParse(printJob.warningCode);
  const confidence = printResultConfidenceSchema.safeParse(printJob.resultConfidence);
  return printJobSnapshotSchema.parse({
    id: printJob.id,
    sessionId: printJob.sessionId,
    quoteId: printJob.quoteId,
    paymentId: printJob.paymentId,
    settingsRevision: printJob.settingsRevision,
    status: printJob.status,
    resultConfidence: confidence.success ? confidence.data : "UNKNOWN",
    failureCode: failureCode.success ? failureCode.data : null,
    warningCode: warningCode.success ? warningCode.data : null,
    copies: printJob.copies,
    printedSides: printJob.printedSides,
    physicalSheets: printJob.physicalSheets,
    sheetsProduced: printJob.sheetsProduced,
    createdAt: printJob.createdAt.toISOString(),
    deadlineAt: printJob.deadlineAt.toISOString(),
    completedAt: printJob.completedAt?.toISOString() ?? null
  });
}

/** sha256 over the canonical manifest string; the device is given this hash. */
export function hashPrintManifest(manifest: PrintJobManifestContract): string {
  return createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new ApiError(500, "PRINT_MANIFEST_INVALID", "The print manifest could not be built.");
}

/**
 * Read the stored settings selections defensively. They were written by this
 * system, but a JSON column is still untyped storage and the manifest built
 * from it decides what a device prints.
 */
function readSelections(value: unknown): StoredSelection[] {
  if (!Array.isArray(value)) return [];
  const selections: StoredSelection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const pageRanges: Array<[number, number]> = Array.isArray(record.pageRanges)
      ? record.pageRanges.flatMap((range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          Number.isSafeInteger(range[0]) &&
          Number.isSafeInteger(range[1])
            ? [[range[0] as number, range[1] as number]]
            : []
        )
      : [];
    if (
      typeof record.fileId !== "string" ||
      !Number.isSafeInteger(record.position) ||
      !Number.isSafeInteger(record.pageCount) ||
      !Number.isSafeInteger(record.processingRevision) ||
      typeof record.contentSha256 !== "string" ||
      !Number.isSafeInteger(record.selectedPages) ||
      pageRanges.length === 0
    ) {
      return [];
    }
    selections.push({
      fileId: record.fileId,
      position: record.position as number,
      pageCount: record.pageCount as number,
      processingRevision: record.processingRevision as number,
      contentSha256: record.contentSha256,
      pageRanges,
      selectedPages: record.selectedPages as number
    });
  }
  return selections;
}

function assertSessionPrintable(state: SessionState): void {
  if (state === "PAID" || state === "PRINTING") return;
  if (state === "COMPLETED" || state === "FAILED" || state === "RECOVERY_REQUIRED") {
    throw new ApiError(409, "PRINT_SESSION_SETTLED", "This session has already finished.", {
      currentState: state
    });
  }
  if (state === "EXPIRED" || state === "CANCELED") {
    throw new ApiError(410, "SESSION_EXPIRED", "This session has ended.");
  }
  throw new ApiError(409, "PRINT_PAYMENT_REQUIRED", "This session has not been paid.", {
    currentState: state
  });
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

function printJobNotFound(): ApiError {
  return new ApiError(404, "PRINT_JOB_NOT_FOUND", "Print job not found.");
}

function mapPrintJobError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof SessionDomainError) {
    return new ApiError(409, error.code, "This session transition is not allowed.", error.details);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    return new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
  }
  // The one-job-per-session index lost a race with a concurrent create. The
  // other request's job is the session's job.
  if (isUniqueConstraintError(error)) {
    return new ApiError(409, "PRINT_JOB_EXISTS", "This session already has a print job.");
  }
  return error;
}
