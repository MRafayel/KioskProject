import { randomUUID } from "node:crypto";

import { Queue, Worker, type Job } from "bullmq";

import { redisConnectionOptions } from "@printing-kiosk/config";
import {
  printDispatchJobSchema,
  PRINT_DISPATCH_QUEUE_NAME,
  type PrintDispatchJob
} from "@printing-kiosk/contracts";
import {
  applyPrintJobSettlement,
  Prisma,
  recordPrintJobEvent,
  type PrismaClient
} from "@printing-kiosk/database";
import { settlePrintDeviceResult, type RetentionPolicy } from "@printing-kiosk/domain";

const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_DISPATCH_BATCH = 25;
const MAX_RECONCILE_BATCH = 25;

export interface PrintDispatcherLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface PrintDispatcherOptions {
  database: PrismaClient;
  redisUrl: string;
  logger: PrintDispatcherLogger;
  /** How long an agent may hold one command before it is offered again. */
  leaseMilliseconds: number;
  /** How many times a lease may be handed back before the job is unresolvable. */
  maxCommandAttempts: number;
  maxDispatchAttempts: number;
  /** Retention grace applied when reconciliation, rather than the agent, settles a print. */
  retentionPolicy: RetentionPolicy;
  pollIntervalMilliseconds?: number;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Turns paid print jobs into durable work for a kiosk, and settles the ones
 * that never come back.
 *
 * Nothing here prints. The HTTP path writes a `QUEUED` job; this dispatcher
 * hands it to the queue, the queue handler writes one command row, and the
 * kiosk agent leases that command. The queue is only a wake-up: every decision
 * is guarded on a database row, so a duplicate delivery, a lost job, or a
 * restart produces the same single command rather than a second print.
 *
 * It also refuses to guess. A command that was never claimed and has run out
 * of time is a definite failure — nothing reached a device. A command that was
 * claimed and then went quiet is ambiguous, and becomes `RECOVERY_REQUIRED`.
 */
export class PrintDispatcher {
  private readonly queue: Queue<PrintDispatchJob>;
  private readonly worker: Worker<PrintDispatchJob>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private working = false;

