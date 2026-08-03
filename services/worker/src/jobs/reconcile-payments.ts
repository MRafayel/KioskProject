import { randomUUID } from "node:crypto";

import { nextAttemptNumber, Prisma, type PrismaClient } from "@printing-kiosk/database";
import { transitionSession } from "@printing-kiosk/domain";
import type { PaymentProvider } from "@printing-kiosk/payment-adapters";

const DEFAULT_INTERVAL_MS = 5_000;
const BATCH_SIZE = 25;
const OPEN_STATUSES = ["PENDING", "AUTHORIZED"];

export interface PaymentReconcilerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PaymentReconcilerOptions {
  database: PrismaClient;
  provider: PaymentProvider;
  logger: PaymentReconcilerLogger;
  intervalMilliseconds?: number;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Settles payments whose window has closed.
 *
 * A customer who walks away leaves an open provider intent and a session that
 * cannot be configured or cancelled by anyone else. This reconciler is what
 * ends that: past its deadline a payment becomes TIMED_OUT and the session
 * returns to CONFIGURING with its price still live, so the next attempt costs
 * the same.
 *
 * It never invents a capture. Only a verified provider callback moves money,
 * so an intent the provider still reports as live is left alone and recorded
 * for an operator rather than guessed at.
 */
export class PaymentReconciler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(private readonly options: PaymentReconcilerOptions) {}

  public start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMilliseconds ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.runOnce(), interval);
    this.timer.unref?.();
    void this.runOnce();
  }

  public close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return Promise.resolve();
  }

  public async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let settled = 0;
    try {
      const now = this.now();
      const overdue = await this.options.database.payment.findMany({
        where: { status: { in: OPEN_STATUSES }, expiresAt: { lte: now } },
        orderBy: { expiresAt: "asc" },
        take: BATCH_SIZE,
        select: { id: true, providerIntentId: true }
      });

      for (const candidate of overdue) {
        try {
          // The provider is asked outside the transaction: a network call must
          // never be made while a session row is locked.
          const reported = await this.options.provider.getIntentStatus(candidate.providerIntentId);
          if (reported === "CAPTURED" || reported === "AUTHORIZED") {
            await this.recordUnsettled(candidate.id, reported);
            continue;
          }
          if (await this.timeOut(candidate.id)) settled += 1;
        } catch (error) {
          this.options.logger.warn(
            { paymentId: candidate.id, errorName: errorName(error) },
            "payment reconciliation attempt failed"
          );
        }
      }
    } catch (error) {
      this.options.logger.warn({ errorName: errorName(error) }, "payment reconciliation failed");
    } finally {
      this.running = false;
    }
    return settled;
  }

  private async timeOut(paymentId: string): Promise<boolean> {
    return this.options.database.$transaction(
      async (transaction) => {
        const now = this.now();
        const payment = await transaction.payment.findUnique({ where: { id: paymentId } });
        if (!payment || !OPEN_STATUSES.includes(payment.status)) return false;
        if (payment.expiresAt.getTime() > now.getTime()) return false;

        await transaction.$queryRaw`
          SELECT "id" FROM "print_sessions" WHERE "id" = ${payment.sessionId}::uuid FOR UPDATE
        `;

        const settled = await transaction.payment.updateMany({
          where: { id: payment.id, status: payment.status },
          data: {
            status: "TIMED_OUT",
            failureCode: "PROVIDER_TIMEOUT",
            failedAt: now,
            updatedAt: now
          }
        });
        // A callback captured it between the read and the write. That capture
        // is authoritative and this pass simply does nothing.
        if (settled.count !== 1) return false;

        await transaction.paymentAttempt.create({
          data: {
            id: this.newId(),
            paymentId: payment.id,
            attempt: await nextAttemptNumber(transaction, payment.id),
            action: "RECONCILE",
            status: "TIMED_OUT",
            providerReference: payment.providerIntentId,
            failureCode: "PROVIDER_TIMEOUT",
            createdAt: now
          }
        });

        const session = await transaction.printSession.findUniqueOrThrow({
          where: { id: payment.sessionId }
        });
        if (session.state === "AWAITING_PAYMENT") {
          const next = transitionSession(
            { state: "AWAITING_PAYMENT", version: session.stateVersion },
            "CONFIGURING",
            session.stateVersion
          );
          const nextSequence = session.eventSequence + 1;
          const released = await transaction.printSession.updateMany({
            where: { id: session.id, stateVersion: session.stateVersion },
            data: {
              state: next.state,
              stateVersion: next.version,
              eventSequence: nextSequence,
              updatedAt: now
            }
          });
          if (released.count !== 1) return false;

          await transaction.outboxEvent.create({
            data: {
              id: this.newId(),
              aggregateType: "PRINT_SESSION",
              aggregateId: session.id,
              sequence: nextSequence,
              type: "payment.failed",
              payload: {
                sessionId: session.id,
                paymentId: payment.id,
                state: next.state,
                version: next.version,
                status: "TIMED_OUT",
                failureCode: "PROVIDER_TIMEOUT"
              }
            }
          });
        }

        await transaction.auditEvent.create({
          data: {
            id: this.newId(),
            occurredAt: now,
            actorType: "SYSTEM",
            actorId: "payment-reconciler",
            sessionId: payment.sessionId,
            action: "payment.timed_out",
            outcome: "SUCCESS",
            metadata: { paymentId: payment.id, previousStatus: payment.status }
          }
        });

        this.options.logger.info(
          { paymentId: payment.id, sessionId: payment.sessionId },
          "payment timed out"
        );
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  /**
   * The provider still believes the intent can settle. Nothing is decided here
   * — the evidence is written so the state is visible rather than silent.
   */
  private async recordUnsettled(paymentId: string, reported: string): Promise<void> {
    const now = this.now();
    await this.options.database.$transaction(async (transaction) => {
      const payment = await transaction.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true }
      });
      if (!payment || !OPEN_STATUSES.includes(payment.status)) return;
      // One record per payment, not one per pass: this runs every few seconds
      // and the evidence must not grow without bound while an intent stays
      // live at the provider.
      const recorded = await transaction.paymentAttempt.findFirst({
        where: { paymentId, action: "RECONCILE" },
        select: { id: true }
      });
      if (recorded) return;
      await transaction.paymentAttempt.create({
        data: {
          id: this.newId(),
          paymentId,
          attempt: await nextAttemptNumber(transaction, paymentId),
          action: "RECONCILE",
          status: "PENDING",
          failureCode: null,
          createdAt: now
        }
      });
    });

    this.options.logger.warn(
      { paymentId, reported },
      "overdue payment still live at the provider; awaiting a verified callback"
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private newId(): string {
    return this.options.newId?.() ?? randomUUID();
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
