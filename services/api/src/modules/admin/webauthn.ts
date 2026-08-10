import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";

import type { WebAuthnCredential } from "@printing-kiosk/admin-access";

/**
 * The WebAuthn ceremonies, as this system wants them configured.
 *
 * The cryptography lives in `@simplewebauthn/server`; what lives here is the
 * policy around it — which authenticators we ask for, what we refuse, and what
 * we extract from a verified result. Keeping that in one place means the
 * registration and authentication paths cannot drift apart on, say, user
 * verification.
 *
 * Two settings are deliberate and load-bearing:
 *
 * `userVerification: "required"` means the authenticator must confirm a person
 * — a PIN, a biometric — not merely that a key is plugged in. A key left in a
 * laptop is otherwise a bearer token.
 *
 * `residentKey: "required"` makes the credential discoverable, so login needs
 * no username. That removes account enumeration entirely: there is no field an
 * attacker can probe to learn whether an account exists.
 */

export interface WebAuthnRelyingParty {
  id: string;
  name: string;
  origin: string;
}

export interface RegistrationCeremonyInput {
  relyingParty: WebAuthnRelyingParty;
  /** Typed with an explicit ArrayBuffer so it matches the library's signature. */
  userHandle: Uint8Array<ArrayBuffer>;
  displayName: string;
  /** Credentials already enrolled, so an authenticator refuses to double-enrol. */
  existingCredentialIds: readonly string[];
  /** Technical Admins must present a roaming, non-exportable key. */
  requireCrossPlatform: boolean;
}

export async function createRegistrationOptions(input: RegistrationCeremonyInput) {
  return generateRegistrationOptions({
    rpID: input.relyingParty.id,
    rpName: input.relyingParty.name,
    userID: input.userHandle,
    // WebAuthn requires a name; the display name is what an operator recognises.
    // It is never an email address, so nothing here identifies a person beyond
    // what a colleague already knows.
    userName: input.displayName,
    userDisplayName: input.displayName,
    attestationType: "none",
    // Enrolling the same authenticator twice would look like a spare while
    // being a single point of failure.
    excludeCredentials: input.existingCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
      ...(input.requireCrossPlatform ? { authenticatorAttachment: "cross-platform" as const } : {})
    },
    supportedAlgorithmIDs: [-7, -257]
  });
}

export interface VerifyRegistrationInput {
  relyingParty: WebAuthnRelyingParty;
  expectedChallenge: string;
  credential: WebAuthnCredential;
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  signCount: number;
  transports: string[];
  attachment: "platform" | "cross-platform" | null;
  backupEligible: boolean;
  backedUp: boolean;
  aaguid: string | null;
}

export async function verifyRegistration(
  input: VerifyRegistrationInput
): Promise<VerifiedRegistration | null> {
  const verification = await verifyRegistrationResponse({
    // The library's input type is the browser's own credential shape; ours is
    // validated for size and structure before it reaches here.
    response: input.credential as never,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.relyingParty.origin,
    expectedRPID: input.relyingParty.id,
    requireUserVerification: true
  });

  if (!verification.verified || !verification.registrationInfo) return null;
  const info = verification.registrationInfo;

  return {
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    signCount: info.credential.counter,
    transports: info.credential.transports ?? [],
    attachment: normalizeAttachment(input.credential.authenticatorAttachment),
    // These two flags are what distinguish a device-bound hardware key from a
    // passkey synchronised through a vendor account.
    backupEligible: info.credentialBackedUp || info.credentialDeviceType === "multiDevice",
    backedUp: info.credentialBackedUp,
    aaguid: info.aaguid || null
  };
}

export interface AuthenticationCeremonyInput {
  relyingParty: WebAuthnRelyingParty;
  /**
   * Left empty for login: the credential is discoverable, so the authenticator
   * chooses, and the server learns the account only from a verified answer.
   * Populated for step-up, where the account is already known.
   */
  allowCredentialIds: readonly string[];
}

export async function createAuthenticationOptions(input: AuthenticationCeremonyInput) {
  return generateAuthenticationOptions({
    rpID: input.relyingParty.id,
    userVerification: "required",
    ...(input.allowCredentialIds.length > 0
      ? { allowCredentials: input.allowCredentialIds.map((id) => ({ id })) }
      : {})
  });
}

export interface VerifyAuthenticationInput {
  relyingParty: WebAuthnRelyingParty;
  expectedChallenge: string;
  credential: WebAuthnCredential;
  storedCredential: {
    id: string;
    publicKey: Uint8Array<ArrayBuffer>;
    signCount: number;
    transports: string[];
  };
}

export interface VerifiedAuthentication {
  newSignCount: number;
}

export async function verifyAuthentication(
  input: VerifyAuthenticationInput
): Promise<VerifiedAuthentication | null> {
  const verification = await verifyAuthenticationResponse({
    response: input.credential as never,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.relyingParty.origin,
    expectedRPID: input.relyingParty.id,
    requireUserVerification: true,
    credential: {
      id: input.storedCredential.id,
      publicKey: input.storedCredential.publicKey,
      counter: input.storedCredential.signCount,
      transports: input.storedCredential.transports as never
    }
  });

  if (!verification.verified) return null;
  return { newSignCount: verification.authenticationInfo.newCounter };
}

/**
 * A cloned authenticator gives itself away by reusing or rewinding its counter.
 * Authenticators that do not implement a counter report zero forever, which is
 * legitimate and must not be treated as a clone.
 */
export function isSignCountRegression(previous: number, next: number): boolean {
  if (previous === 0 && next === 0) return false;
  return next <= previous;
}

function normalizeAttachment(value: string | undefined): "platform" | "cross-platform" | null {
  return value === "platform" || value === "cross-platform" ? value : null;
}
