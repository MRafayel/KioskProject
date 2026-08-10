import type {
  AdminAuthenticatorsResponse,
  AdminBoundWebAuthnOptionsResponse,
  AdminIdentityResponse
} from "@printing-kiosk/admin-access";

/**
 * The admin API client.
 *
 * Two things matter here. Every mutating request carries the CSRF token from
 * the readable half of the double-submit cookie, and every response is checked
 * for the two refusals the UI must handle differently from an ordinary error:
 * "sign in again" and "touch your key again".
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

  /** The action needs a fresh assertion before it will be accepted. */
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
  me: () => call<AdminIdentityResponse>("GET", "/v1/admin/me"),
  health: () => call<{ role: string; timestamp: string }>("GET", "/v1/admin/health"),
  logout: () => call<void>("POST", "/v1/admin/auth/logout"),

  beginSignIn: () => call<CeremonyResponse>("POST", "/v1/admin/auth/authentication/options"),
  completeSignIn: (ceremonyId: string, credential: unknown) =>
    call<AdminIdentityResponse>("POST", "/v1/admin/auth/authentication/verify", {
      ceremonyId,
      credential
    }),

  beginStepUp: () =>
    call<AdminBoundWebAuthnOptionsResponse>("POST", "/v1/admin/auth/step-up/options"),
  completeStepUp: (ceremonyId: string, credential: unknown) =>
    call<AdminIdentityResponse>("POST", "/v1/admin/auth/step-up/verify", {
      ceremonyId,
      credential
    }),

  authenticators: () => call<AdminAuthenticatorsResponse>("GET", "/v1/admin/authenticators"),
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
