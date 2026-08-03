import {
  confirmPaymentResponseSchema,
  createPaymentResponseSchema,
  getPaymentResponseSchema,
  paymentFailureCodeSchema,
  paymentSnapshotSchema,
  type ConfirmPaymentResponse,
  type CreatePaymentResponse,
  type GetPaymentResponse,
  type PaymentFailureCode,
  type PaymentSnapshot,
  type PaymentStatus,
  type SessionState
} from "@printing-kiosk/contracts";
import { nextAttemptNumber, Prisma, type PrismaClient } from "@printing-kiosk/database";
import { SessionDomainError, transitionSession } from "@printing-kiosk/domain";
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderWebhookEvent
} from "@printing-kiosk/payment-adapters";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { digestIdempotencyKey, hashRequest } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { isRetryableTransactionError, isUniqueConstraintError } from "../sessions/transactions.js";

const OPEN_STATUSES: PaymentStatus[] = ["PENDING", "AUTHORIZED"];
const PROCESSING_FILE_STATUSES = ["UPLOADING", "QUARANTINED", "VALIDATING"];
const MAX_TRANSACTION_ATTEMPTS = 5;
/**
 * A payment window shorter than this is not worth opening: the customer would
 * be asked to present a card against a price that dies while they reach for
 * it. Asking for a fresh quote is the honest answer.
 */
const MINIMUM_PAYMENT_WINDOW_SECONDS = 30;

const DEFAULT_FAILURE_CODES: Readonly<Record<string, PaymentFailureCode>> = {
  PAYMENT_DECLINED: "CARD_DECLINED",
  PAYMENT_CANCELED: "CUSTOMER_CANCELED",
  PAYMENT_TIMED_OUT: "PROVIDER_TIMEOUT"
};

const FAILURE_STATUSES: Readonly<Record<string, PaymentStatus>> = {
  PAYMENT_DECLINED: "DECLINED",
  PAYMENT_CANCELED: "CANCELED",
  PAYMENT_TIMED_OUT: "TIMED_OUT"
};

export interface PaymentServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  provider: PaymentProvider;
  idempotencyPepper: string;
  idempotencyTtlHours: number;
  paymentTimeoutSeconds: number;
}

interface CreatePaymentInput {
  kioskId: string;
  credentialId: string;
  sessionId: string;
  quoteId: string;
  idempotencyKey: string;
  requestId: string;
}

interface ConfirmPaymentInput {
  kioskId: string;
  credentialId: string;
  paymentId: string;
  idempotencyKey: string;
  requestId: string;
}

interface WebhookInput {
  rawBody: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  requestId: string;
}

/**
 * Payment orchestration.
 *
 * Three rules hold everywhere in this file. A payment is only ever for the
 * exact amount of an unexpired quote the control plane issued. A capture is
 * only believed when it arrives as a verified provider callback. And no state
 * ever moves backwards: a late decline cannot undo a capture, and a capture
 * that arrives too late becomes money owed back rather than silence.
 */
export class PaymentService {
  public constructor(private readonly options: PaymentServiceOptions) {}

