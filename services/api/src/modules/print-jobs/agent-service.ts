import {
  agentCommandAckSchema,
  agentPrintCommandSchema,
  claimAgentCommandsResponseSchema,
  printJobManifestSchema,
  simulatedPrintOutcomeSchema,
  type AgentPrintCommand,
  type ClaimAgentCommandsResponse,
  type PrintJobStatus,
  type ReportAgentCommandProgressBody,
  type ReportAgentCommandResultBody
} from "@printing-kiosk/contracts";
import {
  applyPrintJobSettlement,
  Prisma,
  recordPrintJobEvent,
  type PrismaClient
} from "@printing-kiosk/database";
import { settlePrintDeviceResult, type RetentionPolicy } from "@printing-kiosk/domain";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { isRetryableTransactionError } from "../sessions/transactions.js";

const MAX_TRANSACTION_ATTEMPTS = 5;
const OPEN_JOB_STATUSES = ["QUEUED", "DISPATCHED", "PRINTING"];

export interface AgentCommandServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  leaseSeconds: number;
  retentionPolicy: RetentionPolicy;
}

export interface LeasedCommand {
  printJobId: string;
  sessionId: string;
  operationId: string;
}

/**
 * The kiosk's side of the durable command channel.
 *
 * A kiosk opens no inbound port. It leases work here over its own outbound
 * connection, holds that lease while it prints, and reports back. The lease is
 * what makes a crashed agent recoverable without anybody guessing: the command
 * returns to the queue marked as redelivered, and the agent is then obliged to
 * ask the device what it already did before submitting anything.
 */
export class AgentCommandService {
  public constructor(private readonly options: AgentCommandServiceOptions) {}

  public async claim(input: { kioskId: string; max: number }): Promise<ClaimAgentCommandsResponse> {
    const now = this.options.clock.now();
    const commands: AgentPrintCommand[] = [];

    for (let index = 0; index < input.max; index += 1) {
      const claimed = await this.claimOne(input.kioskId, now);
      if (!claimed) break;
      commands.push(claimed);
    }

    return claimAgentCommandsResponseSchema.parse({ commands });
  }

  /**
   * The agent has the work in hand. Extending the lease here is what keeps a
   * slow but healthy print from being taken away and handed to somebody else.
   */
  public async reportProgress(input: {
    kioskId: string;
    operationId: string;
    body: ReportAgentCommandProgressBody;
  }): Promise<{ accepted: boolean; printJobStatus: PrintJobStatus }> {
    return this.withSessionTransaction(
      input.kioskId,
      input.operationId,
      async (transaction, command) => {
        const now = this.options.clock.now();
        const leaseExpiresAt = await this.renewedLeaseExpiry(
          transaction,
          command,
          input.body.claimToken,
          now
        );
        if (!leaseExpiresAt) return this.acknowledge(transaction, command.printJobId, false);

        const renewed = await transaction.agentCommand.updateMany({
          where: {
            id: command.id,
            status: "CLAIMED",
            claimToken: input.body.claimToken,
            leaseExpiresAt: { gt: now },
            expiresAt: { gt: now }
          },
          data: {
            leaseExpiresAt,
            updatedAt: now
          }
        });
        if (renewed.count !== 1) {
          return this.acknowledge(transaction, command.printJobId, false);
        }

        // PREPARING is only a lease heartbeat while the agent fetches artifacts.
        // SUBMITTED/PRINTING cross the device handoff boundary and make a lost
        // result ambiguous rather than refundable.
        const crossesSubmissionBoundary = input.body.state !== "PREPARING";
        const started = crossesSubmissionBoundary
          ? await transaction.printJob.updateMany({
              where: { id: command.printJobId, status: { in: ["QUEUED", "DISPATCHED"] } },
              data: { status: "PRINTING", startedAt: now, updatedAt: now }
            })
          : { count: 0 };
        const printJob = await transaction.printJob.findUniqueOrThrow({
          where: { id: command.printJobId },
          select: { status: true }
        });
        await recordPrintJobEvent(transaction, {
          id: this.options.random.uuid(now),
          printJobId: command.printJobId,
          type: input.body.state === "SUBMITTED" ? "SUBMITTED" : "PROGRESS",
          status: started.count === 1 ? "PRINTING" : printJob.status,
          operationId: command.operationId,
          now
        });

        return this.acknowledge(transaction, command.printJobId, true);
      }
    );
  }

