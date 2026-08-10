import { z } from "zod";

import {
  ADMIN_ERROR_SUBSYSTEMS,
  RECOVERY_OUTCOMES,
  adminRecoveryResolutionSchema,
  type RecoveryOutcome
} from "./observability.js";

/**
 * What the control plane may actually change.
 *
 * Everything in `observability.ts` describes an answer. This file describes the
 * two requests an operator may make, and it is short on purpose: the surface a
 * dashboard can act through should be small enough to read in one sitting and
 * to review as a closed set.
 *
 * Neither request can move money, change a print job, reopen a session or issue
 * a command to a device. Both produce a new fact and nothing else — an operator
 * observation, and an acknowledgement that somebody is looking at a failure.
 *
 * The vocabularies here are mirrored by check constraints in the database, so a
 * value that gets past this file still cannot get past PostgreSQL.
 */

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

export const resolveRecoveryBodySchema = z
  .object({
    outcome: z.enum(RECOVERY_OUTCOMES),
    reason: recoveryReasonSchema,
    /**
     * What the operator counted, when they could count. Optional because
     * "I could not count them" is a real state, and a required number would be
     * answered with a made-up one.
     */
    observedSheets: z.number().int().min(0).max(10_000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    // The same contradictions the database refuses, refused earlier and with a
    // message a person can act on. Both layers exist because this one can be
    // bypassed and the other one cannot.
    if (value.outcome === "NOT_DELIVERED" && value.observedSheets !== undefined) {
      if (value.observedSheets !== 0) {
        context.addIssue({
          code: "custom",
          path: ["observedSheets"],
          message: "Nothing delivered means no sheets. Choose partially delivered instead."
        });
      }
    }
    if (
      value.outcome === "DELIVERED" &&
      value.observedSheets !== undefined &&
      value.observedSheets === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedSheets"],
        message: "Delivered means at least one sheet. Choose not delivered instead."
      });
    }
    if (value.outcome === "UNRESOLVABLE" && value.observedSheets !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["observedSheets"],
        message: "An unresolvable outcome cannot carry a sheet count."
      });
    }
  });

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
