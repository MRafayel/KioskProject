import { z } from "zod";

import { oneTimeCodeSchema, passwordSchema, usernameSchema } from "./authentication.js";
import { ADMIN_CAPABILITIES, ADMIN_ROLES } from "./capabilities.js";

/**
 * The admin control plane's wire shapes.
 *
 * These live beside the capability model rather than in
 * `@printing-kiosk/contracts` on purpose: that package is imported by the kiosk
 * and phone bundles, and the existing architecture decision is that admin code
 * does not couple into customer-facing surfaces.
 *
 * Everything here is metadata about people and their own session. No admin
 * route returns a customer document, a filename, a payment detail or a secret,
 * and none of these schemas has a field that could carry one.
 */

export const adminRoleSchema = z.enum(ADMIN_ROLES);
export const adminCapabilitySchema = z.enum(ADMIN_CAPABILITIES);

/** The opaque handle for one in-flight WebAuthn ceremony. */
export const ceremonyIdSchema = z.string().uuid();

export const adminIdentityResponseSchema = z.object({
  state: z.literal("ACTIVE"),
  adminUserId: z.string().uuid(),
  username: usernameSchema,
  displayName: z.string().min(1).max(120),
  role: adminRoleSchema,
  capabilities: z.array(adminCapabilitySchema),
  /** Kiosks this account may act on. Empty means no kiosk-bound action. */
  kioskScopes: z.array(z.string().max(64)),
  /** How this account proves itself again at unlock and step-up. */
  strongAuthMethod: z.enum(["WEBAUTHN", "PASSWORD"]),
  session: z.object({
    idleExpiresAt: z.string().datetime(),
    hardExpiresAt: z.string().datetime(),
    /** When the current step-up stops authorising sensitive actions. */
    stepUpFreshUntil: z.string().datetime().nullable()
  })
});

/**
 * What `/me` says to a locked session: enough to draw the lock screen — whose
 * session, and which reauthentication to offer — and nothing the holder of the
 * cookie could not already have read while the session was active.
 */
export const adminLockedIdentityResponseSchema = z.object({
  state: z.literal("LOCKED"),
  displayName: z.string().min(1).max(120),
  strongAuthMethod: z.enum(["WEBAUTHN", "PASSWORD"])
});

export const adminMeResponseSchema = z.discriminatedUnion("state", [
  adminIdentityResponseSchema,
  adminLockedIdentityResponseSchema
]);

export const adminAuthenticatorSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(80),
  attachment: z.enum(["platform", "cross-platform"]).nullable(),
  /** True when the credential may be synchronised off its device. */
  backupEligible: z.boolean(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable()
});

export const adminAuthenticatorsResponseSchema = z.object({
  items: z.array(adminAuthenticatorSchema),
  /** How many usable authenticators this account must keep. Zero for roles
   * that sign in with a password alone. */
  minimumRequired: z.number().int().nonnegative(),
  usableCount: z.number().int().nonnegative()
});

/**
 * A WebAuthn options payload is produced by the library and handed to the
 * browser unchanged. It is the library's output, not this system's contract, so
 * it is carried opaquely rather than re-described field by field where it could
 * drift from what the library actually emits.
 */
export const webAuthnOptionsResponseSchema = z.object({
  ceremonyId: ceremonyIdSchema,
  options: z.record(z.string(), z.unknown())
});

/**
 * Options for a ceremony that acts on the current signed-in account.
 *
 * Browser tabs share cookies, so the account represented by a tab can change
 * between its `/me` check and this response. Echoing the server-selected owner
 * lets the tab abort before opening a WebAuthn prompt for a different account.
 * The value is only a consistency check; authorization still comes entirely
 * from the live server session.
 */
export const adminBoundWebAuthnOptionsResponseSchema = webAuthnOptionsResponseSchema.extend({
  adminUserId: z.string().uuid()
});

/**
 * The browser's credential response. Validated as a shape only: the library
 * performs the cryptographic verification, and duplicating its schema here
 * would risk rejecting responses it would have accepted.
 */