  public async create(input: CreatePaymentInput): Promise<CreatePaymentResponse> {
    const action = `payments.create:${input.sessionId}`;
    const requestHash = hashRequest({
      sessionId: input.sessionId,
      quoteId: input.quoteId,
      provider: this.options.provider.name
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
              // The stored body describes the moment the payment was created.
              // The customer needs to know where it stands now, so the row is
              // re-read rather than echoed.
              return createPaymentResponseSchema.parse({
                payment: await this.replayPayment(transaction, replay.resourceId, input.sessionId)
              });
            }

            const session = await transaction.printSession.findFirstOrThrow({
              where: { id: input.sessionId, kioskId: input.kioskId }
            });
            assertSessionPayable(session, now);

            const open = await transaction.payment.findFirst({
              where: { sessionId: session.id, status: { in: OPEN_STATUSES } },
              select: { id: true }
            });
            if (open) {
              throw new ApiError(409, "PAYMENT_IN_PROGRESS", "A payment is already in progress.", {
                paymentId: open.id
              });
            }

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

            const quote = await transaction.priceQuote.findFirst({
              where: { id: input.quoteId, sessionId: session.id }
            });
            if (!quote) throw new ApiError(404, "QUOTE_NOT_FOUND", "Quote not found.");
            if (
              quote.status !== "ACTIVE" ||
              session.activeQuoteId !== quote.id ||
              session.currentSettingsRevision !== quote.settingsRevision
            ) {
              throw new ApiError(409, "QUOTE_STALE", "This price is no longer current.", {
                quoteId: quote.id,
                quoteStatus: quote.status
              });
            }

            const deadline = new Date(
              Math.min(
                now.getTime() + this.options.paymentTimeoutSeconds * 1_000,
                quote.expiresAt.getTime(),
                session.idleExpiresAt.getTime(),
                session.hardExpiresAt.getTime()
              )
            );
            if (deadline.getTime() - now.getTime() < MINIMUM_PAYMENT_WINDOW_SECONDS * 1_000) {
              throw new ApiError(
                422,
                "QUOTE_EXPIRED",
                "This price has expired. Please try again.",
                {
                  quoteId: quote.id
                }
              );
            }

            const paymentId = this.options.random.uuid(now);
            const intent = await this.options.provider.createIntent({
              paymentId,
              sessionId: session.id,
              amount: {
                amountMinor: quote.totalMinor,
                currency: quote.currency.trim(),
                currencyExponent: quote.currencyExponent
              },
              idempotencyKey: `payment:${paymentId}:create`
            });

            const payment = await transaction.payment.create({
              data: {
                id: paymentId,
                sessionId: session.id,
                quoteId: quote.id,
                provider: this.options.provider.name,
                providerIntentId: intent.providerIntentId,
                status: intent.status === "AUTHORIZED" ? "AUTHORIZED" : "PENDING",
                amountMinor: quote.totalMinor,
                currency: quote.currency.trim(),
                currencyExponent: quote.currencyExponent,
                settingsRevision: quote.settingsRevision,
                manifestHash: quote.manifestHash,
                createdByActorType: "KIOSK",
                createdByActorId: input.credentialId,
                expiresAt: deadline,
                createdAt: now,
                updatedAt: now,
                ...(intent.status === "AUTHORIZED" ? { authorizedAt: now } : {})
              }
            });

            const next = transitionSession(
              { state: session.state as SessionState, version: session.stateVersion },
              "AWAITING_PAYMENT",
              session.stateVersion
            );
            const nextSequence = session.eventSequence + 1;
            const locked = await transaction.printSession.updateMany({
              where: { id: session.id, stateVersion: session.stateVersion },
              data: {
                state: next.state,
                stateVersion: next.version,
                eventSequence: nextSequence,
                updatedAt: now
              }
            });
            if (locked.count !== 1) {
              throw new ApiError(
                409,
                "CONCURRENT_SESSION_UPDATE",
                "The session changed concurrently. Please retry."
              );
            }

            const response = createPaymentResponseSchema.parse({
              payment: toPaymentSnapshot(payment)
            });

            await Promise.all([
              transaction.paymentAttempt.create({
                data: {
                  id: this.options.random.uuid(now),
                  paymentId: payment.id,
                  attempt: 1,
                  action: "CREATE",
                  status: payment.status,
                  providerReference: payment.providerIntentId,
                  idempotencyKeyDigest: this.keyDigest(input.kioskId, action, input.idempotencyKey),
                  createdAt: now
                }
              }),
              transaction.outboxEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  aggregateType: "PRINT_SESSION",
                  aggregateId: session.id,
                  sequence: nextSequence,
                  type: "payment.pending",
                  payload: {
                    sessionId: session.id,
                    paymentId: payment.id,
                    quoteId: quote.id,
                    state: next.state,
                    version: next.version,
                    currency: payment.currency.trim(),
                    currencyExponent: payment.currencyExponent,
                    amountMinor: payment.amountMinor,
                    expiresAt: payment.expiresAt.toISOString()
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
                  action: "payment.created",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: {
                    paymentId: payment.id,
                    quoteId: quote.id,
                    amountMinor: payment.amountMinor,
                    currency: payment.currency.trim()
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
                resourceId: payment.id,
                now
              })
            ]);

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw mapPaymentError(error);
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The session changed concurrently. Please retry."
    );
  }

