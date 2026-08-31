import { z } from "zod";

import {
  ADMIN_ERROR_SUBSYSTEMS,
  PAPER_ESTIMATE_MAX_SHEETS,
  PAPER_ESTIMATE_STATUSES,
  RECOVERY_OUTCOMES,
  adminRecoveryCorrectionSchema,
  adminRecoveryResolutionSchema,
  adminRefundAuthorizationSchema,
  type RecoveryOutcome
} from "./observability.js";

/**
 * What the control plane may actually change.
 *
 * Everything in `observability.ts` describes an answer. This file describes
 * every request a person may make, and it is short on purpose: the surface a
 * dashboard can act through should be small enough to read in one sitting and
 * to review as a closed set.
 *
 * A short set of requests, in ascending order of what they can cost:
 *
 *   - acknowledge an incident            nothing changes at all
 *   - ask retention to try again         a worker retries work it already owns
 *   - add or correct kiosk paper          a software estimate changes
 *   - record a recovery observation      a new fact about a print
 *   - correct a recovery observation     a new fact superseding an earlier one
 *   - authorize a refund                 an obligation to return money
 *
 * Only the last one is about money, and it is the only one whose row is written
 * on a different connection by a different database role. Everything above it
 * is additive: none of them changes a print job, reopens a session, or issues a
 * command to a device, and the connection they run on holds no privilege to do
 * so even if this package were rewritten to ask.
 *
 * The vocabularies here are mirrored by check constraints in the database, so a
 * value that gets past this file still cannot get past PostgreSQL.
 */

// ---------------------------------------------------------------------------
// Kiosk paper estimate
// ---------------------------------------------------------------------------

const paperNoteSchema = z.string().trim().min(3).max(280);

export const addKioskPaperBodySchema = z
  .object({
    sheetsAdded: z.number().int().min(1).max(PAPER_ESTIMATE_MAX_SHEETS),
    note: paperNoteSchema.optional(),
    /** Stable across transport and step-up retries. */
    requestKey: z.string().uuid()
  })
  .strict();

export const correctKioskPaperBodySchema = z
  .object({
    estimatedSheets: z.number().int().min(0).max(PAPER_ESTIMATE_MAX_SHEETS),
    reason: paperNoteSchema,
    /** Stable across transport and step-up retries. */
    requestKey: z.string().uuid()
  })
  .strict();

export const kioskPaperMutationResponseSchema = z.object({
  /** What the estimate became. The count is the answer, not an event id. */
  estimatedSheets: z.number().int().min(0).max(PAPER_ESTIMATE_MAX_SHEETS),
  /** The signed change this request applied to it. */
  appliedSheets: z.number().int(),
  status: z.enum(PAPER_ESTIMATE_STATUSES),
  /** True when this exact request had already been applied and was not redone. */
  replayed: z.boolean()
});

export type AddKioskPaperBody = z.infer<typeof addKioskPaperBodySchema>;
export type CorrectKioskPaperBody = z.infer<typeof correctKioskPaperBodySchema>;
export type KioskPaperMutationResponse = z.infer<typeof kioskPaperMutationResponseSchema>;

// ---------------------------------------------------------------------------
// Print recovery resolution
// ---------------------------------------------------------------------------

/**
 * Whether an outcome means a person thinks money is owed.
 *
 * Derived here, mirrored by a check constraint, and never accepted from the
 * request. A client that could submit "delivered, and also refund it" would be
 * a client that could ask an Admin to pay out on a print that worked.
 */
export function suggestsRefund(outcome: RecoveryOutcome): boolean {
  return outcome === "PARTIALLY_DELIVERED" || outcome === "NOT_DELIVERED";
}

/**
 * A reason, and a real one.
 *
 * Mandatory because this row may be the only surviving account of why a paid
 * print was closed. Bounded at both ends: too short is not an explanation, and
 * too long is somebody pasting something that does not belong in a database.
 */
export const recoveryReasonSchema = z
  .string()
  .trim()
  .min(8, "Say what you saw — at least a few words.")
  .max(280);

/**
 * What the person counted, when they could count. Optional because "I could not
 * count them" is a real state, and a required number would be answered with a
 * made-up one.
 */
const observedSheetsSchema = z.number().int().min(0).max(10_000).optional();

/**
 * The contradictions the database refuses, refused earlier and with a message a
 * person can act on.
 *
 * Shared by an observation and by a correction of one, so the two can never
 * drift into accepting different accounts of the same print. Both layers exist
 * because this one can be bypassed and the check constraint cannot.
 */
function refineObservedSheets(
  value: { outcome: RecoveryOutcome; observedSheets?: number | undefined },
  context: z.RefinementCtx
): void {
  if (value.observedSheets === undefined) return;

  if (value.outcome === "NOT_DELIVERED" && value.observedSheets !== 0) {
    context.addIssue({
      code: "custom",
      path: ["observedSheets"],
      message: "Nothing delivered means no sheets. Choose partially delivered instead."
    });
  }
  if (value.outcome === "DELIVERED" && value.observedSheets === 0) {
    context.addIssue({
      code: "custom",
      path: ["observedSheets"],
      message: "Delivered means at least one sheet. Choose not delivered instead."
    });
  }
  if (value.outcome === "UNRESOLVABLE") {
    context.addIssue({
      code: "custom",
      path: ["observedSheets"],
      message: "An unresolvable outcome cannot carry a sheet count."
    });
  }
}

