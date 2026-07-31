import {
  createSessionResponseSchema,
  filePagesResponseSchema,
  getSessionResponseSchema,
  listUploadedFilesResponseSchema,
  type FilePagesResponse
} from "@printing-kiosk/contracts";

import type { Locale } from "../i18n/messages.js";
import type { PrototypeFile, PrototypeSession } from "./model.js";
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
      throw new Error(failure.code ?? "SESSION_CREATE_FAILED");
    }

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
    // Already expired or cleaned up; nothing is in the way any more.
    clearStoredSessionKeys(sessionId);
    return;
  }

  const version = getSessionResponseSchema.parse(await snapshot.json()).session.version;
  await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    headers: {
      "idempotency-key": `kiosk-recover-${sessionId}-${version}`,
      "if-match": `"${version}"`
    }
  });
  clearStoredSessionKeys(sessionId);
}

async function readSessionConflict(
  response: Response
): Promise<{ code?: string; sessionId?: string }> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    const sessionId = body.error?.details?.sessionId;
    return {
      ...(body.error?.code ? { code: body.error.code } : {}),
      ...(typeof sessionId === "string" ? { sessionId } : {})
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

  const response = await fetch(`/agent/v1/sessions/${encodeURIComponent(session.id)}/cancel`, {
    method: "POST",
    headers: {
      "idempotency-key": idempotencyKey,
      "if-match": `"${session.version}"`
    },
    keepalive: true
  });

  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw await sessionRequestError(response, "SESSION_CANCEL_FAILED");
  }

  // Keep both the authoritative session and this stable key while closure is
  // uncertain. Only a confirmed terminal response permits the kiosk to forget
  // the customer's session and its replay key.
  clearStoredSessionKeys(session.id);
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

async function sessionRequestError(response: Response, fallbackCode: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return new Error(body.error?.code ?? fallbackCode);
  } catch {
    return new Error(fallbackCode);
  }
}
