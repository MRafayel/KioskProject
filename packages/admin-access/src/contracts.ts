import { z } from "zod";

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
  adminUserId: z.string().uuid(),
  displayName: z.string().min(1).max(120),
  role: adminRoleSchema,
  capabilities: z.array(adminCapabilitySchema),
  /** Kiosks this account may act on. Empty means no kiosk-bound action. */
  kioskScopes: z.array(z.string().max(64)),
  session: z.object({
    idleExpiresAt: z.string().datetime(),
    hardExpiresAt: z.string().datetime(),
    /** When the current step-up stops authorising sensitive actions. */
    stepUpFreshUntil: z.string().datetime().nullable()
  })
});

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
  /** How many usable authenticators this account must keep. */
  minimumRequired: z.number().int().positive(),
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

export type AdminIdentityResponse = z.infer<typeof adminIdentityResponseSchema>;
export type AdminAuthenticatorsResponse = z.infer<typeof adminAuthenticatorsResponseSchema>;
export type AdminBoundWebAuthnOptionsResponse = z.infer<
  typeof adminBoundWebAuthnOptionsResponseSchema
>;
export type WebAuthnOptionsResponse = z.infer<typeof webAuthnOptionsResponseSchema>;
export type WebAuthnCredential = z.infer<typeof webAuthnCredentialSchema>;