export const webAuthnCredentialSchema = z.object({
  id: z.string().min(1).max(400),
  rawId: z.string().min(1).max(400),
  type: z.literal("public-key"),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional()
});

export const verifyRegistrationBodySchema = z.object({
  ceremonyId: ceremonyIdSchema,
  credential: webAuthnCredentialSchema,
  label: z.string().trim().min(1).max(80)
});

export const verifyAuthenticationBodySchema = z.object({
  ceremonyId: ceremonyIdSchema,
  credential: webAuthnCredentialSchema
});

export const beginBreakGlassBodySchema = z.object({
  /** The sealed offline recovery code. Never logged, never echoed back. */
  recoveryCode: z.string().min(32).max(200)
});

export const revokeAuthenticatorBodySchema = z.object({
  /** Recorded in the audit event so a revocation is explainable later. */
  reason: z.string().trim().min(3).max(48)
});

export const adminHealthResponseSchema = z.object({
  service: z.literal("admin"),
  timestamp: z.string().datetime(),
  /** Confirms enforcement is live without disclosing anything operational. */
  authenticated: z.literal(true),
  role: adminRoleSchema
});

// ---------------------------------------------------------------------------
// Login, unlock and step-up
// ---------------------------------------------------------------------------

export const passwordLoginBodySchema = z
  .object({ username: usernameSchema, password: passwordSchema })
  .strict();

/**
 * What a correct password earns depends on the role: an Operator is signed in,
 * a privileged role is handed a WebAuthn ceremony to finish. The ceremony
 * exists only because the password verified, which is what binds the assertion
 * that follows to the knowledge factor that preceded it.
 */
export const passwordLoginResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("AUTHENTICATED"), identity: adminIdentityResponseSchema }),
  z.object({
    state: z.literal("WEBAUTHN_REQUIRED"),
    ceremonyId: ceremonyIdSchema,
    options: z.record(z.string(), z.unknown())
  })
]);

/** Reopening a locked session, or refreshing step-up, with the password. */
export const passwordProofBodySchema = z.object({ password: passwordSchema }).strict();

// ---------------------------------------------------------------------------
// One's own sessions
// ---------------------------------------------------------------------------

/**
 * One of the caller's sessions. The address and user agent are informational
 * context for "is this mine" — they are recorded observations, never identity:
 * nothing anywhere treats them as proof of which device this is.
 */