  /**
   * The device has finished, one way or another. The pure settlement reducer
   * decides what that means for the job, the session and the money; nothing is
   * decided here beyond proving that the reporter still holds the lease.
   */
  public async reportResult(input: {
    kioskId: string;
    credentialId: string;
    operationId: string;
    requestId: string;
    body: ReportAgentCommandResultBody;
  }): Promise<{ accepted: boolean; printJobStatus: PrintJobStatus }> {
    return this.withSessionTransaction(
      input.kioskId,
      input.operationId,
      async (transaction, command) => {
        const held =
          (await this.renewedLeaseExpiry(
            transaction,
            command,
            input.body.claimToken,
            this.options.clock.now()
          )) !== null;
        // A lost lease means the control plane already settled this job without
        // the device. The report is acknowledged so the agent stops retrying,
        // but it changes nothing.
        if (!held) return this.acknowledge(transaction, command.printJobId, false);

        const now = this.options.clock.now();
        const job = await transaction.printJob.findUniqueOrThrow({
          where: { id: command.printJobId },
          select: { physicalSheets: true }
        });

        const settlement = settlePrintDeviceResult({
          state: input.body.state,
          confidence: input.body.confidence,
          failureCode: input.body.failureCode,
          warningCode: input.body.warningCode,
          sheetsProduced: sheetsWithinJob(input.body.sheetsProduced, job.physicalSheets)
        });

        const outcome = await applyPrintJobSettlement(transaction, {
          printJobId: command.printJobId,
          ...settlement,
          operationId: command.operationId,
          ledgerType: ledgerTypeFor(settlement.status),
          actorType: "KIOSK_AGENT",
          actorId: input.credentialId,
          requestId: input.requestId,
          now,
          newId: () => this.options.random.uuid(now),
          retentionPolicy: this.options.retentionPolicy
        });

        return this.acknowledge(transaction, command.printJobId, outcome.applied);
      }
    );
  }