  public async confirm(input: ConfirmPaymentInput): Promise<ConfirmPaymentResponse> {
    const action = `payments.confirm:${input.paymentId}`;
    const requestHash = hashRequest({ paymentId: input.paymentId });

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            const now = this.options.clock.now();
            const existing = await transaction.payment.findFirst({
              where: { id: input.paymentId, session: { kioskId: input.kioskId } },
              select: { id: true, sessionId: true }
            });
            if (!existing) throw paymentNotFound();
            await lockSession(transaction, existing.sessionId, input.kioskId);

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
              return confirmPaymentResponseSchema.parse({
                payment: await this.replayPayment(
                  transaction,
                  replay.resourceId,
                  existing.sessionId
                )
              });
            }

            const payment = await transaction.payment.findUniqueOrThrow({
              where: { id: existing.id }
            });
            // A capture that already arrived is a success, not a conflict: the
            // kiosk simply confirmed something the provider had settled.
            if (payment.status !== "CAPTURED") {
              if (!OPEN_STATUSES.includes(payment.status as PaymentStatus)) {
                throw new ApiError(409, "PAYMENT_NOT_PENDING", "This payment is already settled.", {
                  status: payment.status
                });
              }
              if (now.getTime() >= payment.expiresAt.getTime()) {
                throw new ApiError(409, "PAYMENT_EXPIRED", "This payment window has closed.");
              }

              const confirmed = await this.options.provider.confirm(
                payment.providerIntentId,
                `payment:${payment.id}:confirm`
              );
              if (confirmed.status === "AUTHORIZED" && payment.status === "PENDING") {
                await transaction.payment.updateMany({
                  where: { id: payment.id, status: "PENDING" },
                  data: { status: "AUTHORIZED", authorizedAt: now, updatedAt: now }
                });
              }
              await transaction.paymentAttempt.create({
                data: {
                  id: this.options.random.uuid(now),
                  paymentId: payment.id,
                  attempt: await nextAttemptNumber(transaction, payment.id),
                  action: "CONFIRM",
                  status: confirmed.status === "AUTHORIZED" ? "AUTHORIZED" : "PENDING",
                  providerReference: payment.providerIntentId,
                  idempotencyKeyDigest: this.keyDigest(input.kioskId, action, input.idempotencyKey),
                  createdAt: now
                }
              });
            }

            const current = await transaction.payment.findUniqueOrThrow({
              where: { id: payment.id }
            });
            const response = confirmPaymentResponseSchema.parse({
              payment: toPaymentSnapshot(current)
            });

