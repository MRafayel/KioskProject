import {
  createQuoteResponseSchema,
  getSessionResponseSchema,
  printCapabilitiesResponseSchema,
  updatePrintSettingsResponseSchema,
  type PriceQuote,
  type PrintCapabilitiesResponse,
  type UpdatePrintSettingsBody,
  type UpdatePrintSettingsResponse
} from "@printing-kiosk/contracts";

import type { PrintSettings, ReadyPrototypeFile } from "./model.js";

const SETTINGS_KEY_PREFIX = "printing-kiosk.pending-settings.";
const QUOTE_KEY_PREFIX = "printing-kiosk.pending-quote.";

export class PricingRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
    this.name = "PricingRequestError";
  }
}

/**
 * Turn the touchscreen's controls into the contract the control plane accepts.
 * The kiosk expresses intent; the server decides what that intent costs.
 */
export function buildSettingsBody(
  file: ReadyPrototypeFile,
  settings: PrintSettings
): UpdatePrintSettingsBody {
  const pageEnd = Math.min(settings.pageEnd ?? file.pageCount, file.pageCount);
  const pageStart = Math.min(Math.max(settings.pageStart, 1), pageEnd);

  return {
    fileOrder: [file.id],
    fileSelections: [
      {
        fileId: file.id,
        pageRanges: pageStart === pageEnd ? `${pageStart}` : `${pageStart}-${pageEnd}`
      }
    ],
    copies: settings.copies,
    duplex: settings.duplex ? "LONG_EDGE" : "SIMPLEX",
    paperSize: "A4",
    orientation: settings.orientation,
    pagesPerSheet: settings.pagesPerSheet,
    scaling: "FIT",
    collate: true
  };
}

export async function readKioskSessionVersion(sessionId: string): Promise<number> {
  const response = await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw await pricingError(response, "SESSION_READ_FAILED");
  return getSessionResponseSchema.parse(await response.json()).session.version;
}

export async function readKioskPrintCapabilities(
  sessionId: string
): Promise<PrintCapabilitiesResponse> {
  const response = await fetch(
    `/agent/v1/sessions/${encodeURIComponent(sessionId)}/print-capabilities`,
    { method: "GET", headers: { accept: "application/json" }, cache: "no-store" }
  );
  if (!response.ok) throw await pricingError(response, "CAPABILITIES_READ_FAILED");
  return printCapabilitiesResponseSchema.parse(await response.json());
}

/**
 * Save settings against the session version the kiosk last observed. A stale
 * version is expected — a document can finish validating at any moment — so a
 * single retry re-reads the authoritative version before giving up.
 */
export async function saveKioskSettings(
  sessionId: string,
  expectedVersion: number,
  body: UpdatePrintSettingsBody
): Promise<UpdatePrintSettingsResponse> {
  const idempotencyKey = stableKey(`${SETTINGS_KEY_PREFIX}${sessionId}`, settingsFingerprint(body));

  let version = expectedVersion;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}/settings`, {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "if-match": `"${version}"`
      },
      cache: "no-store",
      body: JSON.stringify(body)
    });

    if (response.ok) return updatePrintSettingsResponseSchema.parse(await response.json());
    if (response.status !== 412 || attempt === 1) {
      throw await pricingError(response, "SETTINGS_SAVE_FAILED");
    }
    version = await readKioskSessionVersion(sessionId);
  }

  throw new PricingRequestError("SETTINGS_SAVE_FAILED", 409);
}

export async function createKioskQuote(
  sessionId: string,
  settingsRevision: number,
  attempt: number
): Promise<PriceQuote> {
  // A new attempt number is what asks for a genuinely new price after the
  // previous one timed out; repeating the same attempt safely replays it.
  const idempotencyKey = stableKey(
    `${QUOTE_KEY_PREFIX}${sessionId}`,
    `${settingsRevision}:${attempt}`
  );
  const response = await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}/quotes`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    cache: "no-store",
    body: JSON.stringify({ settingsRevision })
  });

  if (!response.ok) throw await pricingError(response, "QUOTE_FAILED");
  return createQuoteResponseSchema.parse(await response.json()).quote;
}

export function clearStoredPricingKeys(sessionId: string): void {
  const prefixes = [`${SETTINGS_KEY_PREFIX}${sessionId}`, `${QUOTE_KEY_PREFIX}${sessionId}`];
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) sessionStorage.removeItem(key);
  }
}

/**
 * One idempotency key per distinct request. Retrying the same request after a
 * network interruption reuses its key, so the control plane replays the stored
 * result instead of creating a second revision or a second price.
 */
function stableKey(namespace: string, fingerprint: string): string {
  const storageKey = `${namespace}.${hashFingerprint(fingerprint)}`;
  const existing = sessionStorage.getItem(storageKey);
  if (existing) return existing;

  const key = `kiosk-${crypto.randomUUID()}`;
  sessionStorage.setItem(storageKey, key);
  return key;
}

function settingsFingerprint(body: UpdatePrintSettingsBody): string {
  return [
    body.fileOrder.join(">"),
    body.fileSelections
      .map((selection) => `${selection.fileId}=${selection.pageRanges ?? ""}`)
      .join("|"),
    body.copies,
    body.duplex,
    body.paperSize,
    body.orientation,
    body.pagesPerSheet,
    body.scaling,
    body.collate ? "collate" : "no-collate"
  ].join("\n");
}

function hashFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function pricingError(
  response: Response,
  fallbackCode: string
): Promise<PricingRequestError> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return new PricingRequestError(body.error?.code ?? fallbackCode, response.status);
  } catch {
    return new PricingRequestError(fallbackCode, response.status);
  }
}
