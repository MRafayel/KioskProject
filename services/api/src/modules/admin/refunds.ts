import { createHash } from "node:crypto";

import {
  REFUND_AUTHORIZATION_REASON,
  type AdminRefundAuthorization,
  type AuthorizeRefundBody,
  type AuthorizeRefundResponse,
  type RecoveryOutcome
} from "@printing-kiosk/admin-access";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { writeAdminAuditEvent, type AdminAuditMetadataValue } from "./audit.js";
import { adminNotFound } from "./http.js";
import type { AdminRefundDatabase, AdminRefundTransaction } from "./refund-database.js";
import type { AuthenticatedAdmin } from "./service.js";

/**
 * The one thing the control plane can do that costs money.
 *
 * This file is separate from `operations.ts` on purpose, and the separation is
 * the Phase 4 gate rather than a filing preference. The observation path and
 * the money path share no service, no connection, and no database role: an
 * Operator records what they saw at a tray through
 * `printing_kiosk_admin_writer`, which holds no grant on `refunds` at all, and
 * an Admin turns that into an obligation through
 * `printing_kiosk_admin_refund_writer`, which holds no grant to record an
 * observation. Neither can do the other's half, and that is enforced by
 * PostgreSQL rather than by this paragraph.
 *
 * Three things this cannot do, in descending order of how much they matter:
 *
 *   1. **Pay anybody.** It raises an obligation at `PENDING`. Money moves when
 *      an executor holding a payment-provider credential settles it, and the
 *      control plane holds no such credential — there is no provider client in
 *      this module and no way to reach one.
 *   2. **Settle or withdraw an obligation.** No UPDATE on `refunds` anywhere in
 *      the role, so the panel cannot mark a payout complete, attach a provider
 *      reference to it, or quietly close one that was never honoured.
 *   3. **Manufacture its own justification.** No INSERT on
 *      `print_job_recovery_resolutions`, so the connection that authorizes a
 *      refund cannot write the observation it cites as the reason.
 */

/** How long an authorization's transaction may hold the database. */
const AUTHORIZATION_TRANSACTION_TIMEOUT_MILLISECONDS = 5_000;

export interface AdminRefundServiceOptions {
  database: AdminRefundDatabase;
  clock: Clock;
  random: RandomSource;
}

export class AdminRefundService {
  public constructor(private readonly options: AdminRefundServiceOptions) {}