            await Promise.all([
              transaction.auditEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  occurredAt: now,
                  actorType: "KIOSK",
                  actorId: input.credentialId,
                  kioskId: input.kioskId,
                  sessionId: current.sessionId,
                  action: "payment.confirmed",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: { paymentId: current.id, status: current.status }
                }
              }),
              this.storeReplay(transaction, {
                actorId: input.kioskId,
                action,
                idempotencyKey: input.idempotencyKey,
                requestHash,
                responseStatus: 200,
                response,
                resourceId: current.id,
                now
              })
            ]);

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw mapPaymentError(error);
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The session changed concurrently. Please retry."
    );
  }

  public async get(input: { kioskId: string; paymentId: string }): Promise<GetPaymentResponse> {
    const payment = await this.options.database.payment.findFirst({
      where: { id: input.paymentId, session: { kioskId: input.kioskId } }
    });
    // A foreign kiosk is told the payment does not exist rather than that it
    // exists and belongs to somebody else.
    if (!payment) throw paymentNotFound();

    return getPaymentResponseSchema.parse({ payment: toPaymentSnapshot(payment) });
  }

  /**
   * Process a provider callback. The signature is verified over the exact bytes
   * received, the event is recorded before it is acted on, and a duplicate
   * delivery is acknowledged without doing anything a second time.
   */
  public async handleWebhook(input: WebhookInput): Promise<void> {
    let event: ProviderWebhookEvent;
    try {
      event = await this.options.provider.verifyAndParseWebhook(
        input.rawBody,
        input.headers,
        this.options.clock.now()
      );
    } catch (error) {
      // The provider is told only that the callback was not accepted. Which
      // check failed is an internal detail an unauthenticated caller must not
      // be able to probe.
      if (isProviderError(error)) {
        throw new ApiError(401, "INVALID_WEBHOOK_SIGNATURE", "The callback could not be verified.");
      }
      throw error;
    }

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        await this.options.database.$transaction(
          async (transaction) => {
            await this.reduceWebhookEvent(transaction, event, input.requestId);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        return;
      } catch (error) {
        // Only an inbox collision is a duplicate delivery. Treating every
        // unique-constraint failure as a duplicate would acknowledge a
        // callback whose transaction actually rolled back for another
        // accounting invariant.
        if (isUniqueConstraintError(error) && (await this.webhookWasRecorded(event))) return;
        if (isRetryableTransactionError(error)) continue;
        throw error;
      }
    }

    throw new ApiError(503, "PAYMENT_CALLBACK_CONTENDED", "The callback could not be processed.");
  }

  private async reduceWebhookEvent(
    transaction: Prisma.TransactionClient,
    event: ProviderWebhookEvent,
    requestId: string
  ): Promise<void> {
    const now = this.options.clock.now();
    const provider = this.options.provider.name;
    const duplicate = await transaction.paymentWebhookInbox.findUnique({
      where: {
        provider_providerEventId: { provider, providerEventId: event.providerEventId }
      },
      select: { id: true }
    });
    if (duplicate) return;

    const known = await transaction.payment.findFirst({
      where: { provider, providerIntentId: event.providerIntentId },
      select: { id: true, sessionId: true }
    });
    if (!known) {
      await this.recordWebhook(transaction, event, null, "IGNORED_UNKNOWN_INTENT", now);
      return;
    }

    // The session row is the lock every payment transition takes, so a capture
    // and a cancellation cannot interleave.
    await lockSessionRow(transaction, known.sessionId);
    const payment = await transaction.payment.findUniqueOrThrow({ where: { id: known.id } });

    if (
      event.amount.amountMinor !== payment.amountMinor ||
      event.amount.currency !== payment.currency.trim() ||
      event.amount.currencyExponent !== payment.currencyExponent
    ) {
      // The provider settled something other than the quoted total. It cannot
      // fulfil the session, but it is still a real capture and must close the
      // local intent; leaving it open would strand the manifest because the
      // reconciler will continue to observe CAPTURED upstream.
      if (event.type === "PAYMENT_CAPTURED") {
        if (payment.status !== "CAPTURED" && payment.status !== "DECLINED") {
          const recorded = await transaction.payment.updateMany({
            where: { id: payment.id, status: payment.status },
            data: {
              status: "CAPTURED",
              appliedToSession: false,
              capturedAt: now,
              updatedAt: now
            }
          });
          if (recorded.count !== 1) throw new Error("PAYMENT_MISMATCH_CAPTURE_LOST_RACE");
        }
        await transaction.paymentAttempt.create({
          data: {
            id: this.options.random.uuid(now),
            paymentId: payment.id,
            attempt: await nextAttemptNumber(transaction, payment.id),
            action: "CAPTURE",
            status: "CAPTURED",
            providerReference: event.providerEventId,
            createdAt: now
          }
        });
        await this.recordCompensation(transaction, payment, "AMOUNT_MISMATCH", event.amount, now);
        const session = await transaction.printSession.findUniqueOrThrow({
          where: { id: payment.sessionId }
        });
        await this.releaseAfterCompensatedCapture(
          transaction,
          payment,
          session,
          "AMOUNT_MISMATCH",
          now
        );
      }
      await this.recordWebhook(transaction, event, payment.id, "AMOUNT_MISMATCH", now);
      await this.recordPaymentAudit(transaction, {
        payment,
        action: "payment.amount_mismatch",
        outcome: "REFUSED",
        requestId,
        now,
        metadata: {
          providerEventId: event.providerEventId,
          amountMinor: event.amount.amountMinor,
          currency: event.amount.currency,
          currencyExponent: event.amount.currencyExponent
        }
      });
      return;
    }

    if (event.type === "PAYMENT_CAPTURED") {
      await this.applyCapture(transaction, payment, event, requestId, now);
      return;
    }
    await this.applyFailure(transaction, payment, event, requestId, now);
  }

  private async applyCapture(
    transaction: Prisma.TransactionClient,
    payment: StoredPayment,
    event: ProviderWebhookEvent,
    requestId: string,
    now: Date
  ): Promise<void> {
    if (payment.status === "CAPTURED") {
      await this.recordWebhook(transaction, event, payment.id, "DUPLICATE_CAPTURE", now);
      return;
    }

    const session = await transaction.printSession.findUniqueOrThrow({
      where: { id: payment.sessionId }
    });
    const quote = await transaction.priceQuote.findFirst({
      where: { id: payment.quoteId, sessionId: payment.sessionId }
    });
    const effective =
      OPEN_STATUSES.includes(payment.status as PaymentStatus) &&
      session.state === "AWAITING_PAYMENT" &&
      payment.expiresAt.getTime() > now.getTime() &&
      quote !== null &&
      quote.status === "ACTIVE" &&
      quote.expiresAt.getTime() > now.getTime();

    if (!effective) {
      // Money moved for something this session can no longer deliver against.
      // A declined payment keeps its status — the trigger refuses to rewrite
      // it — but the obligation is recorded either way.
      if (payment.status !== "DECLINED") {
        const recorded = await transaction.payment.updateMany({
          where: { id: payment.id, status: payment.status },
          data: {
            status: "CAPTURED",
            appliedToSession: false,
            capturedAt: now,
            updatedAt: now
          }
        });
        if (recorded.count !== 1) throw new Error("PAYMENT_LATE_CAPTURE_LOST_RACE");
      }
      await transaction.paymentAttempt.create({
        data: {
          id: this.options.random.uuid(now),
          paymentId: payment.id,
          attempt: await nextAttemptNumber(transaction, payment.id),
          action: "CAPTURE",
          status: "CAPTURED",
          providerReference: event.providerEventId,
          createdAt: now
        }
      });
      await this.recordCompensation(transaction, payment, "LATE_CAPTURE", event.amount, now);
      await this.recordWebhook(transaction, event, payment.id, "LATE_CAPTURE", now);
      await this.releaseAfterCompensatedCapture(
        transaction,
        payment,
        session,
        "PROVIDER_TIMEOUT",
        now
      );
      await this.recordPaymentAudit(transaction, {
        payment,
        action: "payment.late_capture",
        outcome: "RECOVERY_REQUIRED",
        requestId,
        now,
        metadata: { sessionState: session.state, providerEventId: event.providerEventId }
      });
      return;
    }

    const captured = await transaction.payment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: {
        status: "CAPTURED",
        appliedToSession: true,
        capturedAt: now,
        updatedAt: now
      }
    });
    if (captured.count !== 1) throw new Error("PAYMENT_CAPTURE_LOST_RACE");

    const consumed = await transaction.priceQuote.updateMany({
      where: { id: payment.quoteId, sessionId: payment.sessionId, status: "ACTIVE" },
      data: { status: "CONSUMED" }
    });
    if (consumed.count !== 1) throw new Error("QUOTE_CONSUMPTION_LOST_RACE");

    const next = transitionSession(
      { state: session.state as SessionState, version: session.stateVersion },
      "PAID",
      session.stateVersion
    );
    const nextSequence = session.eventSequence + 1;
    const paid = await transaction.printSession.updateMany({
      where: { id: session.id, stateVersion: session.stateVersion },
      data: {
        state: next.state,
        stateVersion: next.version,
        eventSequence: nextSequence,
        updatedAt: now
      }
    });
    if (paid.count !== 1) throw new Error("SESSION_PAID_LOST_RACE");

    await Promise.all([
      transaction.paymentAttempt.create({
        data: {
          id: this.options.random.uuid(now),
          paymentId: payment.id,
          attempt: await nextAttemptNumber(transaction, payment.id),
          action: "CAPTURE",
          status: "CAPTURED",
          providerReference: event.providerEventId,
          createdAt: now
        }
      }),
      transaction.outboxEvent.create({
        data: {
          id: this.options.random.uuid(now),
          aggregateType: "PRINT_SESSION",
          aggregateId: session.id,
          sequence: nextSequence,
          type: "payment.succeeded",
          payload: {
            sessionId: session.id,
            paymentId: payment.id,
            quoteId: payment.quoteId,
            state: next.state,
            version: next.version,
            currency: payment.currency.trim(),
            currencyExponent: payment.currencyExponent,
            amountMinor: payment.amountMinor,
            capturedAt: now.toISOString()
          }
        }
      }),
      this.recordWebhook(transaction, event, payment.id, "CAPTURED", now),
      this.recordPaymentAudit(transaction, {
        payment,
        action: "payment.captured",
        outcome: "SUCCESS",
        requestId,
        now,
        metadata: { quoteId: payment.quoteId, amountMinor: payment.amountMinor }
      })
    ]);
  }

  private async applyFailure(
    transaction: Prisma.TransactionClient,
    payment: StoredPayment,
    event: ProviderWebhookEvent,
    requestId: string,
    now: Date
  ): Promise<void> {
    if (!OPEN_STATUSES.includes(payment.status as PaymentStatus)) {
      // Monotonic by construction: a late decline never rewrites a capture or
      // a settled failure.
      await this.recordWebhook(transaction, event, payment.id, "IGNORED_TERMINAL_PAYMENT", now);
      return;
    }

    const status = FAILURE_STATUSES[event.type] ?? "DECLINED";
    const failureCode = readFailureCode(event);
    const failed = await transaction.payment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: { status, failureCode, failedAt: now, updatedAt: now }
    });
    if (failed.count !== 1) throw new Error("PAYMENT_FAILURE_LOST_RACE");

    await transaction.paymentAttempt.create({
      data: {
        id: this.options.random.uuid(now),
        paymentId: payment.id,
        attempt: await nextAttemptNumber(transaction, payment.id),
        action: "CAPTURE",
        status,
        providerReference: event.providerEventId,
        failureCode,
        createdAt: now
      }
    });

    const session = await transaction.printSession.findUniqueOrThrow({
      where: { id: payment.sessionId }
    });
    if (session.state === "AWAITING_PAYMENT") {
      // The lock over the manifest is released, so the customer can adjust
      // their settings or simply try to pay again against the same price.
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
      if (released.count !== 1) throw new Error("SESSION_RELEASE_LOST_RACE");

      await transaction.outboxEvent.create({
        data: {
          id: this.options.random.uuid(now),
          aggregateType: "PRINT_SESSION",
          aggregateId: session.id,
          sequence: nextSequence,
          type: "payment.failed",
          payload: {
            sessionId: session.id,
            paymentId: payment.id,
            state: next.state,
            version: next.version,
            status,
            failureCode
          }
        }
      });
    }

    await Promise.all([
      this.recordWebhook(transaction, event, payment.id, "FAILED", now),
      this.recordPaymentAudit(transaction, {
        payment,
        action: "payment.failed",
        outcome: "FAILURE",
        requestId,
        now,
        metadata: { status, failureCode }
      })
    ]);
  }

  private async recordWebhook(
    transaction: Prisma.TransactionClient,
    event: ProviderWebhookEvent,
    paymentId: string | null,
    result: string,
    now: Date
  ): Promise<void> {
    await transaction.paymentWebhookInbox.create({
      data: {
        id: this.options.random.uuid(now),
        provider: this.options.provider.name,
        providerEventId: event.providerEventId,
        providerIntentId: event.providerIntentId,
        ...(paymentId ? { paymentId } : {}),
        eventType: event.type,
        payloadDigest: event.payloadDigest,
        result,
        receivedAt: now,
        processedAt: now
      }
    });
  }

  private async recordCompensation(
    transaction: Prisma.TransactionClient,
    payment: StoredPayment,
    reason: "LATE_CAPTURE" | "AMOUNT_MISMATCH",
    amount: { amountMinor: number; currency: string; currencyExponent: number },
    now: Date
  ): Promise<void> {
    // A provider report that it captured zero is still retained in the inbox
    // and audit trail, but there is no money to return and the refunds table
    // deliberately represents monetary obligations only.
    if (amount.amountMinor === 0) return;

    // One obligation per payment and reason. A repeated delivery of the same
    // problem must not create a second refund.
    await transaction.refund.upsert({
      where: { paymentId_reason: { paymentId: payment.id, reason } },
      create: {
        id: this.options.random.uuid(now),
        paymentId: payment.id,
        sessionId: payment.sessionId,
        provider: payment.provider,
        reason,
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        currencyExponent: amount.currencyExponent,
        status: "PENDING",
        createdAt: now,
        updatedAt: now
      },
      update: {}
    });
  }

  /**
   * A callback can beat the timeout reconciler. If the payment window has
   * already closed but the session is still waiting, the compensated capture
   * must release that session itself; otherwise the payment is no longer open
   * and no worker will ever unlock the customer workflow.
   */
  private async releaseAfterCompensatedCapture(
    transaction: Prisma.TransactionClient,
    payment: StoredPayment,
    session: {
      id: string;
      state: string;
      stateVersion: number;
      eventSequence: number;
    },
    failureCode: PaymentFailureCode,
    now: Date
  ): Promise<void> {
    if (session.state !== "AWAITING_PAYMENT") return;

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
    if (released.count !== 1) throw new Error("SESSION_RELEASE_LOST_RACE");

    await transaction.outboxEvent.create({
      data: {
        id: this.options.random.uuid(now),
        aggregateType: "PRINT_SESSION",
        aggregateId: session.id,
        sequence: nextSequence,
        type: "payment.failed",
        payload: {
          sessionId: session.id,
          paymentId: payment.id,
          state: next.state,
          version: next.version,
          status: "CAPTURED",
          failureCode
        }
      }
    });
  }

  private async webhookWasRecorded(event: ProviderWebhookEvent): Promise<boolean> {
    const recorded = await this.options.database.paymentWebhookInbox.findUnique({
      where: {
        provider_providerEventId: {
          provider: this.options.provider.name,
          providerEventId: event.providerEventId
        }
      },
      select: { id: true }
    });
    return recorded !== null;
  }

  private async recordPaymentAudit(
    transaction: Prisma.TransactionClient,
    input: {
      payment: StoredPayment;
      action: string;
      outcome: string;
      requestId: string;
      now: Date;
      metadata: Record<string, string | number>;
    }
  ): Promise<void> {
    await transaction.auditEvent.create({
      data: {
        id: this.options.random.uuid(input.now),
        occurredAt: input.now,
        actorType: "PROVIDER",
        actorId: input.payment.provider,
        sessionId: input.payment.sessionId,
        action: input.action,
        outcome: input.outcome,
        requestId: input.requestId,
        metadata: { paymentId: input.payment.id, ...input.metadata }
      }
    });
  }

  private async replayPayment(
    transaction: Prisma.TransactionClient,
    resourceId: string | null,
    sessionId: string
  ): Promise<PaymentSnapshot> {
    const payment = resourceId
      ? await transaction.payment.findFirst({ where: { id: resourceId, sessionId } })
      : null;
    if (!payment) {
      throw new ApiError(
        409,
        "PAYMENT_REPLAY_UNAVAILABLE",
        "The previous payment is no longer available."
      );
    }
    return toPaymentSnapshot(payment);
  }

  private async storeReplay(
    transaction: Prisma.TransactionClient,
    input: {
      actorId: string;
      action: string;
      idempotencyKey: string;
      requestHash: string;
      responseStatus: number;
      response: CreatePaymentResponse | ConfirmPaymentResponse;
      resourceId: string;
      now: Date;
    }
  ): Promise<void> {
    await transaction.idempotencyRecord.create({
      data: {
        id: this.options.random.uuid(input.now),
        actorId: input.actorId,
        action: input.action,
        keyDigest: this.keyDigest(input.actorId, input.action, input.idempotencyKey),
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        responseBody: input.response,
        resourceId: input.resourceId,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + this.options.idempotencyTtlHours * 3_600_000)
      }
    });
  }

  private keyDigest(actorId: string, action: string, key: string): string {
    return digestIdempotencyKey(actorId, action, key, this.options.idempotencyPepper);
  }
}

