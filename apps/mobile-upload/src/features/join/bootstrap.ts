import {
  mobileContextResponseSchema,
  mobileExchangeRequestSchema,
  publicSessionIdSchema,
  uploadTokenSchema,
  type MobileContextResponse
} from "@printing-kiosk/contracts";

import { secureRandomUuid } from "../security/random.js";

const CLIENT_NONCE_KEY_PREFIX = "printing-kiosk:mobile-client-nonce:";
export const MOBILE_REQUEST_TIMEOUT_MS = 15_000;

export type CapturedQrGrant =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "present"; token: string }>;

export class MobileRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number | null = null
  ) {
    super(code);
    this.name = "MobileRequestError";
  }
}

export interface BootstrapDependencies {
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  randomUUID: () => string;
  requestTimeoutMs?: number;
}

export interface MobileBootstrapController {
  /**
   * Shares an active attempt across React StrictMode remounts. If an attempt
   * fails, a later call retries with the same in-memory grant and client nonce.
   */
  run: () => Promise<MobileContextResponse>;
}

/**
 * Reads the QR bearer credential once and removes the complete fragment before
 * React, analytics, or any other application code can observe it.
 */
export function captureQrGrant(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">
): CapturedQrGrant {
  const rawFragment = location.hash;
  if (rawFragment) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  if (!rawFragment) return { kind: "missing" };

  const parameters = new URLSearchParams(rawFragment.slice(1));
  const tokens = parameters.getAll("t");
  const containsOnlyToken = [...parameters.keys()].every((key) => key === "t");
  if (tokens.length !== 1 || !containsOnlyToken) return { kind: "invalid" };

  const parsed = uploadTokenSchema.safeParse(tokens[0]);
  return parsed.success ? { kind: "present", token: parsed.data } : { kind: "invalid" };
}

export function getPublicSessionIdFromPath(pathname: string): string | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;

  let segment: string;
  try {
    segment = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  const parsed = publicSessionIdSchema.safeParse(segment);
  return parsed.success ? parsed.data : null;
}

/**
 * Call exactly once before mounting React. Components may await the returned
 * promise more than once (including React StrictMode remounts) without issuing
 * duplicate exchanges.
 */
export function startMobileBootstrap(
  publicSessionId: string,
  grant: CapturedQrGrant,
  dependencies: BootstrapDependencies = browserDependencies()
): Promise<MobileContextResponse> {
  return createMobileBootstrap(publicSessionId, grant, dependencies).run();
}

/**
 * Keeps a QR bearer only in this controller's memory until the exchange
 * succeeds. A transient failure can then safely retry with the same nonce;
 * neither value is placed in localStorage or a URL.
 */
export function createMobileBootstrap(
  publicSessionId: string,
  initialGrant: CapturedQrGrant,
  dependencies: BootstrapDependencies = browserDependencies()
): MobileBootstrapController {
  let retainedGrant = initialGrant;
  let retainedNonce: string | null = null;
  let completed: MobileContextResponse | null = null;
  let inFlight: Promise<MobileContextResponse> | null = null;

  const run = (): Promise<MobileContextResponse> => {
    if (completed) return Promise.resolve(completed);
    if (inFlight) return inFlight;

    const attempt = bootstrapMobileSession(publicSessionId, retainedGrant, dependencies, () => {
      retainedNonce ??= getOrCreateNonce(
        `${CLIENT_NONCE_KEY_PREFIX}${publicSessionId}`,
        dependencies
      );
      return retainedNonce;
    }).then((context) => {
      completed = context;
      retainedGrant = { kind: "missing" };
      retainedNonce = null;
      safelyRemoveStorageValue(
        dependencies.storage,
        `${CLIENT_NONCE_KEY_PREFIX}${publicSessionId}`
      );
      return context;
    });

    inFlight = attempt;
    void attempt
      .finally(() => {
        if (inFlight === attempt) inFlight = null;
      })
      .catch(() => undefined);
    return attempt;
  };

  return { run };
}

async function bootstrapMobileSession(
  publicSessionId: string,
  grant: CapturedQrGrant,
  dependencies: BootstrapDependencies,
  getClientNonce: () => string
): Promise<MobileContextResponse> {
  const parsedPublicId = publicSessionIdSchema.safeParse(publicSessionId);
  if (!parsedPublicId.success || grant.kind === "invalid") {
    throw new MobileRequestError("INVALID_UPLOAD_LINK");
  }

  let response: Response;

  if (grant.kind === "present") {
    const clientNonce = getClientNonce();
    const request = mobileExchangeRequestSchema.parse({
      publicSessionId: parsedPublicId.data,
      uploadToken: grant.token,
      clientNonce
    });

    response = await safeMobileFetch(
      dependencies.fetch,
      "/v1/mobile-auth/exchange",
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      },
      dependencies.requestTimeoutMs
    );
  } else {
    response = await safeMobileFetch(
      dependencies.fetch,
      `/v1/mobile-auth/${encodeURIComponent(parsedPublicId.data)}/context`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" }
      },
      dependencies.requestTimeoutMs
    );
  }

  if (!response.ok) throw await toMobileRequestError(response);

  const context = mobileContextResponseSchema.safeParse(await safeJson(response));
  if (!context.success || context.data.session.publicId !== parsedPublicId.data) {
    throw new MobileRequestError("INVALID_SERVER_RESPONSE", response.status);
  }

  return context.data;
}

function browserDependencies(): BootstrapDependencies {
  return {
    fetch: window.fetch.bind(window),
    storage: window.sessionStorage,
    randomUUID: () => secureRandomUuid(window.crypto)
  };
}

function getOrCreateNonce(key: string, dependencies: BootstrapDependencies): string {
  try {
    const stored = dependencies.storage.getItem(key);
    if (
      stored &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)
    ) {
      return stored;
    }
  } catch {
    // Some private-browser modes deny storage. The exchange still works with
    // an in-memory nonce for this page load.
  }

  const nonce = dependencies.randomUUID();
  try {
    dependencies.storage.setItem(key, nonce);
  } catch {
    // See the private-browser note above.
  }
  return nonce;
}

function safelyRemoveStorageValue(storage: Pick<Storage, "removeItem">, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A successful exchange must not fail only because storage is unavailable.
  }
}

export async function safeMobileFetch(
  fetchImplementation: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = MOBILE_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImplementation(input, { ...init, signal: controller.signal });
  } catch {
    throw new MobileRequestError(timedOut ? "REQUEST_TIMEOUT" : "NETWORK_UNAVAILABLE");
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MobileRequestError("INVALID_SERVER_RESPONSE", response.status);
  }
}

export async function toMobileRequestError(response: Response): Promise<MobileRequestError> {
  let code = "REQUEST_FAILED";
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(body.error.code)
    ) {
      code = body.error.code;
    }
  } catch {
    // Server text and parser details are intentionally not shown to customers.
  }

  return new MobileRequestError(code, response.status);
}
