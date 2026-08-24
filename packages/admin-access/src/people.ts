import { z } from "zod";

import { ADMIN_USER_STATUSES, type AdminUserStatus } from "./authenticators.js";
import { adminRoleSchema } from "./contracts.js";
import { recoveryReasonSchema } from "./operations.js";

/**
 * Administering the people who use the control plane.
 *
 * Everything the panel could do before this file appends. This is the first
 * surface that changes a row somebody else's access depends on — a status, a
 * revocation timestamp, a kiosk assignment — so each request here is shaped to
 * make the change describable after the fact rather than merely possible.
 *
 * Three rules run through all of it.
 *
 * **Nothing here promotes anybody.** There is no role field in any request. An
 * account holds the role its invitation named, and no capability changes it. A
 * capability that could turn an Operator into an Admin would make every other
 * boundary in this package a formality.
 *
 * **Nothing here enrols a key on somebody else's behalf.** WebAuthn will not
 * allow it: enrolment needs the person and their device in the same place.
 *
 * **Nothing here is a delete.** Retiring a key, ending a session and taking a
 * kiosk away are all timestamps written onto rows that stay. "Who could act on
 * kiosk 4 last March" has to remain answerable, and a DELETE would be the one
 * kind of change that erases its own subject.
 */

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

/**
 * The status changes an Admin may make from the panel.
 *
 * `PROVISIONING` is absent: it is the state an account is created in and leaves
 * exactly once, by enrolling enough authenticators. Nothing may put an account
 * back into the only state in which it holds fewer keys than its role requires.
 */
export const ADMIN_STATUS_ACTIONS = ["SUSPENDED", "ACTIVE", "DISABLED"] as const;

export type AdminStatusAction = (typeof ADMIN_STATUS_ACTIONS)[number];

export type StatusTransitionRejection =
  /** The account is already there. Not an error, but not a change either. */
  | "ALREADY_IN_STATE"
  /** Nothing returns to PROVISIONING, and DISABLED is the end of the line. */
  | "TRANSITION_NOT_PERMITTED"
  /** Resuming an account that never finished enrolling would activate it early. */
  | "NEVER_ACTIVATED";

export type StatusTransitionResult =
  { allowed: true } | { allowed: false; reason: StatusTransitionRejection };

/**
 * Whether one account status may become another.
 *
 * The same rule the account CLI has enforced since Phase 1, stated here so the
 * panel and the CLI cannot drift apart about what "resume" means. Read the
 * permitted set as three facts:
 *
 *   - `DISABLED` is terminal. An account that has been shut down is not
 *     reopened; a person coming back gets a new account and enrols new keys,
 *     because the alternative is a dormant identity that can be switched on
 *     without anybody enrolling anything.
 *   - `PROVISIONING` is reachable only at creation, and leaves only by
 *     enrolling. It may be abandoned (`DISABLED`) but never resumed into
 *     `ACTIVE` from here — activation is something authenticators earn.
 *   - `SUSPENDED` is the reversible one, and it is the whole reason this
 *     capability exists: taking somebody's access away in the moment it needs
 *     taking away, and giving it back without re-enrolling a key.
 */
export function evaluateStatusTransition(
  currentStatus: AdminUserStatus,
  requestedStatus: AdminStatusAction,
  activatedAt: Date | null
): StatusTransitionResult {
  if (currentStatus === requestedStatus) {
    return { allowed: false, reason: "ALREADY_IN_STATE" };
  }

  const permitted =
    (currentStatus === "ACTIVE" &&
      (requestedStatus === "SUSPENDED" || requestedStatus === "DISABLED")) ||
    (currentStatus === "SUSPENDED" &&
      (requestedStatus === "ACTIVE" || requestedStatus === "DISABLED")) ||
    (currentStatus === "PROVISIONING" && requestedStatus === "DISABLED");

  if (!permitted) return { allowed: false, reason: "TRANSITION_NOT_PERMITTED" };
  if (requestedStatus === "ACTIVE" && !activatedAt) {
    return { allowed: false, reason: "NEVER_ACTIVATED" };
  }
  return { allowed: true };
}

/** Whether a status change should end every live session the account holds. */
export function revokesSessions(requestedStatus: AdminStatusAction): boolean {
  return requestedStatus !== "ACTIVE";
}

/**
 * What a status change reports back.
 *
 * `revokedSessions` is there so the panel can say what actually happened rather
 * than what was asked for. "Suspended; 2 sessions ended" and "Suspended" are
 * different pieces of news to somebody who suspended an account because they
 * think it is being used by the wrong person.
 */
export const changeAdminStatusResponseSchema = z.object({
  targetAdminUserId: z.string().uuid(),
  previousStatus: z.enum(ADMIN_USER_STATUSES),
  status: z.enum(ADMIN_STATUS_ACTIONS),
  revokedSessions: z.number().int().nonnegative()
});

export type ChangeAdminStatusResponse = z.infer<typeof changeAdminStatusResponseSchema>;

export const changeAdminStatusBodySchema = z
  .object({
    status: z.enum(ADMIN_STATUS_ACTIONS),
    /**
     * Mandatory, and the same shape as every other reason in the control plane.
     * Suspending a colleague is the kind of act whose justification is only ever
     * needed months later, by somebody who was not there.
     */
    reason: recoveryReasonSchema
  })
  .strict();