interface StoredPayment {
  id: string;
  sessionId: string;
  quoteId: string;
  provider: string;
  providerIntentId: string;
  status: string;
  appliedToSession: boolean;
  amountMinor: number;
  currency: string;
  currencyExponent: number;
  failureCode: string | null;
  expiresAt: Date;
  createdAt: Date;
  capturedAt: Date | null;
}

export function toPaymentSnapshot(payment: StoredPayment): PaymentSnapshot {
  const failureCode = paymentFailureCodeSchema.safeParse(payment.failureCode);
  return paymentSnapshotSchema.parse({
    id: payment.id,
    sessionId: payment.sessionId,
    quoteId: payment.quoteId,
    provider: payment.provider,
    status: payment.status,
    appliedToSession: payment.appliedToSession,
    amountMinor: payment.amountMinor,
    currency: payment.currency.trim(),
    currencyExponent: payment.currencyExponent,
    failureCode: failureCode.success ? failureCode.data : null,
    createdAt: payment.createdAt.toISOString(),
    expiresAt: payment.expiresAt.toISOString(),
    capturedAt: payment.capturedAt?.toISOString() ?? null
  });
}

function readFailureCode(event: ProviderWebhookEvent): PaymentFailureCode {
  const parsed = paymentFailureCodeSchema.safeParse(event.failureCode);
  return parsed.success ? parsed.data : (DEFAULT_FAILURE_CODES[event.type] ?? "CARD_DECLINED");
}