  /**
   * Record that a customer is owed money for a print that did not come out.
   *
   * Most of what follows is refusal, in the same shape as every other action:
   * re-read the world inside the transaction that will write, answer 404 where
   * a 403 would confirm that an identifier names something real, and write the
   * fact and its audit event together so there is no ordering in which one
   * exists without the other.
   *
   * What is specific to money is the arithmetic, and it is all done here rather
   * than accepted from the client. The currency comes from the capture. The
   * ceiling is what that capture actually took, less everything already owed on
   * it. The amount itself is the one number a person supplies, because how much
   * a half-finished print owes is a judgement — and an amount the system
   * insisted on would be an amount nobody took responsibility for.
   */
  public async authorizeRefund(
    admin: AuthenticatedAdmin,
    printJobId: string,
    body: AuthorizeRefundBody,
    requestId: string
  ): Promise<AuthorizeRefundResponse> {
    const now = this.options.clock.now();
    const digest = digestAuthorizationRequest(body);

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const job = await transaction.printJob.findFirst({
            where: { id: printJobId },
            select: {
              id: true,
              sessionId: true,
              kioskId: true,
              paymentId: true,
              status: true,
              sheetsProduced: true,
              physicalSheets: true
            }
          });

          // No kiosk scoping check here, and its absence is deliberate: no
          // Operator holds `refund.authorize`, so there is no scoped role to
          // scope. If that ever changes, this is the line that has to change
          // with it — which is why it says so rather than saying nothing.
          if (!job) {
            throw new RefusedAuthorization(adminNotFound(), {
              failureCode: "NOT_FOUND",
              reason: body.reason,
              printJobId
            });
          }

          // An authorization already recorded is the idempotency boundary, by a
          // unique index on the print job rather than a record with a TTL. A
          // resubmitted form replays; a different amount or a different account
          // of why is a conflict a person needs to see, not a second payout.
          const existing = await transaction.refundAuthorization.findUnique({
            where: { printJobId },
            select: AUTHORIZATION_FIELDS
          });

          if (existing) {
            if (existing.requestDigest !== digest) {
              throw new RefusedAuthorization(
                new ApiError(
                  409,
                  "REFUND_ALREADY_AUTHORIZED",
                  "A refund has already been authorized for this print. Reload to see it."
                ),
                {
                  failureCode: "ALREADY_AUTHORIZED",
                  reason: body.reason,
                  printJobId,
                  kioskId: job.kioskId,
                  sessionId: job.sessionId,
                  amountMinor: body.amountMinor
                }
              );
            }

            return {
              authorization: await this.present(transaction, existing, "PENDING"),
              replayed: true,
              settled: false as const
            };
          }

          if (job.status !== "RECOVERY_REQUIRED") {
            throw new RefusedAuthorization(
              new ApiError(
                409,
                "PRINT_JOB_NOT_IN_RECOVERY",
                "This print is not in recovery, so nothing is owed through this route."
              ),
              {
                failureCode: "NOT_IN_RECOVERY",
                reason: body.reason,
                printJobId,
                kioskId: job.kioskId,
                sessionId: job.sessionId,
                previousState: job.status
              }
            );
          }

          // The evidence. A refund authorized against no observation at all is
          // an Admin deciding alone that a customer is owed money, which is
          // exactly the thing the split between these two capabilities exists
          // to prevent.
          const observation = await this.effectiveObservation(transaction, printJobId);
          if (!observation) {
            throw new RefusedAuthorization(
              new ApiError(
                409,
                "PRINT_RECOVERY_NOT_RESOLVED",
                "Nobody has recorded what happened to this print yet. It needs an observation first."
              ),
              {
                failureCode: "NOT_RESOLVED",
                reason: body.reason,
                printJobId,
                kioskId: job.kioskId,
                sessionId: job.sessionId
              }
            );
          }

          // `DELIVERED` is the one account that cannot justify a payout. Every
          // other outcome can: two of them suggest a refund outright, and
          // `UNRESOLVABLE` is precisely the case this capability exists for —
          // somebody with more authority deciding what to do when nobody could
          // tell what happened.
          if (observation.outcome === "DELIVERED") {
            throw new RefusedAuthorization(
              new ApiError(
                409,
                "PRINT_RECOVERY_DELIVERED",
                "The record says this print was delivered. Correct that record first if it is wrong."
              ),
              {
                failureCode: "OBSERVED_DELIVERED",
                reason: body.reason,
                printJobId,
                kioskId: job.kioskId,
                sessionId: job.sessionId
              }
            );
          }

          const payment = await transaction.payment.findFirst({
            where: { id: job.paymentId, sessionId: job.sessionId },
            select: {
              id: true,
              status: true,
              provider: true,
              amountMinor: true,
              currency: true,
              currencyExponent: true
            }
          });

          if (!payment || payment.status !== "CAPTURED") {
            throw new RefusedAuthorization(
              new ApiError(
                409,
                "PAYMENT_NOT_CAPTURED",
                "This print's payment never captured, so there is nothing to give back."
              ),
              {
                failureCode: "NOT_CAPTURED",
                reason: body.reason,
                printJobId,
                kioskId: job.kioskId,
                sessionId: job.sessionId,
                previousState: payment?.status ?? "MISSING"
              }
            );
          }

          // Everything already owed on this capture, by every reason — a late
          // capture the payment path compensated for counts against the same
          // money. Re-read here rather than taken from the queue the person was
          // looking at, because a webhook can raise one of those at any moment.
          const owed = await transaction.refund.aggregate({
            where: { paymentId: payment.id },
            _sum: { amountMinor: true }
          });
          const alreadyOwed = owed._sum.amountMinor ?? 0;
          const authorizable = payment.amountMinor - alreadyOwed;

          if (body.amountMinor > authorizable) {
            throw new RefusedAuthorization(
              new ApiError(
                409,
                "REFUND_EXCEEDS_CAPTURE",
                authorizable > 0
                  ? `At most ${authorizable} may still be refunded on this payment.`
                  : "Everything captured on this payment is already owed back."
              ),
              {
                failureCode: "EXCEEDS_CAPTURE",
                reason: body.reason,
                printJobId,
                kioskId: job.kioskId,
                sessionId: job.sessionId,
                amountMinor: body.amountMinor,
                authorizableAmountMinor: authorizable
              }
            );
          }

          // The obligation, then the record of who decided it, in that order
          // because the second references the first. A deferred trigger checks
          // at COMMIT that the second exists, so this ordering cannot become a
          // way to leave an anonymous payout behind.
          const refund = await transaction.refund.create({
            data: {
              id: this.options.random.uuid(now),
              paymentId: payment.id,
              sessionId: job.sessionId,
              // A refund belongs to its payment's provider, and a trigger
              // refuses any row that says otherwise.
              provider: payment.provider,
              reason: REFUND_AUTHORIZATION_REASON,
              amountMinor: body.amountMinor,
              currency: payment.currency,
              currencyExponent: payment.currencyExponent,
              status: "PENDING",
              createdAt: now,
              updatedAt: now
            },
            select: { id: true, status: true }
          });

          const authorization = await transaction.refundAuthorization.create({
            data: {
              id: this.options.random.uuid(now),
              refundId: refund.id,
              printJobId: job.id,
              sessionId: job.sessionId,
              paymentId: payment.id,
              amountMinor: body.amountMinor,
              currency: payment.currency,
              currencyExponent: payment.currencyExponent,
              reason: body.reason,
              observedOutcome: observation.outcome,
              observedRecordId: observation.id,
              authorizedByAdminId: admin.adminUserId,
              authorizedByRole: admin.role,
              requestDigest: digest,
              createdAt: now
            },
            select: AUTHORIZATION_FIELDS
          });

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.refund.authorize",
            outcome: "SUCCESS",
            requestId,
            kioskId: job.kioskId,
            sessionId: job.sessionId,
            metadata: {
              role: admin.role,
              capability: "refund.authorize",
              risk: "R2",
              stepUpFresh: true,
              printJobId: job.id,
              paymentId: payment.id,
              refundId: refund.id,
              reason: body.reason,
              amountMinor: body.amountMinor,
              currency: payment.currency,
              // The money the decision was made against, so the audit row can
              // be read years later without joining to rows that have moved on.
              capturedAmountMinor: payment.amountMinor,
              previouslyOwedMinor: alreadyOwed,
              recoveryOutcome: observation.outcome,
              observedRecordId: observation.id,
              sheetsProduced: job.sheetsProduced,
              physicalSheets: job.physicalSheets,
              // Before and after, as states of the obligation. There was none;
              // now there is one, and it is unpaid. Nothing has been settled.
              previousState: "NONE",
              resultingState: "PENDING"
            }
          });

          return {
            authorization: await this.present(transaction, authorization, refund.status),
            replayed: false,
            settled: false as const
          };
        },
        { timeout: AUTHORIZATION_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
      // The transaction is gone by now, along with anything written in it. A
      // refused authorization is recorded on its own, because somebody probing
      // for prints they can pay themselves for should leave exactly as much
      // evidence as somebody doing their job.
      if (error instanceof RefusedAuthorization) {
        await this.auditRefusal(admin, requestId, now, error.details);
        throw error.response;
      }
      throw error;
    }
  }

  /**
   * Record that somebody without the capability asked to authorize a payout.
   *
   * The only refusal in the control plane recorded before the action's own
   * service is reached. It is here because the question "who has been trying to
   * pay people" should be answerable from the log, and because an account that
   * probes this endpoint is telling you something whether or not it succeeds.
   *
   * Written on a best-effort basis: the caller is already refusing the request,
   * and a failure to record that must not turn a 403 into a 500.
   */
  public async recordForbiddenAttempt(admin: AuthenticatedAdmin, requestId: string): Promise<void> {
    const now = this.options.clock.now();
    try {
      await writeAdminAuditEvent(this.options.database, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: admin.adminUserId,
        action: "admin.refund.authorize",
        outcome: "DENIED",
        requestId,
        metadata: {
          role: admin.role,
          capability: "refund.authorize",
          failureCode: "CAPABILITY_NOT_HELD"
        }
      });
    } catch {
      // Deliberately swallowed. The request is refused either way, and the
      // alternative is a 500 that tells the caller their probe hit something.
    }
  }

  /**
   * The account of a print as it currently stands.
   *
   * The original observation, then however many corrections have superseded it
   * in turn. The chain is followed rather than the newest row taken, so an
   * authorization always cites the record somebody is actually looking at.
   */
  private async effectiveObservation(
    transaction: AdminRefundTransaction,
    printJobId: string
  ): Promise<{ id: string; outcome: RecoveryOutcome } | null> {
    const resolution = await transaction.printJobRecoveryResolution.findUnique({
      where: { printJobId },
      select: { id: true, outcome: true }
    });
    if (!resolution) return null;

    const corrections = await transaction.printJobRecoveryCorrection.findMany({
      where: { printJobId },
      select: { id: true, supersedesId: true, outcome: true }
    });

    const bySuperseded = new Map(corrections.map((row) => [row.supersedesId, row]));
    let current = { id: resolution.id, outcome: resolution.outcome };
    for (let step = 0; step < corrections.length; step += 1) {
      const next = bySuperseded.get(current.id);
      if (!next) break;
      current = { id: next.id, outcome: next.outcome };
    }

    return { id: current.id, outcome: current.outcome as RecoveryOutcome };
  }

  /** Put a person's name on the stored row without a second round trip. */
  private async present(
    transaction: AdminRefundTransaction,
    row: StoredAuthorization,
    status: string
  ): Promise<AdminRefundAuthorization> {
    const person = await transaction.adminUser.findUnique({
      where: { id: row.authorizedByAdminId },
      select: { displayName: true }
    });

    return {
      refundId: row.refundId,
      printJobId: row.printJobId,
      paymentId: row.paymentId,
      sessionId: row.sessionId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      currencyExponent: row.currencyExponent,
      reason: row.reason,
      status,
      observedOutcome: row.observedOutcome as RecoveryOutcome,
      authorizedByAdminUserId: row.authorizedByAdminId,
      authorizedByDisplayName: person?.displayName ?? null,
      authorizedByRole: row.authorizedByRole,
      authorizedAt: row.createdAt.toISOString()
    };
  }

  /** Record that somebody tried to authorize a payout, and was told no. */
  private async auditRefusal(
    admin: AuthenticatedAdmin,
    requestId: string,
    now: Date,
    details: RefusalDetails
  ): Promise<void> {
    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: admin.adminUserId,
      action: "admin.refund.authorize",
      outcome: "DENIED",
      requestId,
      ...(details.kioskId ? { kioskId: details.kioskId } : {}),
      ...(details.sessionId ? { sessionId: details.sessionId } : {}),
      metadata: {
        role: admin.role,
        capability: "refund.authorize",
        failureCode: details.failureCode,
        reason: details.reason,
        ...(details.printJobId ? { printJobId: details.printJobId } : {}),
        ...(details.previousState ? { previousState: details.previousState } : {}),
        ...(details.amountMinor === undefined ? {} : { amountMinor: details.amountMinor }),
        ...(details.authorizableAmountMinor === undefined
          ? {}
          : { authorizableAmountMinor: details.authorizableAmountMinor })
      } satisfies Record<string, AdminAuditMetadataValue>
    });
  }
}

