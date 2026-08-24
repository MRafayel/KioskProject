import {
  adminAuthenticatorsResponseSchema,
  adminIdentityResponseSchema,
  adminInvitationsResponseSchema,
  adminMeResponseSchema,
  adminOwnSessionsResponseSchema,
  changePasswordResponseSchema,
  completePasswordResetResponseSchema,
  createInvitationResponseSchema,
  invitationPreviewResponseSchema,
  invitationProgressResponseSchema,
  issuePasswordResetResponseSchema,
  passwordLoginResponseSchema,
  revokeOwnSessionsResponseSchema,
  type AdminBoundWebAuthnOptionsResponse,
  type AdminRole
} from "@printing-kiosk/admin-access";

/**
 * The admin API client.
 *
 * Two things matter here. Every mutating request carries the CSRF token from
 * the readable half of the double-submit cookie, and every response is checked
 * for the three refusals the UI must handle differently from an ordinary
 * error: "sign in again", "unlock your session", and "prove it is you again".
 *
 * The client never decides what the operator may do. It reads the capability
 * list to choose what to render, and the server refuses anything it should not
 * have regardless of what this file believes.
 */

const CSRF_COOKIE = "__Host-admin_csrf";
export const ADMIN_REQUEST_TIMEOUT_MILLISECONDS = 15_000;

export class AdminApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AdminApiError";
  }

  /** The session is gone. The UI must return to the sign-in screen. */
  public get requiresSignIn(): boolean {
    return this.status === 401 && this.code === "ADMIN_AUTHENTICATION_REQUIRED";
  }

  /** The session is locked, not gone. The UI shows the lock screen. */
  public get requiresUnlock(): boolean {
    return this.status === 401 && this.code === "ADMIN_SESSION_LOCKED";
  }

  /** The action needs a fresh strong reauthentication before it is accepted. */
  public get requiresStepUp(): boolean {
    return this.status === 401 && this.code === "ADMIN_STEP_UP_REQUIRED";
  }
}

function readCsrfToken(): string {
  const match = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
  if (!match) return "";

  // A malformed cookie must fail closed at the API boundary rather than throw
  // before the request is sent. The server will reject the empty token.
  try {
    return decodeURIComponent(match.slice(CSRF_COOKIE.length + 1));
  } catch {
    return "";
  }
}

/**
 * The single request path for the whole control plane.
 *
 * Exported so the operational panels use exactly this one — same CSRF handling,
 * same timeout, same two refusals recognised the same way. A second fetch
 * wrapper would eventually disagree with this one about what "your session is
 * gone" looks like.
 */
export async function adminRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  return call<T>(method, path, body);
}

/**
 * Anything that can turn an unknown payload into a known one, or throw.
 *
 * Structural rather than a Zod type, so this file does not take a dependency on
 * the validation library to state what it needs. The shared contracts satisfy
 * it as they are.
 */
export interface AdminResponseSchema<T> {
  parse: (value: unknown) => T;
}

/**
 * The same request, with the response checked against the contract at runtime.
 *
 * A generic parameter is a compile-time claim about a server this code does not
 * compile with. It is erased before the first request is ever sent, so an older
 * page talking to a newer control plane will cast whatever arrives into the
 * shape it expected and draw it — a role it does not recognise, a capability
 * list that is now an object, an attention code with no label — silently, and
 * looking authoritative while doing it.
 *
 * Not every response needs this. Long lists of rows are shown as they are and a
 * wrong field is visible as a wrong field. It is worth the cost where being
 * wrong is not obvious on screen: who you are, what you may do, how long your
 * session lasts, and which states the operational counts claim to be in.
 */
export async function adminRequestParsed<T>(
  schema: AdminResponseSchema<T>,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const payload = await call<unknown>(method, path, body);
  try {
    return schema.parse(payload);
  } catch (error) {
    // The paths are useful and safe to print; the values are neither, and one
    // of them could be a customer's data. Only the shape is reported, and only
    // to the console — the operator gets the generic message below.
    reportSchemaMismatch(path, error);
    throw new AdminApiError(
      200,
      "INVALID_RESPONSE",
      "The control plane returned something this page does not understand. It may be running a newer version — reload before relying on what is shown."
    );
  }
}