function assertSessionPayable(
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
  if (session.state === "PAID" || session.state === "PRINTING") {
    throw new ApiError(409, "PAYMENT_ALREADY_CAPTURED", "This session is already paid.", {
      currentState: session.state
    });
  }
  if (session.state !== "CONFIGURING") {
    throw new ApiError(409, "INVALID_SESSION_STATE", "This session cannot take a payment yet.", {
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

async function lockSessionRow(
  transaction: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await transaction.$queryRaw`
    SELECT "id" FROM "print_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;
}

/**
 * A provider adapter failure. The name is checked as well as the class: an
 * adapter loaded through a second module instance — a test harness importing
 * the package source, for instance — must not turn a provider outage into an
 * unhandled server error.
 */
function isProviderError(error: unknown): boolean {
  return (
    error instanceof PaymentProviderError ||
    (error instanceof Error && error.name === "PaymentProviderError")
  );
}

function paymentNotFound(): ApiError {
  return new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
}

function mapPaymentError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof SessionDomainError) {
    return new ApiError(409, error.code, "This session transition is not allowed.", error.details);
  }
  if (isProviderError(error)) {
    // Whatever the provider's own reason was, the customer is told only that
    // payment cannot start right now.
    return new ApiError(503, "PAYMENT_UNAVAILABLE", "Payment is temporarily unavailable.");
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") return paymentNotFound();
    if (error.code === "P2002") {
      return new ApiError(409, "PAYMENT_IN_PROGRESS", "A payment is already in progress.");
    }
  }
  return error;
}
