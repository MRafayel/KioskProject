import {
  agentHeartbeatResponseSchema,
  registerAgentResponseSchema,
  reportPrinterStateResponseSchema,
  type AgentHeartbeatBody,
  type AgentHeartbeatResponse,
  type DiscoveredPrinterQueue,
  type RegisterAgentBody,
  type RegisterAgentResponse,
  printerQueueNameSchema,
  type ReportPrinterStateBody,
  type ReportPrinterStateResponse
} from "@printing-kiosk/contracts";
import { Prisma, type PrismaClient } from "@printing-kiosk/database";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { isRetryableTransactionError, isUniqueConstraintError } from "../sessions/transactions.js";

const MAX_TRANSACTION_ATTEMPTS = 5;

export interface DeviceRegistryServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  /** How often an agent must be heard from before a fleet calls it silent. */
  heartbeatIntervalSeconds: number;
}

/**
 * The control plane's record of the machines and printers under it.
 *
 * Nothing here is on a customer's path. It exists so that two things stop being
 * assumptions: that a kiosk's capability row describes the printer actually
 * attached to it, and that a kiosk which has gone quiet can be told apart from
 * one that is simply not printing right now.
 *
 * The rule that shapes it is that an agent describes; it does not decide. It
 * reports every queue its machine offers and which one it believes it may use,
 * and this service checks that belief against the operator's allowlist before
 * a single capability reaches the row a customer's settings are validated
 * against. A kiosk that names a printer nobody certified publishes nothing.
 */
export class DeviceRegistryService {
  public constructor(private readonly options: DeviceRegistryServiceOptions) {}

  public async register(input: {
    kioskId: string;
    body: RegisterAgentBody;
  }): Promise<RegisterAgentResponse> {
    const now = this.options.clock.now();
    const kiosk = await this.readKiosk(input.kioskId);

    const existing = await this.options.database.kioskAgent.findUnique({
      where: { agentId: input.body.agentId },
      select: { kioskId: true }
    });
    // An installation identifier belongs to one machine. A kiosk presenting
    // another kiosk's agent is refused rather than allowed to take it over,
    // because a fleet's liveness view would then describe the wrong machine.
    if (existing && existing.kioskId !== input.kioskId) throw agentClaimedElsewhere();

    const attributes = {
      agentVersion: input.body.agentVersion,
      platform: input.body.platform,
      platformRelease: input.body.platformRelease,
      adapter: input.body.adapter,
      queueName: input.body.queueName,
      registeredAt: now,
      lastHeartbeatAt: now,
      updatedAt: now
    };

    if (existing) {
      // A re-registration is a restarted or upgraded agent, not a new one.
      await this.options.database.kioskAgent.updateMany({
        where: { agentId: input.body.agentId, kioskId: input.kioskId },
        data: attributes
      });
    } else {
      try {
        await this.options.database.kioskAgent.create({
          data: {
            id: this.options.random.uuid(now),
            kioskId: input.kioskId,
            agentId: input.body.agentId,
            ...attributes
          }
        });
      } catch (error) {
        // Another kiosk registered the same installation between the read and
        // this insert. The unique index is what makes that a refusal.
        if (isUniqueConstraintError(error)) throw agentClaimedElsewhere();
        throw error;
      }
    }

    return registerAgentResponseSchema.parse({
      registration: {
        kioskId: input.kioskId,
        agentId: input.body.agentId,
        heartbeatIntervalSeconds: this.options.heartbeatIntervalSeconds,
        approvedQueues: kiosk.approvedQueues,
        capabilityVersion: kiosk.capabilitiesVersion,
        registeredAt: now.toISOString()
      }
    });
  }