export type ChangeAdminStatusBody = z.infer<typeof changeAdminStatusBodySchema>;

// ---------------------------------------------------------------------------
// Kiosk assignment
// ---------------------------------------------------------------------------

/**
 * Which kiosks an Operator may act on.
 *
 * Not a capability: an Operator holds `print.recovery.resolve` everywhere or
 * nowhere, and these rows bound the query that finds the job. An account with no
 * assignment can act on no kiosk, which is the safe state a new Operator starts
 * in and the state this request moves them out of.
 *
 * Granting is an insert; withdrawing sets `revokedAt` on the row that already
 * exists. Regranting clears it again. What survives either way is the audit
 * trail, which is where the history of who could act where actually lives.
 */
export const kioskAssignmentBodySchema = z
  .object({
    kioskId: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/u),
    granted: z.boolean(),
    reason: recoveryReasonSchema
  })
  .strict();

export type KioskAssignmentBody = z.infer<typeof kioskAssignmentBodySchema>;

/**
 * `changed` distinguishes "this is now true" from "this was already true".
 * Assigning a kiosk somebody already covers is not an error and not a second
 * grant; saying so keeps a double-clicked button honest.
 */
export const kioskAssignmentResponseSchema = z.object({
  targetAdminUserId: z.string().uuid(),
  kioskId: z.string().max(64),
  granted: z.boolean(),
  changed: z.boolean()
});

export type KioskAssignmentResponse = z.infer<typeof kioskAssignmentResponseSchema>;

// ---------------------------------------------------------------------------
// Sessions and authenticators belonging to somebody else
// ---------------------------------------------------------------------------

export const revokeAdminSessionsBodySchema = z.object({ reason: recoveryReasonSchema }).strict();

export type RevokeAdminSessionsBody = z.infer<typeof revokeAdminSessionsBodySchema>;

export const revokeAdminSessionsResponseSchema = z.object({
  targetAdminUserId: z.string().uuid(),
  revokedSessions: z.number().int().nonnegative()
});

export type RevokeAdminSessionsResponse = z.infer<typeof revokeAdminSessionsResponseSchema>;

export const revokeOperatorAuthenticatorBodySchema = z
  .object({ reason: recoveryReasonSchema })
  .strict();

export type RevokeOperatorAuthenticatorBody = z.infer<typeof revokeOperatorAuthenticatorBodySchema>;

/**
 * How many keys the account has left. Reported because the next question after
 * retiring one is always whether the person can still sign in, and an answer
 * that needs a second request is an answer nobody reads.
 */
export const revokeOperatorAuthenticatorResponseSchema = z.object({
  targetAdminUserId: z.string().uuid(),
  authenticatorId: z.string().uuid(),
  usableAuthenticators: z.number().int().nonnegative()
});

export type RevokeOperatorAuthenticatorResponse = z.infer<
  typeof revokeOperatorAuthenticatorResponseSchema
>;

// ---------------------------------------------------------------------------
// The read side
// ---------------------------------------------------------------------------

/**
 * One Operator, as the people section shows them.
 *
 * Nothing here is a credential. Counts, labels, timestamps and states — the same
 * boundary the document screens hold, applied to people: enough to decide
 * whether somebody can work and whether they should, and nothing that could be
 * replayed. No WebAuthn handle, no credential identifier, no public key, no
 * session token digest.
 */
export const adminPersonSchema = z.object({
  adminUserId: z.string().uuid(),
  username: z.string().max(32),
  displayName: z.string().max(120),
  role: adminRoleSchema,
  status: z.enum(ADMIN_USER_STATUSES),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  suspendedAt: z.string().datetime().nullable(),
  disabledAt: z.string().datetime().nullable(),
  lastLoginAt: z.string().datetime().nullable(),
  /** Whether the account holds a password. False explains a PROVISIONING row. */
  passwordSet: z.boolean(),
  /** Usable keys, and how many this role must keep. Below the minimum is why
   * an account is still provisioning, and why a revocation may be refused. */
  usableAuthenticators: z.number().int().nonnegative(),
  minimumAuthenticators: z.number().int().nonnegative(),
  authenticators: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string().max(80),
      attachment: z.enum(["platform", "cross-platform"]).nullable(),
      backupEligible: z.boolean(),
      createdAt: z.string().datetime(),
      lastUsedAt: z.string().datetime().nullable()
    })
  ),
  /** Live sessions right now. The count is the useful number; the rows are not. */
  activeSessions: z.number().int().nonnegative(),
  kioskIds: z.array(z.string().max(64)),
  /**
   * A live, unaccepted invitation or password reset outstanding on this
   * account. Shown to everybody who can see the section, because credentials
   * in flight are exactly the thing a second pair of eyes should notice.
   */
  pendingInvitationExpiresAt: z.string().datetime().nullable(),
  pendingPasswordResetExpiresAt: z.string().datetime().nullable()
});

export type AdminPerson = z.infer<typeof adminPersonSchema>;

export const adminPeopleResponseSchema = z.object({
  items: z.array(adminPersonSchema),
  /** Every kiosk that exists, so an assignment can be made without typing an id. */
  kiosks: z.array(z.object({ id: z.string().max(64), name: z.string().max(120) }))
});

export type AdminPeopleResponse = z.infer<typeof adminPeopleResponseSchema>;