function reportSchemaMismatch(path: string, error: unknown): void {
  const issues =
    error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? error.issues
          .slice(0, 8)
          .map((issue: unknown) =>
            issue && typeof issue === "object" && "path" in issue && Array.isArray(issue.path)
              ? issue.path.join(".")
              : "?"
          )
      : [];
  console.error(`Admin response did not match its contract: ${path}`, { fields: issues });
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isMutation = method !== "GET" && method !== "HEAD";
  const response = await fetch(path, {
    method,
    // Same-origin only. The admin plane is served from its own origin and the
    // session cookie is `SameSite=Strict`.
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MILLISECONDS),
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(isMutation ? { "x-csrf-token": readCsrfToken() } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = readErrorPayload(payload);
    throw new AdminApiError(
      response.status,
      error.code,
      // The server's messages are deliberately generic and safe to show.
      error.message
    );
  }
  if (payload === null) {
    throw new AdminApiError(
      response.status,
      "INVALID_RESPONSE",
      "The control plane returned an invalid response."
    );
  }
  return payload as T;
}

function readErrorPayload(payload: unknown): { code: string; message: string } {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return { code: "UNKNOWN", message: "The request could not be completed." };
  }

  const value = payload.error;
  if (!value || typeof value !== "object") {
    return { code: "UNKNOWN", message: "The request could not be completed." };
  }

  const code = "code" in value && typeof value.code === "string" ? value.code : "UNKNOWN";
  const message =
    "message" in value && typeof value.message === "string" && value.message.length <= 500
      ? value.message
      : "The request could not be completed.";
  return { code, message };
}

export interface CeremonyResponse {
  ceremonyId: string;
  options: Record<string, unknown>;
}