  /**
   * Liveness, plus the one comparison that makes it useful: the digest of the
   * capability snapshot the agent is running on. When it differs from what is
   * stored, the printer has been changed, reconfigured or replaced, and the
   * agent is told to report afresh — within one heartbeat rather than at the
   * next print.
   */
  public async heartbeat(input: {
    kioskId: string;
    body: AgentHeartbeatBody;
  }): Promise<AgentHeartbeatResponse> {
    const now = this.options.clock.now();
    const kiosk = await this.readKiosk(input.kioskId);

    const updated = await this.options.database.kioskAgent.updateMany({
      where: { agentId: input.body.agentId, kioskId: input.kioskId },
      data: {
        queueName: input.body.queueName,
        printerHealth: input.body.printerHealth,
        capabilityHash: input.body.capabilityHash,
        activeOperations: input.body.activeOperations,
        lastHeartbeatAt: now,
        updatedAt: now
      }
    });
    // An agent that was never registered — or one registered to another kiosk —
    // is told to register rather than quietly counted as alive.
    if (updated.count !== 1) throw agentNotRegistered();

    const approved = await this.options.database.printer.findFirst({
      where: { kioskId: input.kioskId, approval: "APPROVED" },
      select: { queueName: true, capabilityHash: true, health: true }
    });

    await this.options.database.kiosk.update({
      where: { id: input.kioskId },
      data: { lastSeenAt: now }
    });

    if (approved) {
      await this.options.database.printer.updateMany({
        where: { kioskId: input.kioskId, queueName: approved.queueName },
        data: {
          health: input.body.printerHealth,
          lastSeenAt: now,
          updatedAt: now,
          // Only written when the agent actually offers one. An older agent, or
          // a kiosk with no telemetry link, leaves whatever is stored alone
          // rather than overwriting it with a null that would read as a link
          // that had just gone quiet.
          ...(input.body.telemetryAt ? { telemetryAt: new Date(input.body.telemetryAt) } : {}),
          ...(input.body.printerHealth === "READY" ? { lastHealthyAt: now } : {})
        }
      });
    }

    return agentHeartbeatResponseSchema.parse({
      acknowledgedAt: now.toISOString(),
      // Either the stored printer does not match what the agent is running on,
      // or there is no stored printer at all and one is owed.
      capabilityReportRequired:
        !approved ||
        approved.capabilityHash !== input.body.capabilityHash ||
        approved.queueName !== input.body.queueName,
      approvedQueues: kiosk.approvedQueues,
      capabilityVersion: kiosk.capabilitiesVersion
    });
  }