export const adminOwnSessionSchema = z.object({
  sessionId: z.string().uuid(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  state: z.enum(["ACTIVE", "LOCKED"]),
  ipAddress: z.string().max(64).nullable(),
  userAgent: z.string().max(280).nullable(),
  /** True for the session that asked. The page marks it and refuses to offer
   * revoking it as "another" session. */
  current: z.boolean()
});

export const adminOwnSessionsResponseSchema = z.object({
  items: z.array(adminOwnSessionSchema)
});

export const revokeOwnSessionsResponseSchema = z.object({
  revokedSessions: z.number().int().nonnegative()
});

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export const changePasswordBodySchema = z
  .object({
    /** Proof of knowledge, demanded even inside a fresh step-up: a borrowed
     * live session must never be enough to rotate the knowledge factor. */
    currentPassword: passwordSchema,
    newPassword: passwordSchema
  })
  .strict();

export const changePasswordResponseSchema = z.object({
  /** Every other session ends when the password changes. This one continues. */
  revokedSessions: z.number().int().nonnegative()
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const createInvitationBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    username: usernameSchema,
    role: adminRoleSchema,
    /** Recorded in the audit event: who is this person, why an account. */
    reason: z.string().trim().min(3).max(280)
  })
  .strict();

/**
 * The one and only time the invitation code leaves the server readable. The
 * database keeps a digest, so this response cannot be re-read or recovered —
 * the panel shows it once, and losing it means revoking and reissuing.
 */
export const createInvitationResponseSchema = z.object({
  invitationId: z.string().uuid(),
  adminUserId: z.string().uuid(),
  username: usernameSchema,
  role: adminRoleSchema,
  invitationCode: oneTimeCodeSchema,
  expiresAt: z.string().datetime()
});

export const adminInvitationSchema = z.object({
  invitationId: z.string().uuid(),
  adminUserId: z.string().uuid(),
  username: usernameSchema,
  displayName: z.string().max(120),
  role: adminRoleSchema,
  issuedByDisplayName: z.string().max(120).nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  /** PENDING until the account activates, then ACCEPTED; or REVOKED/EXPIRED. */
  status: z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"])
});

export const adminInvitationsResponseSchema = z.object({
  items: z.array(adminInvitationSchema)
});

export const invitationCodeBodySchema = z.object({ code: oneTimeCodeSchema }).strict();

/**
 * What the acceptance page needs to draw itself: whose account this is and
 * which steps remain. Returned only against a live invitation code, so it
 * discloses nothing to anybody the inviter did not hand the code to.
 */
export const invitationPreviewResponseSchema = z.object({
  displayName: z.string().max(120),
  username: usernameSchema,
  role: adminRoleSchema,
  passwordSet: z.boolean(),
  webAuthnRequired: z.boolean(),
  usableAuthenticators: z.number().int().nonnegative()
});

export const invitationPasswordBodySchema = z
  .object({ code: oneTimeCodeSchema, password: passwordSchema })
  .strict();

/**
 * Acceptance reports where the account stands, so the page can either move to
 * key enrolment or tell the person they are done and can sign in.
 */
export const invitationProgressResponseSchema = z.object({
  activated: z.boolean(),
  passwordSet: z.boolean(),
  webAuthnRequired: z.boolean(),
  usableAuthenticators: z.number().int().nonnegative()
});

export const invitationRegistrationBodySchema = z
  .object({
    code: oneTimeCodeSchema,
    ceremonyId: ceremonyIdSchema,
    credential: webAuthnCredentialSchema,
    label: z.string().trim().min(1).max(80)
  })
  .strict();

// ---------------------------------------------------------------------------
// Administrator-assisted password recovery
// ---------------------------------------------------------------------------

export const issuePasswordResetBodySchema = z
  .object({ reason: z.string().trim().min(3).max(280) })
  .strict();

/** Shown once to the issuing administrator, stored only as a digest. */
export const issuePasswordResetResponseSchema = z.object({
  resetId: z.string().uuid(),
  targetAdminUserId: z.string().uuid(),
  targetDisplayName: z.string().max(120),
  resetCode: oneTimeCodeSchema,
  expiresAt: z.string().datetime()
});

export const completePasswordResetBodySchema = z
  .object({ code: oneTimeCodeSchema, newPassword: passwordSchema })
  .strict();

/** Completing a reset ends every session the account had. */
export const completePasswordResetResponseSchema = z.object({
  revokedSessions: z.number().int().nonnegative()
});

export type AdminIdentityResponse = z.infer<typeof adminIdentityResponseSchema>;
export type AdminLockedIdentityResponse = z.infer<typeof adminLockedIdentityResponseSchema>;
export type AdminMeResponse = z.infer<typeof adminMeResponseSchema>;
export type PasswordLoginResponse = z.infer<typeof passwordLoginResponseSchema>;
export type AdminOwnSession = z.infer<typeof adminOwnSessionSchema>;
export type AdminOwnSessionsResponse = z.infer<typeof adminOwnSessionsResponseSchema>;
export type AdminInvitation = z.infer<typeof adminInvitationSchema>;
export type AdminInvitationsResponse = z.infer<typeof adminInvitationsResponseSchema>;
export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;
export type InvitationPreviewResponse = z.infer<typeof invitationPreviewResponseSchema>;
export type InvitationProgressResponse = z.infer<typeof invitationProgressResponseSchema>;
export type IssuePasswordResetResponse = z.infer<typeof issuePasswordResetResponseSchema>;
export type AdminAuthenticatorsResponse = z.infer<typeof adminAuthenticatorsResponseSchema>;
export type AdminBoundWebAuthnOptionsResponse = z.infer<
  typeof adminBoundWebAuthnOptionsResponseSchema
>;
export type WebAuthnOptionsResponse = z.infer<typeof webAuthnOptionsResponseSchema>;
export type WebAuthnCredential = z.infer<typeof webAuthnCredentialSchema>;
