import {
  createSessionResponseSchema,
  filePagesResponseSchema,
  getSessionResponseSchema,
  listUploadedFilesResponseSchema,
  type FilePagesResponse
} from "@printing-kiosk/contracts";

import type { Locale } from "../i18n/messages.js";
import type { PrototypeFile, PrototypeSession } from "./model.js";
import { clearStoredPaymentKeys } from "./paymentService.js";
import { clearStoredPricingKeys } from "./pricingService.js";

const CREATE_KEY_STORAGE = "printing-kiosk.pending-create";
const CANCEL_KEY_PREFIX = "printing-kiosk.pending-cancel.";
const DELETE_KEY_PREFIX = "printing-kiosk.pending-file-delete.";
const inFlightClosures = new Map<string, Promise<void>>();

export type KioskFilePages = FilePagesResponse;

interface PendingCreate {
  key: string;
  locale: Locale;
}

/**
 * A session that stands between this kiosk and a new customer. The first is a
 * fresh request blocked by an active session; the second is this kiosk's own
 * stored request for a session that has moved past the point where its QR
 * grant can be safely handed out again — which is what happens as soon as an
 * uploaded document is validated.
 */
const BLOCKING_SESSION_CODES = new Set([
  "ACTIVE_SESSION_EXISTS",
  "SESSION_UPLOAD_GRANT_REPLAY_UNAVAILABLE"
]);
const OPERATOR_RECOVERY_STATES = new Set(["PAID", "PRINTING", "FAILED", "RECOVERY_REQUIRED"]);
const TERMINAL_SESSION_STATES = new Set(["COMPLETED", "CANCELED", "EXPIRED"]);
const CANCEL_VERSION_ATTEMPTS = 2;

export class SessionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "SessionRequestError";
  }
}

export async function createKioskSession(locale: Locale): Promise<PrototypeSession> {
  // A reload loses the in-memory session while the authoritative one stays
  // active, so the stored request is the only handle back to it. Replaying it
  // exactly — key and original locale together — is what the API accepts; a
  // fresh key would be refused with ACTIVE_SESSION_EXISTS until expiry.
  const pending = readPendingCreate() ?? storePendingCreate(newIdempotencyKey(), locale);
  const response = await postCreateSession(pending);

  // 410 means that stored session is already finished. Only then is a genuinely
  // new session correct, and it uses the language in front of the customer now.
  if (response.status === 410) {
    return parseCreateResponse(
      await postCreateSession(storePendingCreate(newIdempotencyKey(), locale))
    );
  }

  if (response.status === 409) {
    const failure = await readSessionConflict(response);
    if (!BLOCKING_SESSION_CODES.has(failure.code ?? "")) {
      throw new SessionRequestError(failure.code ?? "SESSION_CREATE_FAILED", response.status);
    }

    assertSessionCanBeDiscarded(failure.currentState);

    // Somebody is standing at the screen asking to print, and the kiosk can no
    // longer return them to the session that is in the way — its QR grant is
    // already claimed. Leaving the terminal dead until that session expires is
    // the worse answer, so the kiosk closes it, which also removes the previous
    // customer's documents, and starts fresh.
    await discardBlockingSession(failure.sessionId);
    return parseCreateResponse(
      await postCreateSession(storePendingCreate(newIdempotencyKey(), locale))
    );
  }

  return parseCreateResponse(response);
}

async function discardBlockingSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;

  // The version is read rather than assumed: the blocked create reports which
  // session is in the way, but a document finishing validation moves its
  // version at any moment.
  const snapshot = await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (!snapshot.ok) {
    if (snapshot.status === 404 || snapshot.status === 410) {
      // Already expired or cleaned up; nothing is in the way any more.
      clearStoredSessionKeys(sessionId);
      return;
    }
    throw await sessionRequestError(snapshot, "SESSION_RECOVERY_FAILED");
  }

  const session = getSessionResponseSchema.parse(await snapshot.json()).session;
  assertSessionCanBeDiscarded(session.state);
  const cancelResponse = await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    headers: {
      "idempotency-key": `kiosk-recover-${sessionId}-${session.version}`,
      "if-match": `"${session.version}"`
    }
  });

  if (!cancelResponse.ok && cancelResponse.status !== 404 && cancelResponse.status !== 410) {
    throw await sessionRequestError(cancelResponse, "SESSION_RECOVERY_FAILED");
  }
  clearStoredSessionKeys(sessionId);
}

