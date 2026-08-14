import { formatPageRanges } from "@printing-kiosk/domain";

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

import { clearStoredKeys, rotateStableKey, stableKey } from "./idempotencyKeys.js";
import {
  fileSelection,
  selectedPageRanges,
  type PrintSettings,
  type ReadyPrototypeFile
} from "./model.js";

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
  files: readonly ReadyPrototypeFile[],
  settings: PrintSettings
): UpdatePrintSettingsBody {
  // The control plane refuses a document set it was not told about in full —
  // `fileOrder` must name every validated document — so the caller passes the
  // whole set and the print order is the order they were uploaded in.
  if (files.length === 0) throw new PricingRequestError("NO_READY_DOCUMENTS", 409);

  const ordered = [...files].sort((left, right) => left.ordinal - right.ordinal);
  const fileSelections = ordered.map((file) => {
    const selection = fileSelection(settings, file.id);
    const ranges = selectedPageRanges(selection, file.pageCount);
    // Empty page-range text means "the whole document" to the control plane, so
    // a selection the customer emptied must fail here rather than quietly become
    // a price — and a print job — for every page they took out.
    if (ranges.length === 0) throw new PricingRequestError("NO_SELECTED_PAGES", 422);
    return {
      fileId: file.id,
      pageRanges: formatPageRanges(ranges),
      copies: selection.copies,
      duplex: selection.duplex ? ("LONG_EDGE" as const) : ("SIMPLEX" as const),
      orientation: selection.orientation
    };
  });

  return {
    fileOrder: ordered.map((file) => file.id),
    fileSelections,
    paperSize: "A4",
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
  clearStoredKeys([`${SETTINGS_KEY_PREFIX}${sessionId}`, `${QUOTE_KEY_PREFIX}${sessionId}`]);
}

function settingsFingerprint(body: UpdatePrintSettingsBody): string {
  return [
    body.fileOrder.join(">"),
    // Every per-document choice is in the key, so changing one document's
    // copies asks for a new revision rather than replaying the previous one.
    body.fileSelections
      .map(
        (selection) =>
          `${selection.fileId}=${selection.pageRanges ?? ""}:${selection.copies}:` +
          `${selection.duplex}:${selection.orientation}`
      )
      .join("|"),
    body.paperSize,
    body.scaling,
    body.collate ? "collate" : "no-collate"
  ].join("\n");
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
