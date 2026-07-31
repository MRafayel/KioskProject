import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

import { Queue, Worker, type Job } from "bullmq";

import { redisConnectionOptions } from "@printing-kiosk/config";
import {
  DOCUMENT_PROCESSING_QUEUE_NAME,
  documentProcessingJobSchema,
  readyUploadedFileSnapshotSchema,
  type DocumentProcessingJob,
  type UploadedFileRejectionCode
} from "@printing-kiosk/contracts";
import { invalidateSessionPricing, Prisma, type PrismaClient } from "@printing-kiosk/database";
import { canTransitionSession, type SessionState } from "@printing-kiosk/domain";

import type { DocumentStore } from "../storage/document-store.js";
import {
  ProcessorRequestError,
  type DocumentProcessorClient,
  type ProcessorArtifact,
  type ProcessorBundle
} from "../processing/processor-client.js";

const DEFAULT_DISPATCH_INTERVAL_MS = 500;
const ENQUEUE_STALE_AFTER_MS = 30_000;
const MAX_DISPATCH_BATCH = 25;
/**
 * A document may finish validating while the customer is still adding files or
 * already choosing settings. Anything further along has locked a manifest, so a
 * late arrival there is a lost lease rather than a new printable document.
 */
const ACCEPTS_READY_FILE_STATES: SessionState[] = [
  "WAITING_FOR_UPLOAD",
  "FILES_UPLOADED",
  "CONFIGURING"
];

export interface DocumentProcessingLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DocumentProcessingCoordinatorOptions {
  database: PrismaClient;
  redisUrl: string;
  store: DocumentStore;
  processor: DocumentProcessorClient;
  logger: DocumentProcessingLogger;
  concurrency: number;
  leaseMilliseconds: number;
  maximumAttempts: number;
  dispatchIntervalMilliseconds?: number;
}

interface ClaimedFile {
  id: string;
  sessionId: string;
  kioskId: string;
  generation: number;
  processingRevision: number;
  processingAttempts: number;
  claimToken: string;
  kind: "PDF" | "JPEG" | "PNG";
  sizeBytes: number;
  contentSha256: string;
  quarantineObjectKey: string;
}

interface PlannedArtifact {
  id: string;
  objectKey: string;
  type: "ORIGINAL" | "NORMALIZED_PDF" | "PAGE_PREVIEW";
  pageNumber: number;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  source?: ProcessorArtifact;
  sizeBytes: number;
  sha256: string;
  widthPixels?: number;
  heightPixels?: number;
}

export class DocumentProcessingCoordinator {
  private readonly queue: Queue<DocumentProcessingJob>;
  private readonly worker: Worker<DocumentProcessingJob>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private dispatching = false;