  private async claimOne(kioskId: string, now: Date): Promise<AgentPrintCommand | null> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            const candidate = await transaction.agentCommand.findFirst({
              where: {
                kioskId,
                status: "PENDING",
                availableAt: { lte: now },
                expiresAt: { gt: now },
                printJob: { status: { in: OPEN_JOB_STATUSES } }
              },
              orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }]
            });
            if (!candidate?.printJobId) return null;

            const claimToken = this.options.random.uuid(now);
            const leaseExpiresAt = new Date(
              Math.min(
                now.getTime() + this.options.leaseSeconds * 1_000,
                candidate.expiresAt.getTime()
              )
            );
            const leased = await transaction.agentCommand.updateMany({
              where: { id: candidate.id, status: "PENDING", attempts: candidate.attempts },
              data: {
                status: "CLAIMED",
                claimToken,
                claimedAt: now,
                leaseExpiresAt,
                attempts: candidate.attempts + 1,
                updatedAt: now
              }
            });
            // Another agent instance won the row. Nothing was handed out here.
            if (leased.count !== 1) return null;

            await recordPrintJobEvent(transaction, {
              id: this.options.random.uuid(now),
              printJobId: candidate.printJobId,
              type: "CLAIMED",
              status: "DISPATCHED",
              operationId: candidate.operationId,
              now,
              detail: { attempt: candidate.attempts + 1 }
            });

            return toAgentCommand(candidate, {
              claimToken,
              leaseExpiresAt,
              // A second hand-out means an earlier attempt may already have
              // reached the device.
              redelivered: candidate.attempts > 0
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw error;
      }
    }
    return null;
  }

  private async withSessionTransaction<T>(
    kioskId: string,
    operationId: string,
    run: (
      transaction: Prisma.TransactionClient,
      command: {
        id: string;
        printJobId: string;
        sessionId: string;
        operationId: string;
        status: string;
        leaseExpiresAt: Date | null;
        claimToken: string | null;
        expiresAt: Date;
      }
    ) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            const command = await transaction.agentCommand.findFirst({
              where: { operationId, kioskId }
            });
            // A foreign kiosk is told the operation does not exist rather than
            // that it exists and belongs to another device.
            if (!command?.printJobId || !command.sessionId) throw operationNotFound();
            await lockSessionRow(transaction, command.sessionId);

            return run(transaction, {
              id: command.id,
              printJobId: command.printJobId,
              sessionId: command.sessionId,
              operationId: command.operationId,
              status: command.status,
              leaseExpiresAt: command.leaseExpiresAt,
              claimToken: command.claimToken,
              expiresAt: command.expiresAt
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw error;
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The print job changed concurrently. Please retry."
    );
  }

  private async renewedLeaseExpiry(
    transaction: Prisma.TransactionClient,
    command: { id: string },
    claimToken: string,
    now: Date
  ): Promise<Date | null> {
    const current = await transaction.agentCommand.findUnique({
      where: { id: command.id },
      select: { status: true, claimToken: true, leaseExpiresAt: true, expiresAt: true }
    });
    if (!current || current.status !== "CLAIMED" || current.claimToken !== claimToken) return null;
    if (
      (current.leaseExpiresAt?.getTime() ?? 0) <= now.getTime() ||
      current.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    return new Date(
      Math.min(now.getTime() + this.options.leaseSeconds * 1_000, current.expiresAt.getTime())
    );
  }

  private async acknowledge(
    transaction: Prisma.TransactionClient,
    printJobId: string,
    accepted: boolean
  ): Promise<{ accepted: boolean; printJobStatus: PrintJobStatus }> {
    const printJob = await transaction.printJob.findUniqueOrThrow({
      where: { id: printJobId },
      select: { status: true }
    });
    return agentCommandAckSchema.parse({ accepted, printJobStatus: printJob.status });
  }
}

/**
 * A device cannot have produced more sheets than the job it was given.
 *
 * A count above that is a device the control plane cannot read, not a bigger
 * job, so it becomes "unknown" rather than a number. The settlement reducer
 * then does what it already does with any unknown count: it refuses to call the
 * result a success or a definite failure and sends it to operator recovery.
 * Passing the value through instead would fail the stored-outcome constraint,
 * turning a malfunctioning printer into a 500 and leaving the paid job to hang
 * until its deadline.
 */
function sheetsWithinJob(reported: number | null, physicalSheets: number): number | null {
  if (reported === null || reported <= physicalSheets) return reported;
  return null;
}

function ledgerTypeFor(status: string) {
  if (status === "COMPLETED") return "COMPLETED" as const;
  if (status === "CANCELED") return "CANCELED" as const;
  if (status === "RECOVERY_REQUIRED") return "RECOVERY_REQUIRED" as const;
  return "FAILED" as const;
}

function toAgentCommand(
  command: {
    operationId: string;
    printJobId: string | null;
    sessionId: string | null;
    payload: unknown;
    expiresAt: Date;
  },
  lease: { claimToken: string; leaseExpiresAt: Date; redelivered: boolean }
): AgentPrintCommand {
  const payload =
    command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
      ? (command.payload as Record<string, unknown>)
      : {};
  const simulatedOutcome = simulatedPrintOutcomeSchema.safeParse(payload.simulatedOutcome);

  return agentPrintCommandSchema.parse({
    operationId: command.operationId,
    type: "PRINT",
    printJobId: command.printJobId,
    sessionId: command.sessionId,
    claimToken: lease.claimToken,
    manifest: printJobManifestSchema.parse(payload.manifest),
    manifestHash: payload.manifestHash,
    leaseExpiresAt: lease.leaseExpiresAt.toISOString(),
    deadlineAt: command.expiresAt.toISOString(),
    redelivered: lease.redelivered,
    simulatedOutcome: simulatedOutcome.success ? simulatedOutcome.data : null
  });
}

async function lockSessionRow(
  transaction: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await transaction.$queryRaw`
    SELECT "id" FROM "print_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;
}

export function operationNotFound(): ApiError {
  return new ApiError(404, "PRINT_OPERATION_NOT_FOUND", "Print operation not found.");
}