export const resolveRecoveryBodySchema = z
  .object({
    outcome: z.enum(RECOVERY_OUTCOMES),
    reason: recoveryReasonSchema,
    observedSheets: observedSheetsSchema
  })
  .strict()
  .superRefine(refineObservedSheets);

export type ResolveRecoveryBody = z.infer<typeof resolveRecoveryBodySchema>;

export const resolveRecoveryResponseSchema = z.object({
  resolution: adminRecoveryResolutionSchema,
  /**
   * True when this request found the observation already recorded and returned
   * it unchanged. Shown to the operator so a double submission reads as "already
   * done" rather than as a second success.
   */
  replayed: z.boolean(),
  /**
   * Restates the boundary in the response itself. An Operator has recorded that
   * money looks owed; nothing has been paid, and nothing will be until somebody
   * holding `refund.authorize` acts.
   */
  refundAuthorized: z.literal(false)
});

export type ResolveRecoveryResponse = z.infer<typeof resolveRecoveryResponseSchema>;

// ---------------------------------------------------------------------------
// Correcting a recovery observation
// ---------------------------------------------------------------------------

/**
 * Putting right an account of a print that turned out to be wrong.
 *
 * The observation itself stays exactly as it was written: this appends a later
 * one that supersedes it. Somebody who could edit their own account of a paid
 * print could launder a failure into a success, so the correction is a separate
 * capability held by roles that do not make the observations, and it produces a
 * new row rather than a changed one.
 *
 * `supersedesId` is the record the corrector was actually looking at — the
 * original resolution, or the newest correction if this print has been through
 * this before. Naming it is what turns two people correcting the same print at
 * the same moment into a conflict somebody reads, instead of a silent
 * last-writer-wins.
 */
export const correctRecoveryBodySchema = z
  .object({
    supersedesId: z.string().uuid(),
    outcome: z.enum(RECOVERY_OUTCOMES),
    reason: recoveryReasonSchema,
    observedSheets: observedSheetsSchema
  })
  .strict()
  .superRefine(refineObservedSheets);

export type CorrectRecoveryBody = z.infer<typeof correctRecoveryBodySchema>;

export const correctRecoveryResponseSchema = z.object({
  correction: adminRecoveryCorrectionSchema,
  replayed: z.boolean(),
  /**
   * Restates the boundary, as the resolution response does. Correcting an
   * observation can change what a refund queue says is owed; it never moves
   * money, and it never settles or withdraws a refund already authorized.
   */
  refundAuthorized: z.literal(false)
});

export type CorrectRecoveryResponse = z.infer<typeof correctRecoveryResponseSchema>;

// ---------------------------------------------------------------------------
// Authorizing a refund
// ---------------------------------------------------------------------------

/**
 * The `refunds.reason` value written by a refund a person authorized.
 *
 * Taken from the vocabulary Phase 7 closed rather than added to it. That list
 * already reserved a value for this — the other three describe things the
 * system noticed on its own (a late capture, an amount mismatch, a print the
 * device reported as failed), and this one describes a person deciding. The
 * name says "operator" in the operational sense; the capability that reaches it
 * is Admin and above, and who actually decided is recorded beside the row.
 *
 * Two consequences worth stating. It is distinct from `PRINT_FAILED`, which the
 * print path raises automatically for a job that settled as failed, so an
 * authorization can never collide with or masquerade as one of those. And
 * `UNIQUE (payment_id, reason)` makes "one authorized refund per payment" a
 * property of the database rather than a check somebody has to remember.
 */
export const REFUND_AUTHORIZATION_REASON = "OPERATOR_REQUESTED";

/**
 * Turning an observation into an obligation to return money.
 *
 * The only request in this file that costs anything, and the shape reflects it:
 * an amount somebody typed, a reason somebody wrote, and nothing else. The
 * currency is not accepted from the client — it is the payment's own, because a
 * refund denominated in a currency the capture was not made in is not a refund.
 *
 * What this does *not* do is move money. It records an obligation, at `PENDING`,
 * for the executor that settles refunds against the provider. Nothing in the
 * control plane holds a provider credential, and this request is why that is
 * worth restating: authorizing a payout and performing one are different acts,
 * and only the first one is reachable from a browser.
 */
export const authorizeRefundBodySchema = z
  .object({
    /**
     * Bounded here so an obviously wrong number is refused before it reaches a
     * transaction; the real ceiling is what the payment actually captured, less
     * anything already owed on it, and only the server knows that.
     */
    amountMinor: z.number().int().positive().max(100_000_000),
    reason: recoveryReasonSchema
  })
  .strict();

export type AuthorizeRefundBody = z.infer<typeof authorizeRefundBodySchema>;