  public constructor(private readonly options: DocumentProcessingCoordinatorOptions) {
    const connection = redisConnectionOptions(options.redisUrl);
    this.queue = new Queue<DocumentProcessingJob>(DOCUMENT_PROCESSING_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 }
      }
    });
    this.worker = new Worker<DocumentProcessingJob>(
      DOCUMENT_PROCESSING_QUEUE_NAME,
      (job) => this.processJob(job),
      {
        connection,
        concurrency: options.concurrency,
        autorun: false,
        lockDuration: Math.max(30_000, options.leaseMilliseconds),
        maxStalledCount: 1
      }
    );
    this.worker.on("failed", (job, error) => {
      options.logger.error(
        {
          jobId: job?.id,
          fileId: job?.data.fileId,
          errorCode: safeErrorCode(error)
        },
        "document queue job failed"
      );
    });
    this.worker.on("error", (error) => {
      options.logger.error(safeError(error), "document queue worker error");
    });
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.worker.run().catch((error) => {
      if (!this.stopped) this.options.logger.error(safeError(error), "document worker stopped");
    });
    this.schedule(0);
  }

  public async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.all([this.worker.close(), this.queue.close()]);
  }

  /**
   * Public for deterministic integration tests. The queue remains a wake-up
   * mechanism: a generation-guarded database row is authoritative.
   */
  public async dispatchOnce(): Promise<number> {
    if (this.dispatching) return 0;
    this.dispatching = true;
    try {
      await this.recoverOneStaleClaim();
      let dispatched = 0;
      while (dispatched < MAX_DISPATCH_BATCH) {
        const job = await this.reserveNextJob();
        if (!job) break;
        try {
          await this.queue.add("validate-document", job, {
            jobId: `${job.fileId.replaceAll("-", "")}-g${job.generation}`
          });
          dispatched += 1;
        } catch (error) {
          await this.options.database.uploadedFile.updateMany({
            where: {
              id: job.fileId,
              status: "QUARANTINED",
              processingGeneration: job.generation
            },
            data: {
              processingEnqueuedAt: null,
              processingErrorCode: safeErrorCode(error)
            }
          });
          throw error;
        }
      }
      return dispatched;
    } finally {
      this.dispatching = false;
    }
  }

  private schedule(delayMilliseconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMilliseconds);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const dispatched = await this.dispatchOnce();
      this.schedule(dispatched > 0 ? 0 : this.dispatchInterval);
    } catch (error) {
      this.options.logger.error(safeError(error), "document dispatcher tick failed");
      this.schedule(this.dispatchInterval);
    }
  }

  private get dispatchInterval(): number {
    return this.options.dispatchIntervalMilliseconds ?? DEFAULT_DISPATCH_INTERVAL_MS;
  }

  private async reserveNextJob(): Promise<DocumentProcessingJob | null> {
    const now = new Date();
    const staleEnqueue = new Date(now.getTime() - ENQUEUE_STALE_AFTER_MS);
    const candidate = await this.options.database.uploadedFile.findFirst({
      where: {
        status: "QUARANTINED",
        processingAvailableAt: { lte: now },
        OR: [{ processingEnqueuedAt: null }, { processingEnqueuedAt: { lte: staleEnqueue } }]
      },
      orderBy: [{ processingAvailableAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, processingGeneration: true, processingEnqueuedAt: true }
    });
    if (!candidate) return null;

    const generation = candidate.processingGeneration + 1;
    const reserved = await this.options.database.uploadedFile.updateMany({
      where: {
        id: candidate.id,
        status: "QUARANTINED",
        processingGeneration: candidate.processingGeneration,
        processingEnqueuedAt: candidate.processingEnqueuedAt
      },
      data: {
        processingGeneration: generation,
        processingEnqueuedAt: now,
        processingErrorCode: null
      }
    });
    return reserved.count === 1
      ? documentProcessingJobSchema.parse({ fileId: candidate.id, generation })
      : null;
  }

  private async processJob(job: Job<DocumentProcessingJob>): Promise<void> {
    const parsed = documentProcessingJobSchema.parse(job.data);
    const claimed = await this.claim(parsed);
    if (!claimed) return;

    const lease = this.startLeaseHeartbeat(claimed);
    let bundle: ProcessorBundle | undefined;
    try {
      const source = await this.options.store.getQuarantined(
        claimed.quarantineObjectKey,
        lease.signal
      );
      if (source.contentLength !== claimed.sizeBytes) {
        throw new ProcessorRequestError("SOURCE_INTEGRITY_FAILED", false);
      }
      bundle = await this.options.processor.process({
        body: source.body,
        contentLength: claimed.sizeBytes,
        contentSha256: claimed.contentSha256,
        kind: claimed.kind,
        signal: lease.signal
      });
      if (bundle.manifest.kind !== claimed.kind) {
        throw new ProcessorRequestError("SOURCE_INTEGRITY_FAILED", false);
      }

      const artifacts = await this.planArtifacts(claimed, bundle);
      await this.uploadArtifacts(claimed, artifacts, lease.signal);
      await this.complete(claimed, bundle, artifacts);
      this.options.logger.info(
        {
          fileId: claimed.id,
          sessionId: claimed.sessionId,
          generation: claimed.generation,
          pageCount: bundle.manifest.pageCount
        },
        "document processing completed"
      );
    } catch (error) {
      await this.handleFailure(claimed, error, lease.signal);
    } finally {
      lease.stop();
      await bundle?.cleanup().catch(() => undefined);
    }
  }

  private async claim(job: DocumentProcessingJob): Promise<ClaimedFile | null> {
    return this.options.database.$transaction(
      async (transaction) => {
        const candidate = await transaction.uploadedFile.findUnique({
          where: { id: job.fileId },
          select: { sessionId: true }
        });
        if (!candidate) return null;
        await lockSession(transaction, candidate.sessionId);
        const file = await transaction.uploadedFile.findUnique({
          where: { id: job.fileId },
          include: { session: true }
        });
        if (
          !file ||
          file.status !== "QUARANTINED" ||
          file.processingGeneration !== job.generation
        ) {
          return null;
        }

        const now = new Date();
        if (
          file.session.state !== "WAITING_FOR_UPLOAD" ||
          now.getTime() >= file.session.idleExpiresAt.getTime() ||
          now.getTime() >= file.session.hardExpiresAt.getTime()
        ) {
          await transaction.uploadedFile.update({
            where: { id: file.id },
            data: {
              status: "DELETE_PENDING",
              deleteRequestedAt: now,
              cleanupDueAt: now,
              processingEnqueuedAt: null,
              processingClaimToken: null,
              processingLeaseExpiresAt: null,
              processingErrorCode: null,
              updatedAt: now
            }
          });
          return null;
        }
        if (
          !isKind(file.kind) ||
          !file.sizeBytes ||
          !file.contentSha256 ||
          !file.quarantineObjectKey
        ) {
          await transaction.uploadedFile.update({
            where: { id: file.id },
            data: {
              status: "DELETE_PENDING",
              rejectionCode: "PROCESSING_FAILED",
              cleanupDueAt: now,
              processingEnqueuedAt: null,
              processingErrorCode: "PROCESSING_METADATA_INVALID",
              updatedAt: now
            }
          });
          return null;
        }

        const claimToken = randomUUID();
        const claimed = await transaction.uploadedFile.updateMany({
          where: {
            id: file.id,
            status: "QUARANTINED",
            processingGeneration: job.generation
          },
          data: {
            status: "VALIDATING",
            processingAttempts: { increment: 1 },
            processingEnqueuedAt: null,
            processingClaimToken: claimToken,
            processingLeaseExpiresAt: new Date(now.getTime() + this.options.leaseMilliseconds),
            processingStartedAt: now,
            processingErrorCode: null,
            malwareScanStatus: "PENDING",
            updatedAt: now
          }
        });
        if (claimed.count !== 1) return null;
        return {
          id: file.id,
          sessionId: file.sessionId,
          kioskId: file.session.kioskId,
          generation: job.generation,
          processingRevision: file.processingRevision,
          processingAttempts: file.processingAttempts + 1,
          claimToken,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
          contentSha256: file.contentSha256,
          quarantineObjectKey: file.quarantineObjectKey
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private startLeaseHeartbeat(claimed: ClaimedFile): {
    signal: AbortSignal;
    stop(): void;
  } {
    const controller = new AbortController();
    const intervalMilliseconds = Math.max(
      1_000,
      Math.min(15_000, Math.floor(this.options.leaseMilliseconds / 3))
    );
    let active = false;
    const timer = setInterval(() => {
      if (active || controller.signal.aborted) return;
      active = true;
      const now = new Date();
      void this.options.database.uploadedFile
        .updateMany({
          where: {
            id: claimed.id,
            status: "VALIDATING",
            processingGeneration: claimed.generation,
            processingClaimToken: claimed.claimToken,
            processingLeaseExpiresAt: { gt: now }
          },
          data: {
            processingLeaseExpiresAt: new Date(now.getTime() + this.options.leaseMilliseconds)
          }
        })
        .then((result) => {
          if (result.count !== 1) controller.abort(new Error("PROCESSING_LEASE_LOST"));
        })
        .catch(() => controller.abort(new Error("PROCESSING_LEASE_RENEWAL_FAILED")))
        .finally(() => {
          active = false;
        });
    }, intervalMilliseconds);
    timer.unref?.();
    return {
      signal: controller.signal,
      stop: () => {
        clearInterval(timer);
        if (!controller.signal.aborted) controller.abort(new Error("PROCESSING_FINISHED"));
      }
    };
  }

  private async planArtifacts(
    claimed: ClaimedFile,
    bundle: ProcessorBundle
  ): Promise<PlannedArtifact[]> {
    const prefix = `${claimed.sessionId}/${claimed.id}/r${claimed.processingRevision}/g${claimed.generation}`;
    const artifacts: PlannedArtifact[] = [
      {
        id: randomUUID(),
        objectKey: claimed.quarantineObjectKey,
        type: "ORIGINAL",
        pageNumber: 0,
        mimeType: mimeForKind(claimed.kind),
        sizeBytes: claimed.sizeBytes,
        sha256: claimed.contentSha256
      },
      {
        id: randomUUID(),
        objectKey: `normalized/v1/${prefix}/document.pdf`,
        type: "NORMALIZED_PDF",
        pageNumber: 0,
        mimeType: "application/pdf",
        source: bundle.normalized,
        sizeBytes: bundle.normalized.sizeBytes,
        sha256: bundle.normalized.sha256
      },
      ...bundle.pages.map((page) => ({
        id: randomUUID(),
        objectKey: `previews/v1/${prefix}/page-${page.pageNumber}.webp`,
        type: "PAGE_PREVIEW" as const,
        pageNumber: page.pageNumber,
        mimeType: "image/webp" as const,
        source: page.preview,
        sizeBytes: page.preview.sizeBytes,
        sha256: page.preview.sha256,
        widthPixels: page.widthPixels,
        heightPixels: page.heightPixels
      }))
    ];

    await this.options.database.$transaction(async (transaction) => {
      await lockSession(transaction, claimed.sessionId);
      await assertLiveClaim(transaction, claimed);
      await transaction.fileDerivative.createMany({
        data: artifacts.map((artifact) => ({
          id: artifact.id,
          fileId: claimed.id,
          processingRevision: claimed.processingRevision,
          type: artifact.type,
          status: artifact.type === "ORIGINAL" ? "AVAILABLE" : "STAGING",
          pageNumber: artifact.pageNumber,
          objectKey: artifact.objectKey,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          widthPixels: artifact.widthPixels ?? null,
          heightPixels: artifact.heightPixels ?? null
        }))
      });
    });
    return artifacts;
  }

  private async uploadArtifacts(
    claimed: ClaimedFile,
    artifacts: PlannedArtifact[],
    signal: AbortSignal
  ): Promise<void> {
    for (const artifact of artifacts.filter((candidate) => candidate.type !== "ORIGINAL")) {
      if (!artifact.source) throw new ProcessorRequestError("ARTIFACT_LEDGER_INCOMPLETE", true);
      signal.throwIfAborted();
      if (!(await this.hasLiveClaim(claimed))) throw new LeaseLostError();
      await this.options.store.putArtifact({
        key: artifact.objectKey,
        body: createReadStream(artifact.source.temporaryPath, { signal }),
        contentLength: artifact.source.sizeBytes,
        contentType: artifact.mimeType as "application/pdf" | "image/webp",
        signal
      });
      if (!(await this.hasLiveClaim(claimed))) {
        await this.compensateInvalidatedArtifact(claimed, artifact);
        throw new LeaseLostError();
      }
      const stored = await this.options.database.fileDerivative.updateMany({
        where: {
          id: artifact.id,
          fileId: claimed.id,
          processingRevision: claimed.processingRevision,
          status: "STAGING"
        },
        data: { status: "AVAILABLE" }
      });
      if (stored.count !== 1) {
        await this.compensateInvalidatedArtifact(claimed, artifact);
        throw new LeaseLostError();
      }
    }
  }

  /**
   * A claim can be revoked while S3 is completing an upload. Keep a durable
   * cleanup marker if the compensating delete fails; cancellation/recovery must
   * never lose the only record containing the newly written object key.
   */
  private async compensateInvalidatedArtifact(
    claimed: ClaimedFile,
    artifact: PlannedArtifact
  ): Promise<void> {
    try {
      await this.options.store.deleteObject(artifact.objectKey);
    } catch {
      await this.options.database.fileDerivative.updateMany({
        where: {
          id: artifact.id,
          fileId: claimed.id,
          objectKey: artifact.objectKey
        },
        data: {
          status: "DELETE_PENDING",
          deletedAt: null
        }
      });
      throw new ProcessorRequestError("DERIVATIVE_CLEANUP_FAILED", true);
    }
  }

  private async complete(
    claimed: ClaimedFile,
    bundle: ProcessorBundle,
    artifacts: PlannedArtifact[]
  ): Promise<void> {
    await this.options.database.$transaction(
      async (transaction) => {
        await lockSession(transaction, claimed.sessionId);
        const file = await assertLiveClaim(transaction, claimed);
        const session = await transaction.printSession.findUniqueOrThrow({
          where: { id: claimed.sessionId }
        });
        const now = new Date();
        if (
          !ACCEPTS_READY_FILE_STATES.includes(session.state as SessionState) ||
          now.getTime() >= session.idleExpiresAt.getTime() ||
          now.getTime() >= session.hardExpiresAt.getTime()
        ) {
          throw new LeaseLostError();
        }
        const stored = await transaction.fileDerivative.count({
          where: {
            id: { in: artifacts.map((artifact) => artifact.id) },
            fileId: claimed.id,
            processingRevision: claimed.processingRevision,
            status: "AVAILABLE"
          }
        });
        if (stored !== artifacts.length) {
          throw new ProcessorRequestError("ARTIFACT_LEDGER_INCOMPLETE", true);
        }

        const previewByPage = new Map(
          artifacts
            .filter((artifact) => artifact.type === "PAGE_PREVIEW")
            .map((artifact) => [artifact.pageNumber, artifact])
        );
        await transaction.filePage.createMany({
          data: bundle.pages.map((page) => {
            const preview = previewByPage.get(page.pageNumber);
            if (!preview) throw new ProcessorRequestError("ARTIFACT_LEDGER_INCOMPLETE", true);
            return {
              id: randomUUID(),
              fileId: claimed.id,
              processingRevision: claimed.processingRevision,
              pageNumber: page.pageNumber,
              widthPixels: page.widthPixels,
              heightPixels: page.heightPixels,
              previewDerivativeId: preview.id
            };
          })
        });

        const updated = await transaction.uploadedFile.updateMany({
          where: {
            id: claimed.id,
            status: "VALIDATING",
            processingGeneration: claimed.generation,
            processingClaimToken: claimed.claimToken,
            processingLeaseExpiresAt: { gt: now }
          },
          data: {
            status: "READY",
            pageCount: bundle.manifest.pageCount,
            malwareScanStatus: "CLEAN",
            rejectionCode: null,
            processingClaimToken: null,
            processingLeaseExpiresAt: null,
            processingErrorCode: null,
            readyAt: now,
            updatedAt: now
          }
        });
        if (updated.count !== 1) throw new LeaseLostError();

        const ready = await transaction.uploadedFile.findUniqueOrThrow({
          where: { id: claimed.id }
        });
        const fileSnapshot = readyUploadedFileSnapshotSchema.parse({
          id: ready.id,
          ordinal: ready.ordinal,
          status: ready.status,
          kind: ready.kind,
          sizeBytes: ready.sizeBytes,
          pageCount: ready.pageCount,
          processingRevision: ready.processingRevision,
          rejectionCode: ready.rejectionCode,
          createdAt: ready.createdAt.toISOString()
        });
        // A newly printable document changes the material any saved settings
        // and any live price described, so both are retired here. The customer
        // returns to the document list and configures the new set explicitly.
        const invalidation = await invalidateSessionPricing(transaction, {
          sessionId: session.id,
          reason: "DOCUMENTS_CHANGED",
          now,
          startingSequence: session.eventSequence,
          newEventId: () => randomUUID(),
          clearSettingsRevision: true
        });

        const currentState = session.state as SessionState;
        const readyState: SessionState = "FILES_UPLOADED";
        const stateChanged = currentState !== readyState;
        if (stateChanged && !canTransitionSession(currentState, readyState)) {
          throw new LeaseLostError();
        }

        const nextSequence = invalidation.nextSequence + 1;
        await Promise.all([
          transaction.printSession.update({
            where: { id: session.id },
            data: {
              ...(stateChanged
                ? { state: readyState, stateVersion: session.stateVersion + 1 }
                : {}),
              eventSequence: nextSequence,
              updatedAt: now
            }
          }),
          transaction.auditEvent.create({
            data: {
              id: randomUUID(),
              occurredAt: now,
              actorType: "SYSTEM",
              actorId: "document-processor-worker",
              kioskId: claimed.kioskId,
              sessionId: claimed.sessionId,
              action: "file.ready",
              outcome: "SUCCESS",
              metadata: {
                fileId: claimed.id,
                processingRevision: claimed.processingRevision,
                pageCount: bundle.manifest.pageCount,
                sessionState: stateChanged ? readyState : currentState
              }
            }
          }),
          transaction.outboxEvent.create({
            data: {
              id: randomUUID(),
              aggregateType: "PRINT_SESSION",
              aggregateId: session.id,
              sequence: nextSequence,
              type: "file.ready",
              payload: { sessionId: session.id, file: fileSnapshot }
            }
          })
        ]);
        void file;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private async handleFailure(
    claimed: ClaimedFile,
    error: unknown,
    signal?: AbortSignal
  ): Promise<void> {
    const live = await this.hasLiveClaim(claimed);
    if (!live) {
      // A replacement owner may already be cleaning this generation or
      // staging the next one. The stale owner must not perform broad,
      // revision-scoped cleanup because that could delete the replacement
      // owner's artifact ledger. Uploads independently remove the exact
      // object they wrote when their post-upload claim check fails; the
      // authoritative recovery owner handles any remaining ledger cleanup.
      this.options.logger.warn(
        { fileId: claimed.id, generation: claimed.generation },
        "document processing lease was lost"
      );
      return;
    }

    const processorError =
      error instanceof ProcessorRequestError
        ? error
        : new ProcessorRequestError(safeErrorCode(error), true);
    // The processor's retryable flag is advisory, not authorization to delete
    // a customer's original. Only an explicit, stable content-validation code
    // may terminally reject a file. Authentication, protocol, configuration,
    // storage, capacity, scanner, and other operational failures are retried
    // even if a faulty processor labels them non-retryable.
    const rejectionCode = processorError.retryable
      ? undefined
      : terminalContentRejectionCode(processorError.code);
    const malwareScanStatus =
      processorError.code === "MALWARE_DETECTED"
        ? "INFECTED"
        : processorError.code.startsWith("MALWARE_SCANNER_")
          ? "ERROR"
          : undefined;
    const attemptBudgetExceeded = claimed.processingAttempts >= this.options.maximumAttempts;
    const terminal = rejectionCode !== undefined || attemptBudgetExceeded;
    if (terminal) {
      await this.options.database.uploadedFile.updateMany({
        where: {
          id: claimed.id,
          status: "VALIDATING",
          processingGeneration: claimed.generation,
          processingClaimToken: claimed.claimToken,
          processingLeaseExpiresAt: { gt: new Date() }
        },
        data: {
          status: "DELETE_PENDING",
          rejectionCode: rejectionCode ?? budgetExhaustedRejectionCode(processorError.code),
          cleanupDueAt: new Date(),
          processingClaimToken: null,
          processingLeaseExpiresAt: null,
          processingErrorCode: processorError.code,
          ...(malwareScanStatus ? { malwareScanStatus } : {}),
          updatedAt: new Date()
        }
      });
    } else {
      const cleaned = await this.cleanupArtifacts(claimed, signal);
      if (cleaned) {
        const retryAt = new Date(
          Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(claimed.processingAttempts - 1, 6))
        );
        await this.options.database.uploadedFile.updateMany({
          where: {
            id: claimed.id,
            status: "VALIDATING",
            processingGeneration: claimed.generation,
            processingClaimToken: claimed.claimToken,
            processingLeaseExpiresAt: { gt: new Date() }
          },
          data: {
            status: "QUARANTINED",
            processingAvailableAt: retryAt,
            processingEnqueuedAt: null,
            processingClaimToken: null,
            processingLeaseExpiresAt: null,
            processingStartedAt: null,
            processingErrorCode: processorError.code,
            ...(malwareScanStatus ? { malwareScanStatus } : {}),
            updatedAt: new Date()
          }
        });
      } else {
        await this.failCleanup(claimed, "DERIVATIVE_CLEANUP_FAILED");
      }
    }
    this.options.logger.warn(
      {
        fileId: claimed.id,
        generation: claimed.generation,
        attempt: claimed.processingAttempts,
        errorCode: processorError.code,
        terminal,
        attemptBudgetExceeded
      },
      "document processing failed"
    );
  }

  private async cleanupArtifacts(claimed: ClaimedFile, signal?: AbortSignal): Promise<boolean> {
    const derivatives = await this.options.database.fileDerivative.findMany({
      where: { fileId: claimed.id, processingRevision: claimed.processingRevision },
      select: { id: true, objectKey: true, type: true }
    });
    let failed = false;
    for (const derivative of derivatives) {
      if (derivative.type === "ORIGINAL") continue;
      signal?.throwIfAborted();
      if (!derivative.objectKey) {
        failed = true;
        continue;
      }
      try {
        await this.options.store.deleteObject(derivative.objectKey, signal);
      } catch {
        if (signal?.aborted) throw new LeaseLostError();
        failed = true;
      }
    }
    if (failed) return false;
    signal?.throwIfAborted();

    const derivativeIds = derivatives.map((derivative) => derivative.id);
    await this.options.database.$transaction(async (transaction) => {
      await lockSession(transaction, claimed.sessionId);
      await assertLiveClaim(transaction, claimed);
      if (derivativeIds.length === 0) return;
      await transaction.filePage.deleteMany({
        where: { previewDerivativeId: { in: derivativeIds } }
      });
      await transaction.fileDerivative.deleteMany({
        where: { id: { in: derivativeIds }, fileId: claimed.id }
      });
    });
    return true;
  }

  private async failCleanup(claimed: ClaimedFile, code: string): Promise<void> {
    await this.options.database.uploadedFile.updateMany({
      where: {
        id: claimed.id,
        status: "VALIDATING",
        processingGeneration: claimed.generation,
        processingClaimToken: claimed.claimToken,
        processingLeaseExpiresAt: { gt: new Date() }
      },
      data: {
        status: "DELETE_PENDING",
        rejectionCode: "PROCESSING_FAILED",
        cleanupDueAt: new Date(),
        cleanupErrorCode: code,
        processingClaimToken: null,
        processingLeaseExpiresAt: null,
        processingErrorCode: code,
        updatedAt: new Date()
      }
    });
  }

  private async hasLiveClaim(claimed: ClaimedFile): Promise<boolean> {
    const file = await this.options.database.uploadedFile.findFirst({
      where: {
        id: claimed.id,
        status: "VALIDATING",
        processingGeneration: claimed.generation,
        processingClaimToken: claimed.claimToken,
        processingLeaseExpiresAt: { gt: new Date() }
      },
      select: { id: true }
    });
    return Boolean(file);
  }

  private async recoverOneStaleClaim(): Promise<void> {
    const now = new Date();
    const candidate = await this.options.database.uploadedFile.findFirst({
      where: {
        status: "VALIDATING",
        processingClaimToken: { not: null },
        processingLeaseExpiresAt: { lte: now }
      },
      orderBy: { processingLeaseExpiresAt: "asc" }
    });
    if (!candidate?.processingClaimToken) return;

    const recoveryToken = randomUUID();
    const claimed = await this.options.database.uploadedFile.updateMany({
      where: {
        id: candidate.id,
        status: "VALIDATING",
        processingClaimToken: candidate.processingClaimToken,
        processingLeaseExpiresAt: candidate.processingLeaseExpiresAt
      },
      data: {
        processingClaimToken: recoveryToken,
        processingLeaseExpiresAt: new Date(now.getTime() + this.options.leaseMilliseconds),
        updatedAt: now
      }
    });
    if (claimed.count !== 1) return;
    const recovered: ClaimedFile = {
      id: candidate.id,
      sessionId: candidate.sessionId,
      kioskId: "",
      generation: candidate.processingGeneration,
      processingRevision: candidate.processingRevision,
      processingAttempts: candidate.processingAttempts,
      claimToken: recoveryToken,
      kind: isKind(candidate.kind) ? candidate.kind : "PDF",
      sizeBytes: candidate.sizeBytes ?? 0,
      contentSha256: candidate.contentSha256 ?? "",
      quarantineObjectKey: candidate.quarantineObjectKey ?? ""
    };
    const lease = this.startLeaseHeartbeat(recovered);
    try {
      const cleaned = await this.cleanupArtifacts(recovered, lease.signal);
      if (!(await this.hasLiveClaim(recovered))) return;
      if (!cleaned || candidate.processingAttempts >= this.options.maximumAttempts) {
        await this.failCleanup(
          recovered,
          cleaned ? "PROCESSING_MAX_ATTEMPTS_REACHED" : "DERIVATIVE_CLEANUP_FAILED"
        );
        return;
      }
      await this.options.database.uploadedFile.updateMany({
        where: {
          id: candidate.id,
          status: "VALIDATING",
          processingGeneration: candidate.processingGeneration,
          processingClaimToken: recoveryToken,
          processingLeaseExpiresAt: { gt: new Date() }
        },
        data: {
          status: "QUARANTINED",
          processingAvailableAt: new Date(Date.now() + 5_000),
          processingEnqueuedAt: null,
          processingClaimToken: null,
          processingLeaseExpiresAt: null,
          processingStartedAt: null,
          processingErrorCode: "PROCESSING_WORKER_INTERRUPTED",
          updatedAt: new Date()
        }
      });
    } catch (error) {
      if (await this.hasLiveClaim(recovered)) {
        await this.failCleanup(recovered, safeErrorCode(error));
      }
    } finally {
      lease.stop();
    }
  }
}

async function assertLiveClaim(transaction: Prisma.TransactionClient, claimed: ClaimedFile) {
  const file = await transaction.uploadedFile.findFirst({
    where: {
      id: claimed.id,
      sessionId: claimed.sessionId,
      status: "VALIDATING",
      processingGeneration: claimed.generation,
      processingClaimToken: claimed.claimToken,
      processingLeaseExpiresAt: { gt: new Date() }
    }
  });
  if (!file) throw new LeaseLostError();
  return file;
}

async function lockSession(
  transaction: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "print_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;
  if (rows.length !== 1) throw new LeaseLostError();
}

function terminalContentRejectionCode(code: string): UploadedFileRejectionCode | undefined {
  switch (code) {
    case "MALWARE_DETECTED":
      return "MALWARE_DETECTED";
    case "PASSWORD_PROTECTED_PDF":
      return "DOCUMENT_ENCRYPTED";
    case "MALFORMED_DOCUMENT":
      return "DOCUMENT_MALFORMED";
    case "PAGE_LIMIT_EXCEEDED":
      return "PAGE_LIMIT_EXCEEDED";
    case "IMAGE_DIMENSION_LIMIT_EXCEEDED":
      return "IMAGE_DIMENSION_LIMIT_EXCEEDED";
    case "IMAGE_PIXEL_LIMIT_EXCEEDED":
      return "IMAGE_PIXEL_LIMIT_EXCEEDED";
    case "OUTPUT_SIZE_LIMIT_EXCEEDED":
      return "OUTPUT_SIZE_LIMIT_EXCEEDED";
    case "UNSUPPORTED_DOCUMENT_CONTENT":
      return "UNSUPPORTED_DOCUMENT_CONTENT";
    default:
      return undefined;
  }
}

/**
 * A retryable failure that survives the whole attempt budget must still tell
 * the customer what actually went wrong. Reporting every exhausted budget as
 * `PROCESSING_FAILED` hid deterministic processing timeouts and scanner
 * outages behind a message about the document itself.
 */
function budgetExhaustedRejectionCode(code: string): UploadedFileRejectionCode {
  switch (code) {
    case "PROCESSING_TIMEOUT":
    case "PROCESSOR_TIMEOUT":
      return "PROCESSING_TIMEOUT";
    case "MALWARE_SCANNER_UNAVAILABLE":
    case "MALWARE_SCANNER_STALE":
      return "MALWARE_SCAN_UNAVAILABLE";
    default:
      return "PROCESSING_FAILED";
  }
}

function isKind(value: string | null): value is ClaimedFile["kind"] {
  return value === "PDF" || value === "JPEG" || value === "PNG";
}

function mimeForKind(kind: ClaimedFile["kind"]): "application/pdf" | "image/jpeg" | "image/png" {
  if (kind === "PDF") return "application/pdf";
  if (kind === "JPEG") return "image/jpeg";
  return "image/png";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,80}$/u.test(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^[A-Z0-9_]{3,80}$/u.test(code)) return code;
  }
  return "DOCUMENT_PROCESSING_FAILED";
}

function safeError(error: unknown): Record<string, unknown> {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorCode: safeErrorCode(error)
  };
}

class LeaseLostError extends Error {
  public constructor() {
    super("PROCESSING_LEASE_LOST");
    this.name = "LeaseLostError";
  }
}
