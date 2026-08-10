export {
  ADMIN_CAPABILITIES,
  ADMIN_ROLES,
  PRIVILEGED_ADMIN_ROLES,
  capabilitiesForRole,
  hasCapability,
  isAdminCapability,
  isAdminRole,
  isPrivilegedRole,
  requiresStepUp,
  riskOfCapability,
  type ActionRisk,
  type AdminCapability,
  type AdminRole
} from "./capabilities.js";

export {
  ADMIN_USER_STATUSES,
  MINIMUM_OPERATOR_AUTHENTICATORS,
  MINIMUM_PRIVILEGED_AUTHENTICATORS,
  canAuthenticate,
  canRevokeAuthenticator,
  evaluateActivation,
  evaluateAuthenticatorPolicy,
  isAdminUserStatus,
  minimumAuthenticators,
  type ActivationRejectionReason,
  type ActivationResult,
  type AdminUserStatus,
  type AuthenticatorPolicyResult,
  type AuthenticatorProperties,
  type AuthenticatorRejectionReason
} from "./authenticators.js";

export {
  canPerform,
  evaluateSession,
  hasFreshStepUp,
  nextIdleExpiry,
  type AdminSessionWindow,
  type SessionRejectionReason,
  type SessionValidity
} from "./sessions.js";

export {
  adminAuthenticatorSchema,
  adminAuthenticatorsResponseSchema,
  adminBoundWebAuthnOptionsResponseSchema,
  adminCapabilitySchema,
  adminHealthResponseSchema,
  adminIdentityResponseSchema,
  adminRoleSchema,
  beginBreakGlassBodySchema,
  ceremonyIdSchema,
  revokeAuthenticatorBodySchema,
  verifyAuthenticationBodySchema,
  verifyRegistrationBodySchema,
  webAuthnCredentialSchema,
  webAuthnOptionsResponseSchema,
  type AdminAuthenticatorsResponse,
  type AdminBoundWebAuthnOptionsResponse,
  type AdminIdentityResponse,
  type WebAuthnCredential,
  type WebAuthnOptionsResponse
} from "./contracts.js";
