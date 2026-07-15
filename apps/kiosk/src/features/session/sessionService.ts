import { createSessionResponseSchema } from "@printing-kiosk/contracts";

import type { Locale } from "../i18n/messages.js";
import type { PrototypeSession } from "./model.js";

const CREATE_KEY_STORAGE = "printing-kiosk.pending-create";
const CANCEL_KEY_PREFIX = "printing-kiosk.pending-cancel.";

export async function createKioskSession(locale: Locale): Promise<PrototypeSession> {
  const idempotencyKey = getCreateIdempotencyKey(locale);
  const response = await fetch("/agent/v1/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify({ locale })
  });

  if (!response.ok) throw await sessionRequestError(response, "SESSION_CREATE_FAILED");

  const result = createSessionResponseSchema.parse(await response.json());
  return {
    id: result.session.id,
    publicId: result.session.publicId,
    version: result.session.version,
    shortCode: formatShortCode(result.upload.shortCode),
    uploadUrl: result.upload.qrUrl,
    expiresAt: result.session.expiresAt,
    hardExpiresAt: result.session.hardExpiresAt
  };
}

export async function closeKioskSession(session: PrototypeSession): Promise<void> {
  const storageKey = `${CANCEL_KEY_PREFIX}${session.id}`;
  const idempotencyKey = sessionStorage.getItem(storageKey) ?? newIdempotencyKey();
  sessionStorage.setItem(storageKey, idempotencyKey);

  try {
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
  } finally {
    clearStoredSessionKeys(session.id);
  }
}

export function clearStoredSessionKeys(sessionId?: string): void {
  sessionStorage.removeItem(CREATE_KEY_STORAGE);
  if (sessionId) sessionStorage.removeItem(`${CANCEL_KEY_PREFIX}${sessionId}`);
}

function getCreateIdempotencyKey(locale: Locale): string {
  const stored = sessionStorage.getItem(CREATE_KEY_STORAGE);
  if (stored) {
    try {
      const pending = JSON.parse(stored) as { key?: unknown; locale?: unknown };
      if (pending.locale === locale && typeof pending.key === "string") return pending.key;
    } catch {
      // Replace malformed local state with a fresh key.
    }
  }

  const key = newIdempotencyKey();
  sessionStorage.setItem(CREATE_KEY_STORAGE, JSON.stringify({ key, locale }));
  return key;
}

function newIdempotencyKey(): string {
  return `kiosk-${crypto.randomUUID()}`;
}

function formatShortCode(value: string): string {
  return `${value.slice(0, 4)} ${value.slice(4)}`;
}

async function sessionRequestError(response: Response, fallbackCode: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return new Error(body.error?.code ?? fallbackCode);
  } catch {
    return new Error(fallbackCode);
  }
}