export const authorizeRefundResponseSchema = z.object({
  authorization: adminRefundAuthorizationSchema,
  replayed: z.boolean(),
  /**
   * The obligation is recorded; no money has moved. Written as a literal so no
   * code path can produce a response claiming a customer has been paid, in the
   * same way the resolution response cannot claim a refund was authorized.
   */
  settled: z.literal(false)
});

export type AuthorizeRefundResponse = z.infer<typeof authorizeRefundResponseSchema>;

// ---------------------------------------------------------------------------
// Asking retention to try again
// ---------------------------------------------------------------------------

/**
 * Re-arming a cleanup run that gave up.
 *
 * A dead-lettered run means a customer's documents are still in object storage
 * after the point at which this system promised they would be gone, and the
 * only thing still holding the line is a storage lifecycle rule meant to be a
 * backstop. Somebody has to be able to say "the object store is back, try
 * again" without waiting for anybody's approval — so this is R1.
 *
 * It is a request, not an edit. The panel appends a row; the worker that owns
 * retention reads it and re-arms its own run. The control plane holds no
 * privilege on `cleanup_runs` at all, which is what stops "retry the cleanup"
 * from being a way to reach into retention state and change something else.
 */
export const retryRetentionBodySchema = z
  .object({
    sessionId: z.string().uuid(),
    reason: recoveryReasonSchema
  })
  .strict();

export type RetryRetentionBody = z.infer<typeof retryRetentionBodySchema>;

export const adminRetentionRetrySchema = z.object({
  sessionId: z.string().uuid(),
  /** The run this request was made against, and the failure it was made about. */
  cleanupRunId: z.string().uuid(),
  deadLetteredAt: z.string().datetime(),
  lastErrorCode: z.string().max(100).nullable(),
  attempts: z.number().int().nonnegative(),
  requestedByAdminUserId: z.string().uuid(),
  requestedByDisplayName: z.string().max(120).nullable(),
  requestedAt: z.string().datetime()
});

export const retryRetentionResponseSchema = z.object({
  retry: adminRetentionRetrySchema,
  replayed: z.boolean(),
  /**
   * Nothing has been deleted yet, and this request did not delete it. The
   * worker picks the run up on its next pass; the panel is not the thing that
   * removes a customer's documents and should never report that it is.
   */
  rearmed: z.literal(false)
});

export type AdminRetentionRetry = z.infer<typeof adminRetentionRetrySchema>;
export type RetryRetentionResponse = z.infer<typeof retryRetentionResponseSchema>;

// ---------------------------------------------------------------------------
// Incident acknowledgement
// ---------------------------------------------------------------------------

/**
 * Saying "I am looking at this" about a group in the error centre.
 *
 * The lowest-risk action in the system: it changes no operational state at all,
 * and exists so that two operators watching the same failure do not both start
 * walking to the same kiosk.
 *
 * An acknowledgement is stored as an audit event rather than as a row somebody
 * can edit, because that is genuinely all it is — a record that a named person
 * saw something at a time. There is no state to keep in sync and nothing to
 * clear: it ages out with the window it was made in.
 */
export const acknowledgeIncidentBodySchema = z
  .object({
    subsystem: z.enum(ADMIN_ERROR_SUBSYSTEMS),
    /**
     * The failure code from the group being acknowledged. Constrained to this
     * system's own code shape: an acknowledgement is checked against the live
     * error centre before it is recorded, so a code that never happened cannot
     * be used to write attacker-chosen text into the audit log.
     */
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_]+$/u),
    /** Null for the subsystems whose failures hang off a session, not a device. */
    kioskId: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/u)
      .nullable(),
    reason: recoveryReasonSchema
  })
  .strict();

export type AcknowledgeIncidentBody = z.infer<typeof acknowledgeIncidentBodySchema>;

export const adminIncidentAcknowledgementSchema = z.object({
  subsystem: z.enum(ADMIN_ERROR_SUBSYSTEMS),
  code: z.string().max(64),
  kioskId: z.string().max(64).nullable(),
  acknowledgedByDisplayName: z.string().max(120).nullable(),
  acknowledgedAt: z.string().datetime()
});

export const acknowledgeIncidentResponseSchema = z.object({
  acknowledgement: adminIncidentAcknowledgementSchema
});

export type AdminIncidentAcknowledgement = z.infer<typeof adminIncidentAcknowledgementSchema>;
export type AcknowledgeIncidentResponse = z.infer<typeof acknowledgeIncidentResponseSchema>;

/**
 * The identity of an error group, as one string.
 *
 * Built the same way on both sides so the panel can match an acknowledgement to
 * the group it belongs to without either side inventing its own key.
 *
 * Joining the three parts with a separator would be shorter and would work
 * until a kiosk was named after the separator or after whatever placeholder
 * stood in for "no kiosk" — at which point a system-wide failure and one
 * kiosk's failure would silently become the same incident. This encoding is
 * injective for every possible input, which is a property worth more than the
 * few characters it costs.
 */
export function incidentKey(group: {
  subsystem: string;
  code: string;
  kioskId: string | null;
}): string {
  return JSON.stringify([group.subsystem, group.code, group.kioskId]);
}