function assertSessionCanBeDiscarded(state: string | undefined): void {
  if (!state || !OPERATOR_RECOVERY_STATES.has(state)) return;
  throw new SessionRequestError(
    state === "PAID" || state === "PRINTING"
      ? "PAID_SESSION_REQUIRES_FULFILLMENT"
      : "SESSION_REQUIRES_OPERATOR_RECOVERY",
    409
  );
}

async function readSessionConflict(
  response: Response
): Promise<{ code?: string; sessionId?: string; currentState?: string }> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    const sessionId = body.error?.details?.sessionId;
    const currentState = body.error?.details?.currentState;
    return {
      ...(body.error?.code ? { code: body.error.code } : {}),
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      ...(typeof currentState === "string" ? { currentState } : {})
    };
  } catch {
    return {};
  }
}

async function postCreateSession(pending: PendingCreate): Promise<Response> {
  return fetch("/agent/v1/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": pending.key
    },
    body: JSON.stringify({ locale: pending.locale })
  });
}

async function parseCreateResponse(response: Response): Promise<PrototypeSession> {
  if (!response.ok) throw await sessionRequestError(response, "SESSION_CREATE_FAILED");

  const result = createSessionResponseSchema.parse(await response.json());
  return {
    id: result.session.id,
    publicId: result.session.publicId,
    version: result.session.version,
    uploadUrl: result.upload.qrUrl,
    expiresAt: result.session.expiresAt,
    hardExpiresAt: result.session.hardExpiresAt
  };
}

export async function closeKioskSession(session: PrototypeSession): Promise<void> {
  const inFlight = inFlightClosures.get(session.id);
  if (inFlight) return inFlight;

  const closure = closeKioskSessionOnce(session);
  inFlightClosures.set(session.id, closure);
  try {
    await closure;
  } finally {
    inFlightClosures.delete(session.id);
  }
}

