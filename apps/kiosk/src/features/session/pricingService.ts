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
  const namespace = `${SETTINGS_KEY_PREFIX}${sessionId}`;
  const fingerprint = settingsFingerprint(body);
  let idempotencyKey = stableKey(namespace, fingerprint);
  let version = expectedVersion;
  let refreshedVersion = false;
  let rotatedKey = false;

  // Three attempts at most: the first, one after re-reading a stale version,
  // and one after replacing a key the control plane has already spent.
  for (let attempt = 0; attempt < 3; attempt += 1) {
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

    if (response.status === 412 && !refreshedVersion) {
      refreshedVersion = true;
      version = await readKioskSessionVersion(sessionId);
      continue;
    }

    const error = await pricingError(response, "SETTINGS_SAVE_FAILED");

    // The stored key was spent on a request that is no longer identical to
    // this one — the version moved on after a reply was lost in transit, so
    // the same body now hashes to a different request. Reusing that key can
    // only ever be refused again, and the key is derived from the body, so
    // retrying without replacing it would refuse forever and strand the
    // customer on a configuration they cannot price. A fresh key at worst
    // writes one more settings revision, which costs nothing and charges
    // nobody. Quotes deliberately get no such rotation: their request hash
    // covers only the session and the revision, so a key cannot fall out of
    // step with the request, and minting a new one there would be asking for
    // a second price rather than recovering the first.
    if (error.code === "IDEMPOTENCY_KEY_REUSED" && !rotatedKey) {
      rotatedKey = true;
      idempotencyKey = rotateStableKey(namespace, fingerprint);
      continue;
    }

    throw error;
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
 *
 * The fingerprint is stored beside the key rather than only hashed into the
 * storage slot. The hash is 32 bits, so two unrelated requests can land on one
 * slot; handing the second one the first one's key would spend it on a
 * different request and earn a refusal that no retry could clear.
 */
function stableKey(namespace: string, fingerprint: string): string {
  const storageKey = storageSlot(namespace, fingerprint);
  const stored = readStoredKey(storageKey);
  if (stored && stored.fingerprint === fingerprint) return stored.key;
  return writeStoredKey(storageKey, fingerprint);
}

/** Abandon a key the control plane has already spent and mint its successor. */
function rotateStableKey(namespace: string, fingerprint: string): string {
  return writeStoredKey(storageSlot(namespace, fingerprint), fingerprint);
}

function storageSlot(namespace: string, fingerprint: string): string {
  return `${namespace}.${hashFingerprint(fingerprint)}`;
}

function readStoredKey(storageKey: string): { fingerprint: string; key: string } | null {
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fingerprint?: unknown; key?: unknown };
    return typeof parsed?.fingerprint === "string" && typeof parsed.key === "string"
      ? { fingerprint: parsed.fingerprint, key: parsed.key }
      : null;
  } catch {
    // A value written before this format existed carries no fingerprint to
    // check, so it is replaced rather than trusted.
    return null;
  }
}

function writeStoredKey(storageKey: string, fingerprint: string): string {
  const key = `kiosk-${crypto.randomUUID()}`;
  sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
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