export const adminApi = {
  // Identity is parsed rather than cast wherever it arrives. Role, capability
  // list and session windows all come from here, and every visibility decision
  // this app makes is downstream of them. `/me` answers for a locked session
  // too, which is what lets a reopened browser draw the lock screen instead of
  // the sign-in form.
  me: () => adminRequestParsed(adminMeResponseSchema, "GET", "/v1/admin/me"),
  health: () => call<{ role: string; timestamp: string }>("GET", "/v1/admin/health"),
  logout: () => call<void>("POST", "/v1/admin/auth/logout"),

  // Login is a password first for everybody; the response says whether a
  // security key is still owed.
  login: (username: string, password: string) =>
    adminRequestParsed(passwordLoginResponseSchema, "POST", "/v1/admin/auth/login", {
      username,
      password
    }),
  completeLoginWebAuthn: (ceremonyId: string, credential: unknown) =>
    adminRequestParsed(adminIdentityResponseSchema, "POST", "/v1/admin/auth/login/webauthn", {
      ceremonyId,
      credential
    }),

  // Unlocking a locked session: one key touch, or the password.
  beginUnlock: () =>
    call<AdminBoundWebAuthnOptionsResponse>("POST", "/v1/admin/auth/unlock/options"),
  completeUnlock: (ceremonyId: string, credential: unknown) =>
    adminRequestParsed(adminIdentityResponseSchema, "POST", "/v1/admin/auth/unlock/verify", {
      ceremonyId,
      credential
    }),
  unlockWithPassword: (password: string) =>
    adminRequestParsed(adminIdentityResponseSchema, "POST", "/v1/admin/auth/unlock/password", {
      password
    }),

  beginStepUp: () =>
    call<AdminBoundWebAuthnOptionsResponse>("POST", "/v1/admin/auth/step-up/options"),
  // The step-up response is what tells this page a sensitive action is now
  // authorised and for how long. Trusting an unread shape here would let a
  // malformed reply present as a fresh assertion.
  completeStepUp: (ceremonyId: string, credential: unknown) =>
    adminRequestParsed(adminIdentityResponseSchema, "POST", "/v1/admin/auth/step-up/verify", {
      ceremonyId,
      credential
    }),
  stepUpWithPassword: (password: string) =>
    adminRequestParsed(adminIdentityResponseSchema, "POST", "/v1/admin/auth/step-up/password", {
      password
    }),

  authenticators: () =>
    adminRequestParsed(adminAuthenticatorsResponseSchema, "GET", "/v1/admin/authenticators"),
  beginEnrolment: () =>
    call<AdminBoundWebAuthnOptionsResponse>(
      "POST",
      "/v1/admin/authenticators/registration/options"
    ),
  completeEnrolment: (ceremonyId: string, credential: unknown, label: string) =>
    call<{ authenticatorId: string }>("POST", "/v1/admin/authenticators/registration/verify", {
      ceremonyId,
      credential,
      label
    }),
  revokeAuthenticator: (authenticatorId: string, reason: string) =>
    call<void>("POST", `/v1/admin/authenticators/${encodeURIComponent(authenticatorId)}/revoke`, {
      reason
    }),

  // One's own sessions, and the two protective actions on them.
  ownSessions: () =>
    adminRequestParsed(adminOwnSessionsResponseSchema, "GET", "/v1/admin/account/sessions"),
  revokeOwnSession: (sessionId: string) =>
    call<void>("POST", `/v1/admin/account/sessions/${encodeURIComponent(sessionId)}/revoke`),
  revokeOtherSessions: () =>
    adminRequestParsed(
      revokeOwnSessionsResponseSchema,
      "POST",
      "/v1/admin/account/sessions/revoke-others"
    ),
  changePassword: (currentPassword: string, newPassword: string) =>
    adminRequestParsed(changePasswordResponseSchema, "POST", "/v1/admin/account/password", {
      currentPassword,
      newPassword
    }),

  // Invitations — the authorized side.
  invitations: () =>
    adminRequestParsed(adminInvitationsResponseSchema, "GET", "/v1/admin/invitations"),
  createInvitation: (input: {
    displayName: string;
    username: string;
    role: AdminRole;
    reason: string;
  }) => adminRequestParsed(createInvitationResponseSchema, "POST", "/v1/admin/invitations", input),
  revokeInvitation: (invitationId: string) =>
    call<void>("POST", `/v1/admin/invitations/${encodeURIComponent(invitationId)}/revoke`),
  reissueInvitation: (adminUserId: string, reason: string) =>
    call<{ invitationId: string; invitationCode: string; expiresAt: string }>(
      "POST",
      `/v1/admin/people/${encodeURIComponent(adminUserId)}/invitation`,
      { reason }
    ),

  // Password recovery — the authorized side.
  issuePasswordReset: (adminUserId: string, reason: string) =>
    adminRequestParsed(
      issuePasswordResetResponseSchema,
      "POST",
      `/v1/admin/people/${encodeURIComponent(adminUserId)}/password-reset`,
      { reason }
    ),
  revokePasswordReset: (resetId: string) =>
    call<void>("POST", `/v1/admin/password-resets/${encodeURIComponent(resetId)}/revoke`),

  // Invitation acceptance — the unauthenticated side.
  previewInvitation: (code: string) =>
    adminRequestParsed(
      invitationPreviewResponseSchema,
      "POST",
      "/v1/admin/auth/invitation/preview",
      {
        code
      }
    ),
  setInvitationPassword: (code: string, password: string) =>
    adminRequestParsed(
      invitationProgressResponseSchema,
      "POST",
      "/v1/admin/auth/invitation/password",
      { code, password }
    ),
  beginInvitationEnrolment: (code: string) =>
    call<CeremonyResponse>("POST", "/v1/admin/auth/invitation/registration/options", { code }),
  completeInvitationEnrolment: (
    code: string,
    ceremonyId: string,
    credential: unknown,
    label: string
  ) =>
    call<{ authenticatorId: string; activated: boolean }>(
      "POST",
      "/v1/admin/auth/invitation/registration/verify",
      { code, ceremonyId, credential, label }
    ),

  // Password reset completion — the unauthenticated side.
  completePasswordReset: (code: string, newPassword: string) =>
    adminRequestParsed(
      completePasswordResetResponseSchema,
      "POST",
      "/v1/admin/auth/password-reset/complete",
      { code, newPassword }
    ),

  beginBreakGlassEnrolment: (recoveryCode: string) =>
    call<CeremonyResponse>("POST", "/v1/admin/auth/break-glass/registration/options", {
      recoveryCode
    }),
  completeBreakGlassEnrolment: (ceremonyId: string, credential: unknown, label: string) =>
    call<{ authenticatorId: string }>("POST", "/v1/admin/auth/break-glass/registration/verify", {
      ceremonyId,
      credential,
      label
    })
};