async function closeKioskSessionOnce(session: PrototypeSession): Promise<void> {
  const storageKey = `${CANCEL_KEY_PREFIX}${session.id}`;
  const idempotencyKey = sessionStorage.getItem(storageKey) ?? newIdempotencyKey();
  sessionStorage.setItem(storageKey, idempotencyKey);

  // Upload processing, settings, quotes, and payments all advance the session
  // version. The React session is intentionally lightweight and can therefore
  // be stale by the time a customer presses Cancel. Read the authoritative
  // version immediately before cancellation instead of sending the version
  // captured when the session was first created.
  for (let attempt = 0; attempt < CANCEL_VERSION_ATTEMPTS; attempt += 1) {
    const snapshot = await fetch(`/agent/v1/sessions/${encodeURIComponent(session.id)}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    if (!snapshot.ok) {
      if (snapshot.status === 404 || snapshot.status === 410) {
        clearStoredSessionKeys(session.id);
        return;
      }
      throw await sessionRequestError(snapshot, "SESSION_CANCEL_FAILED");
    }

    const current = getSessionResponseSchema.parse(await snapshot.json()).session;
    if (TERMINAL_SESSION_STATES.has(current.state)) {
      clearStoredSessionKeys(session.id);
      return;
    }
    assertSessionCanBeDiscarded(current.state);

    const response = await fetch(`/agent/v1/sessions/${encodeURIComponent(session.id)}/cancel`, {
      method: "POST",
      headers: {
        "idempotency-key": idempotencyKey,
        "if-match": `"${current.version}"`
      },
      keepalive: true
    });

    if (response.ok || response.status === 404 || response.status === 410) {
      clearStoredSessionKeys(session.id);
      return;
    }
    // A worker or another customer action may advance the version between the
    // GET and POST. Refresh once and retry with the same stable idempotency key.
    if (response.status === 412 && attempt + 1 < CANCEL_VERSION_ATTEMPTS) continue;
    throw await sessionRequestError(response, "SESSION_CANCEL_FAILED");
  }
}

export async function listKioskSessionFiles(sessionId: string): Promise<PrototypeFile[]> {
  const response = await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}/files`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) throw await sessionRequestError(response, "SESSION_FILES_FAILED");

  const result = listUploadedFilesResponseSchema.parse(await response.json());
  return result.items.map((file) => ({
    id: file.id,
    ordinal: file.ordinal,
    name: null,
    kind: file.kind,
    status: file.status,
    pageCount: file.pageCount,
    processingRevision: file.processingRevision,
    rejectionCode: file.rejectionCode,
    sizeBytes: file.sizeBytes
  }));
}

export async function listKioskFilePages(
  sessionId: string,
  fileId: string
): Promise<KioskFilePages> {
  const response = await fetch(
    `/agent/v1/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/pages`,
    {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store"
    }
  );

  if (!response.ok) throw await sessionRequestError(response, "FILE_PAGES_FAILED");
  return filePagesResponseSchema.parse(await response.json());
}

export function kioskPagePreviewUrl(
  sessionId: string,
  fileId: string,
  pageNumber: number,
  processingRevision: number
): string {
  const path =
    `/agent/v1/sessions/${encodeURIComponent(sessionId)}` +
    `/files/${encodeURIComponent(fileId)}/pages/${pageNumber}/preview`;
  const query = new URLSearchParams({ revision: String(processingRevision) });
  return `${path}?${query.toString()}`;
}

export async function deleteKioskSessionFile(sessionId: string, fileId: string): Promise<void> {
  const storageKey = `${DELETE_KEY_PREFIX}${sessionId}.${fileId}`;
  const idempotencyKey = sessionStorage.getItem(storageKey) ?? newIdempotencyKey();
  sessionStorage.setItem(storageKey, idempotencyKey);

  const response = await fetch(
    `/agent/v1/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`,
    {
      method: "DELETE",
      headers: {
        accept: "application/json",
        "idempotency-key": idempotencyKey
      },
      cache: "no-store"
    }
  );

  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw await sessionRequestError(response, "FILE_DELETE_FAILED");
  }
  sessionStorage.removeItem(storageKey);
}

export function clearStoredSessionKeys(sessionId?: string): void {
  sessionStorage.removeItem(CREATE_KEY_STORAGE);
  if (!sessionId) return;
  sessionStorage.removeItem(`${CANCEL_KEY_PREFIX}${sessionId}`);
  const deletePrefix = `${DELETE_KEY_PREFIX}${sessionId}.`;
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(deletePrefix)) sessionStorage.removeItem(key);
  }
  // A kiosk browser stays open for months. Every finished session must take
  // its replay keys with it rather than accumulating them indefinitely.
  clearStoredPricingKeys(sessionId);
  clearStoredPaymentKeys(sessionId);
}

function readPendingCreate(): PendingCreate | null {
  const stored = sessionStorage.getItem(CREATE_KEY_STORAGE);
  if (!stored) return null;

  try {
    const pending = JSON.parse(stored) as { key?: unknown; locale?: unknown };
    if (typeof pending.key !== "string" || !isLocale(pending.locale)) return null;
    return { key: pending.key, locale: pending.locale };
  } catch {
    // Replace malformed local state with a fresh key.
    return null;
  }
}

function storePendingCreate(key: string, locale: Locale): PendingCreate {
  const pending: PendingCreate = { key, locale };
  sessionStorage.setItem(CREATE_KEY_STORAGE, JSON.stringify(pending));
  return pending;
}

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ru" || value === "hy";
}

function newIdempotencyKey(): string {
  return `kiosk-${crypto.randomUUID()}`;
}

async function sessionRequestError(
  response: Response,
  fallbackCode: string
): Promise<SessionRequestError> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return new SessionRequestError(body.error?.code ?? fallbackCode, response.status);
  } catch {
    return new SessionRequestError(fallbackCode, response.status);
  }
}