  /**
   * The capability and health report.
   *
   * This is the only path by which a device changes what a customer may be
   * offered, so it is the one place that re-derives approval instead of
   * believing it. The agent's own verdict is treated as a claim: a queue that
   * is not on the kiosk's allowlist is stored as discovered and unapproved
   * however the agent labelled it, and its capabilities are dropped.
   */
  public async reportPrinters(input: {
    kioskId: string;
    body: ReportPrinterStateBody;
  }): Promise<ReportPrinterStateResponse> {
    const now = this.options.clock.now();
    const kiosk = await this.readKiosk(input.kioskId);

    const agent = await this.options.database.kioskAgent.findFirst({
      where: { agentId: input.body.agentId, kioskId: input.kioskId },
      select: { id: true }
    });
    if (!agent) throw agentNotRegistered();

    const allowlist = new Set(kiosk.approvedQueues.map(normalizeQueueName));
    const approvedQueueName =
      input.body.approval === "APPROVED" &&
      input.body.queueName &&
      allowlist.has(normalizeQueueName(input.body.queueName))
        ? input.body.queueName
        : null;

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            await this.writeDiscoveredQueues(transaction, {
              kioskId: input.kioskId,
              adapter: input.body.adapter,
              queues: input.body.discovered,
              approvedQueueName,
              now
            });

            const stored = approvedQueueName
              ? await this.writeApprovedPrinter(transaction, {
                  kioskId: input.kioskId,
                  queueName: approvedQueueName,
                  body: input.body,
                  now
                })
              : await this.withdrawApprovedPrinter(transaction, input.kioskId, now);

            // Only a change to what the device can do bumps the version, and
            // only a bump invalidates the quotes customers are holding.
            const capabilitiesUpdated =
              stored.capabilities !== null && stored.capabilityHashChanged;
            const capabilityVersion = capabilitiesUpdated
              ? kiosk.capabilitiesVersion + 1
              : kiosk.capabilitiesVersion;

            // This replaces `capabilities` wholesale, which is correct: the
            // device is the only authority on what it can do, and a merge would
            // keep offering a paper size the printer no longer has. It is safe
            // only because nothing an operator owns lives in that column — put
            // operator configuration in its own column, never in here.
            if (capabilitiesUpdated) {
              await transaction.kiosk.update({
                where: { id: input.kioskId },
                data: {
                  capabilities: stored.capabilities as Prisma.InputJsonValue,
                  capabilitiesVersion: capabilityVersion,
                  lastSeenAt: now,
                  updatedAt: now
                }
              });
            } else {
              await transaction.kiosk.update({
                where: { id: input.kioskId },
                data: { lastSeenAt: now }
              });
            }

            return reportPrinterStateResponseSchema.parse({
              capabilitiesUpdated,
              capabilityVersion,
              acceptedAt: now.toISOString()
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
      "CONCURRENT_DEVICE_UPDATE",
      "The device record changed concurrently. Please retry."
    );
  }

  /**
   * Every queue the machine offers gets a row. An operator certifying a kiosk
   * has to be able to see what is installed on it, and a queue that appeared
   * without anybody adding it is exactly what should be visible.
   */
  private async writeDiscoveredQueues(
    transaction: Prisma.TransactionClient,
    input: {
      kioskId: string;
      adapter: string;
      queues: readonly DiscoveredPrinterQueue[];
      approvedQueueName: string | null;
      now: Date;
    }
  ): Promise<void> {
    for (const queue of input.queues) {
      // The approved queue is written separately, with its capabilities. It is
      // skipped here so its row is never briefly stripped of them.
      if (
        input.approvedQueueName &&
        normalizeQueueName(queue.queueName) === normalizeQueueName(input.approvedQueueName)
      ) {
        continue;
      }

      const shape = {
        adapter: input.adapter,
        approval: "NOT_APPROVED",
        queueState: queue.state,
        isDefault: queue.isDefault,
        shared: queue.shared,
        deviceUri: queue.deviceUri,
        driverName: queue.driverName,
        portName: queue.portName,
        capabilities: Prisma.DbNull,
        capabilityHash: null,
        lastSeenAt: input.now,
        updatedAt: input.now
      };
      await transaction.printer.upsert({
        where: { kioskId_queueName: { kioskId: input.kioskId, queueName: queue.queueName } },
        create: {
          id: this.options.random.uuid(input.now),
          kioskId: input.kioskId,
          queueName: queue.queueName,
          health: "OFFLINE",
          ...shape
        },
        update: shape
      });
    }
  }

  private async writeApprovedPrinter(
    transaction: Prisma.TransactionClient,
    input: {
      kioskId: string;
      queueName: string;
      body: ReportPrinterStateBody;
      now: Date;
    }
  ): Promise<{ capabilities: unknown; capabilityHashChanged: boolean }> {
    const previous = await transaction.printer.findUnique({
      where: { kioskId_queueName: { kioskId: input.kioskId, queueName: input.queueName } },
      select: { capabilityHash: true }
    });

    // At most one approved printer per kiosk is a database invariant. Standing
    // the others down first is what keeps a re-certified kiosk from colliding
    // with its own previous printer.
    await transaction.printer.updateMany({
      where: { kioskId: input.kioskId, approval: "APPROVED", queueName: { not: input.queueName } },
      data: {
        approval: "NOT_APPROVED",
        capabilities: Prisma.DbNull,
        capabilityHash: null,
        updatedAt: input.now
      }
    });

    const discovered = input.body.discovered.find(
      (queue) => normalizeQueueName(queue.queueName) === normalizeQueueName(input.queueName)
    );
    const shape = {
      adapter: input.body.adapter,
      approval: "APPROVED",
      queueState: discovered?.state ?? (input.body.health === "OFFLINE" ? "OFFLINE" : "READY"),
      isDefault: discovered?.isDefault ?? false,
      shared: discovered?.shared ?? false,
      deviceUri: discovered?.deviceUri ?? null,
      driverName: input.body.driverName ?? discovered?.driverName ?? null,
      portName: discovered?.portName ?? null,
      deviceId: input.body.deviceId,
      makeAndModel: input.body.makeAndModel,
      driverVersion: input.body.driverVersion ?? null,
      firmware: input.body.firmware,
      health: input.body.health,
      warningCode: input.body.warningCode,
      capabilities: (input.body.capabilities ?? {}) as Prisma.InputJsonValue,
      capabilityHash: input.body.capabilityHash,
      lastSeenAt: input.now,
      updatedAt: input.now,
      ...(input.body.health === "READY" ? { lastHealthyAt: input.now } : {})
    };

    await transaction.printer.upsert({
      where: { kioskId_queueName: { kioskId: input.kioskId, queueName: input.queueName } },
      create: {
        id: this.options.random.uuid(input.now),
        kioskId: input.kioskId,
        queueName: input.queueName,
        ...shape
      },
      update: shape
    });

    return {
      capabilities: input.body.capabilities,
      capabilityHashChanged: previous?.capabilityHash !== input.body.capabilityHash
    };
  }

  /**
   * The agent could not bind an approved printer. The kiosk's stored
   * capabilities are deliberately left alone: withdrawing them would change
   * what a customer mid-session is allowed to choose because a printer was
   * briefly unreachable. What is withdrawn is the approval, which is what a
   * fleet view reads to say this kiosk has no certified device.
   */
  private async withdrawApprovedPrinter(
    transaction: Prisma.TransactionClient,
    kioskId: string,
    now: Date
  ): Promise<{ capabilities: unknown; capabilityHashChanged: boolean }> {
    await transaction.printer.updateMany({
      where: { kioskId, approval: "APPROVED" },
      data: {
        approval: "NOT_APPROVED",
        capabilities: Prisma.DbNull,
        capabilityHash: null,
        health: "OFFLINE",
        updatedAt: now
      }
    });
    return { capabilities: null, capabilityHashChanged: false };
  }

  private async readKiosk(
    kioskId: string
  ): Promise<{ approvedQueues: string[]; capabilitiesVersion: number }> {
    const kiosk = await this.options.database.kiosk.findUnique({
      where: { id: kioskId },
      select: { approvedQueues: true, capabilitiesVersion: true, status: true }
    });
    if (!kiosk || kiosk.status !== "ACTIVE") {
      throw new ApiError(404, "KIOSK_NOT_FOUND", "Kiosk not found.");
    }
    return {
      approvedQueues: readApprovedQueues(kiosk.approvedQueues),
      capabilitiesVersion: kiosk.capabilitiesVersion
    };
  }
}

/**
 * The operator's allowlist, read from the column that only an operator writes.
 * An absent list approves nothing: a kiosk nobody has certified a printer for
 * must not print to whatever queue a driver installer left behind.
 *
 * Entries are re-validated on the way out rather than trusted. Certification is
 * an operator action performed against the database, so a name that is not a
 * queue name is a typo to be ignored — and dropping it here is what stops one
 * bad row failing the registration response for the whole kiosk.
 */
export function readApprovedQueues(approvedQueues: readonly string[]): string[] {
  return approvedQueues
    .map((entry) => entry.trim())
    .filter((entry) => printerQueueNameSchema.safeParse(entry).success)
    .slice(0, 16);
}

function normalizeQueueName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function agentNotRegistered(): ApiError {
  return new ApiError(409, "AGENT_NOT_REGISTERED", "The agent must register before reporting.");
}

function agentClaimedElsewhere(): ApiError {
  return new ApiError(409, "AGENT_ALREADY_REGISTERED", "The agent belongs to another kiosk.");
}
