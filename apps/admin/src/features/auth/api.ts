import type {
  AdminAuthenticatorsResponse,
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
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : "";
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isMutation = method !== "GET" && method !== "HEAD";
  const response = await fetch(path, {
    method,
    // Same-origin only. The admin plane is served from its own origin and the
    // session cookie is `SameSite=Strict`.
    credentials: "same-origin",
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
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? (payload.error as { code?: string; message?: string })
        : null;
    throw new AdminApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      // The server's messages are deliberately generic and safe to show.
      error?.message ?? "The request could not be completed."
    );
  }
  return payload as T;
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

  beginStepUp: () => call<CeremonyResponse>("POST", "/v1/admin/auth/step-up/options"),
  completeStepUp: (ceremonyId: string, credential: unknown) =>
    call<AdminIdentityResponse>("POST", "/v1/admin/auth/step-up/verify", {
      ceremonyId,
      credential
    }),

  authenticators: () => call<AdminAuthenticatorsResponse>("GET", "/v1/admin/authenticators"),
  beginEnrolment: () =>
    call<CeremonyResponse>("POST", "/v1/admin/authenticators/registration/options"),
  completeEnrolment: (ceremonyId: string, credential: unknown, label: string) =>
    call<{ authenticatorId: string }>("POST", "/v1/admin/authenticators/registration/verify", {
      ceremonyId,
      credential,
      label
    }),
  revokeAuthenticator: (authenticatorId: string, reason: string) =>
    call<void>("POST", `/v1/admin/authenticators/${authenticatorId}/revoke`, { reason })
};