const AUTHORIZATION_FIELDS = {
  refundId: true,
  printJobId: true,
  sessionId: true,
  paymentId: true,
  amountMinor: true,
  currency: true,
  currencyExponent: true,
  reason: true,
  observedOutcome: true,
  authorizedByAdminId: true,
  authorizedByRole: true,
  requestDigest: true,
  createdAt: true
} as const;

interface StoredAuthorization {
  refundId: string;
  printJobId: string;
  sessionId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  currencyExponent: number;
  reason: string;
  observedOutcome: string;
  authorizedByAdminId: string;
  authorizedByRole: string;
  requestDigest: string;
  createdAt: Date;
}

interface RefusalDetails {
  failureCode: string;
  reason: string;
  printJobId?: string;
  kioskId?: string;
  sessionId?: string;
  previousState?: string;
  amountMinor?: number;
  authorizableAmountMinor?: number;
}

/**
 * A refusal, carried out of the transaction so the transaction can roll back
 * before the refusal is recorded.
 *
 * Not an `ApiError` itself, for the same reason as its counterpart in
 * `operations.ts`: this type cannot reach the client, so the only way to
 * resolve it is through the handler that writes the audit row.
 */
class RefusedAuthorization extends Error {
  public constructor(
    public readonly response: ApiError,
    public readonly details: RefusalDetails
  ) {
    super(details.failureCode);
    this.name = "RefusedAuthorization";
  }
}

/**
 * Turn what the caller submitted into a digest that decides whether a repeat is
 * a replay or a contradiction.
 *
 * The amount and the reason are both in it. Resubmitting the same form replays;
 * the same print with a different amount is a conflict somebody has to look at,
 * because two people disagreeing about what a customer is owed is not something
 * to resolve by taking whichever request arrived second.
 */
function digestAuthorizationRequest(body: AuthorizeRefundBody): string {
  return createHash("sha256")
    .update("printing-kiosk/admin/refund-authorization/v1", "utf8")
    .update("\0", "utf8")
    .update(String(body.amountMinor), "utf8")
    .update("\0", "utf8")
    .update(body.reason, "utf8")
    .digest("hex");
}