  public constructor(private readonly options: PrintDispatcherOptions) {
    const connection = redisConnectionOptions(options.redisUrl);
    this.queue = new Queue<PrintDispatchJob>(PRINT_DISPATCH_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 }
      }
    });
    this.worker = new Worker<PrintDispatchJob>(
      PRINT_DISPATCH_QUEUE_NAME,
      (job) => this.issueCommand(job),
      { connection, concurrency: 1, autorun: false, maxStalledCount: 1 }
    );
    this.worker.on("failed", (job, error) => {
      options.logger.error(
        { jobId: job?.id, printJobId: job?.data.printJobId, errorCode: safeErrorCode(error) },
        "print dispatch job failed"
      );
    });
    this.worker.on("error", (error) => {
      options.logger.error(safeError(error), "print dispatch worker error");
    });
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.worker.run().catch((error) => {
      if (!this.stopped) this.options.logger.error(safeError(error), "print worker stopped");
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
   * Public so integration tests can drive one pass deterministically. The queue
   * stays a wake-up mechanism: the guarded database row is authoritative.
   */
  public async dispatchOnce(): Promise<number> {
    if (this.working) return 0;
    this.working = true;
    try {
      const now = this.now();
      const candidates = await this.options.database.printJob.findMany({
        where: {
          status: "QUEUED",
          availableAt: { lte: now },
          dispatchAttempts: { lt: this.options.maxDispatchAttempts }
        },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
        take: MAX_DISPATCH_BATCH,
        select: { id: true, dispatchAttempts: true }
      });

      let dispatched = 0;
      for (const candidate of candidates) {
        const attempt = candidate.dispatchAttempts + 1;
        const reserved = await this.options.database.printJob.updateMany({
          where: {
            id: candidate.id,
            status: "QUEUED",
            dispatchAttempts: candidate.dispatchAttempts
          },
          data: {
            dispatchAttempts: attempt,
            availableAt: new Date(now.getTime() + backoffMilliseconds(attempt)),
            updatedAt: now
          }
        });
        if (reserved.count !== 1) continue;

        try {
          await this.queue.add(
            "issue-print-command",
            printDispatchJobSchema.parse({ printJobId: candidate.id, attempt }),
            { jobId: `${candidate.id.replaceAll("-", "")}-a${attempt}` }
          );
          dispatched += 1;
        } catch (error) {
          this.options.logger.warn(
            { printJobId: candidate.id, attempt, errorCode: safeErrorCode(error) },
            "print job could not be queued"
          );
        }
      }
      return dispatched;
    } finally {
      this.working = false;
    }
  }

  /**
   * Settle what the device did not. Three cases, deliberately distinct: a lease
   * that expired but may still be retried, a job whose command can no longer be
   * handed out, and a job past its own deadline.
   */
  public async reconcileOnce(): Promise<number> {
    const now = this.now();
    let settled = 0;

    const expiredLeases = await this.options.database.agentCommand.findMany({
      where: { status: "CLAIMED", leaseExpiresAt: { lte: now } },
      orderBy: { leaseExpiresAt: "asc" },
      take: MAX_RECONCILE_BATCH,
      select: { id: true }
    });
    for (const command of expiredLeases) {
      if (await this.releaseLease(command.id)) settled += 1;
    }

    const overdue = await this.options.database.printJob.findMany({
      where: {
        status: { in: ["QUEUED", "DISPATCHED", "PRINTING"] },
        deadlineAt: { lte: now }
      },
      orderBy: { deadlineAt: "asc" },
      take: MAX_RECONCILE_BATCH,
      select: { id: true }
    });
    for (const job of overdue) {
      if (await this.settleOverdue(job.id)) settled += 1;
    }

    return settled;
  }

  private async issueCommand(job: Job<PrintDispatchJob>): Promise<void> {
    const parsed = printDispatchJobSchema.parse(job.data);
    await this.options.database.$transaction(
      async (transaction) => {
        const now = this.now();
        const candidate = await transaction.printJob.findUnique({
          where: { id: parsed.printJobId }
        });
        // A duplicate queue delivery, or a job that was cancelled between the
        // reservation and the handler, both land here and do nothing.
        if (!candidate || candidate.status !== "QUEUED") return;

        await lockSessionRow(transaction, candidate.sessionId);
        // Cancellation may have settled the row while this handler waited for
        // the session lock. Re-read after locking so a stale QUEUED snapshot can
        // never create a command for a terminal job.
        const printJob = await transaction.printJob.findUnique({
          where: { id: parsed.printJobId }
        });
        if (!printJob || printJob.status !== "QUEUED") return;

        const existing = await transaction.agentCommand.findUnique({
          where: { printJobId: printJob.id },
          select: { id: true }
        });
        if (!existing) {
          await transaction.agentCommand.create({
            data: {
              id: this.newId(),
              kioskId: printJob.kioskId,
              sessionId: printJob.sessionId,
              printJobId: printJob.id,
              // One operation identifier per job, stable across redeliveries,
              // so a device that already saw it can recognise it.
              operationId: this.newId(),
              type: "PRINT",
              status: "PENDING",
              payload: {
                manifest: printJob.jobManifest as Prisma.InputJsonValue,
                manifestHash: printJob.jobManifestHash,
                simulatedOutcome: printJob.simulatedOutcome
              },
              availableAt: now,
              expiresAt: printJob.deadlineAt,
              createdAt: now,
              updatedAt: now
            }
          });
        }

        const moved = await transaction.printJob.updateMany({
          where: { id: printJob.id, status: "QUEUED" },
          data: { status: "DISPATCHED", dispatchedAt: now, updatedAt: now }
        });
        if (moved.count !== 1) return;

        await recordPrintJobEvent(transaction, {
          id: this.newId(),
          printJobId: printJob.id,
          type: "DISPATCHED",
          status: "DISPATCHED",
          now,
          detail: { attempt: parsed.attempt }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private async releaseLease(commandId: string): Promise<boolean> {
    return this.options.database.$transaction(
      async (transaction) => {
        const now = this.now();
        const command = await transaction.agentCommand.findUnique({ where: { id: commandId } });
        if (!command?.printJobId || !command.sessionId || command.status !== "CLAIMED") {
          return false;
        }
        if ((command.leaseExpiresAt?.getTime() ?? 0) > now.getTime()) return false;

        await lockSessionRow(transaction, command.sessionId);

        const exhausted =
          command.attempts >= this.options.maxCommandAttempts ||
          command.expiresAt.getTime() <= now.getTime();

        if (!exhausted) {
          const released = await transaction.agentCommand.updateMany({
            where: { id: command.id, status: "CLAIMED", claimToken: command.claimToken },
            data: {
              status: "PENDING",
              claimToken: null,
              leaseExpiresAt: null,
              availableAt: now,
              updatedAt: now
            }
          });
          if (released.count !== 1) return false;

          await recordPrintJobEvent(transaction, {
            id: this.newId(),
            printJobId: command.printJobId,
            type: "LEASE_EXPIRED",
            status: "DISPATCHED",
            operationId: command.operationId,
            now,
            detail: { attempts: command.attempts, redeliverable: true }
          });
          return true;
        }

        const printJob = await transaction.printJob.findUnique({
          where: { id: command.printJobId },
          select: { status: true }
        });
        // Exhausting preparation leases is a definite pre-device failure. Once
        // an accepted submission report moved the job to PRINTING, silence is
        // ambiguous and only an operator may settle it.
        const submissionMayHaveStarted = printJob?.status === "PRINTING";
        const settlement = submissionMayHaveStarted
          ? settlePrintDeviceResult({
              state: "UNKNOWN",
              confidence: "UNCONFIRMED",
              failureCode: "SUBMISSION_UNCONFIRMED",
              warningCode: null,
              sheetsProduced: null
            })
          : settlePrintDeviceResult({
              state: "NOT_SUBMITTED",
              confidence: "CONFIRMED",
              failureCode: "PRINTER_UNAVAILABLE",
              warningCode: null,
              sheetsProduced: 0
            });
        const outcome = await applyPrintJobSettlement(transaction, {
          printJobId: command.printJobId,
          ...settlement,
          operationId: command.operationId,
          ledgerType: submissionMayHaveStarted ? "RECOVERY_REQUIRED" : "FAILED",
          actorType: "SYSTEM",
          actorId: "print-dispatcher",
          now,
          newId: () => this.newId(),
          retentionPolicy: this.options.retentionPolicy
        });
        if (outcome.applied && submissionMayHaveStarted) {
          this.options.logger.warn(
            { printJobId: command.printJobId, operationId: command.operationId },
            "print operation lease exhausted; operator recovery required"
          );
        }
        return outcome.applied;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private async settleOverdue(printJobId: string): Promise<boolean> {
    return this.options.database.$transaction(
      async (transaction) => {
        const now = this.now();
        const printJob = await transaction.printJob.findUnique({ where: { id: printJobId } });
        if (!printJob || printJob.deadlineAt.getTime() > now.getTime()) return false;
        await lockSessionRow(transaction, printJob.sessionId);

        const command = await transaction.agentCommand.findUnique({
          where: { printJobId: printJob.id },
          select: { operationId: true, status: true, attempts: true }
        });

        // A claim can be only preparation. The accepted submission heartbeat is
        // what moves the job to PRINTING; before that boundary a deadline is a
        // definite failure, afterwards it is ambiguous.
        const submissionMayHaveStarted = printJob.status === "PRINTING";
        const settlement = !submissionMayHaveStarted
          ? settlePrintDeviceResult({
              state: "NOT_SUBMITTED",
              confidence: "CONFIRMED",
              failureCode: "PRINTER_UNAVAILABLE",
              warningCode: null,
              sheetsProduced: 0
            })
          : settlePrintDeviceResult({
              state: "UNKNOWN",
              confidence: "UNCONFIRMED",
              failureCode: "JOB_DEADLINE_EXCEEDED",
              warningCode: null,
              sheetsProduced: null
            });

        const outcome = await applyPrintJobSettlement(transaction, {
          printJobId: printJob.id,
          ...settlement,
          operationId: command?.operationId ?? null,
          ledgerType: "DEADLINE_EXCEEDED",
          actorType: "SYSTEM",
          actorId: "print-dispatcher",
          now,
          newId: () => this.newId(),
          retentionPolicy: this.options.retentionPolicy
        });
        if (outcome.applied) {
          this.options.logger.info(
            {
              printJobId: printJob.id,
              sessionId: printJob.sessionId,
              status: settlement.status
            },
            "print job settled at its deadline"
          );
        }
        return outcome.applied;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private schedule(delayMilliseconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMilliseconds);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const dispatched = await this.dispatchOnce();
      await this.reconcileOnce();
      this.schedule(dispatched > 0 ? 0 : this.pollInterval);
    } catch (error) {
      this.options.logger.error(safeError(error), "print dispatcher tick failed");
      this.schedule(this.pollInterval);
    }
  }

  private get pollInterval(): number {
    return this.options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private newId(): string {
    return this.options.newId?.() ?? randomUUID();
  }
}

async function lockSessionRow(
  transaction: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await transaction.$queryRaw`
    SELECT "id" FROM "print_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;
}

function backoffMilliseconds(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^[A-Z0-9_]{2,80}$/.test(code)) return code;
  }
  return "PRINT_DISPATCH_FAILED";
}

function safeError(error: unknown): Record<string, unknown> {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorCode: safeErrorCode(error)
  };
}
