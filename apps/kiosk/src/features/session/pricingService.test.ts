// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSettingsBody, saveKioskSettings } from "./pricingService.js";
import { defaultPrintSettings, type ReadyPrototypeFile } from "./model.js";

const sessionId = "01900000-0000-7000-8000-000000000010";
const fileId = "01900000-0000-7000-8000-000000000011";

const file: ReadyPrototypeFile = {
  id: fileId,
  ordinal: 0,
  name: "safe-fixture.pdf",
  kind: "PDF",
  status: "READY",
  pageCount: 4,
  processingRevision: 1,
  rejectionCode: null,
  sizeBytes: 1_000_000
};

function savedSettings(sessionVersion: number) {
  return {
    settings: {
      revision: 1,
      copies: 1,
      duplex: "SIMPLEX",
      paperSize: "A4",
      orientation: "PORTRAIT",
      scaling: "FIT",
      collate: true,
      colorMode: "MONOCHROME",
      files: [
        {
          fileId,
          position: 0,
          pageCount: 4,
          pageRanges: [[1, 4]],
          pageRangeText: "1-4",
          selectedPages: 4
        }
      ],
      selectedPages: 4,
      printedSides: 4,
      physicalSheets: 4,
      createdAt: "2030-01-01T00:00:00.000Z"
    },
    sessionState: "CONFIGURING",
    sessionVersion,
    quoteInvalidated: false
  };
}

function sessionAtVersion(version: number) {
  return {
    id: sessionId,
    publicId: "ps_1234567890abcdef",
    kioskId: "kiosk_dev_001",
    locale: "en",
    state: "CONFIGURING",
    version,
    expiresAt: "2030-01-01T00:10:00.000Z",
    hardExpiresAt: "2030-01-01T00:30:00.000Z",
    createdAt: "2030-01-01T00:00:00.000Z",
    canceledAt: null
  };
}

interface Attempt {
  method: string;
  key: string;
  ifMatch: string;
}

let attempts: Attempt[];

function installApi(respond: (attempt: Attempt, index: number) => Response): void {
  attempts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const attempt: Attempt = {
        method: init?.method ?? "GET",
        key: headers.get("idempotency-key") ?? "",
        ifMatch: headers.get("if-match") ?? ""
      };
      attempts.push(attempt);
      return Promise.resolve(respond(attempt, attempts.length - 1));
    })
  );
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const saveAttempts = () => attempts.filter((attempt) => attempt.method === "PUT");

function storedSlots(): string[] {
  const slots: string[] = [];
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith("printing-kiosk.pending-settings.")) slots.push(key);
  }
  return slots;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveKioskSettings", () => {
  const body = () => buildSettingsBody(file, defaultPrintSettings);

  it("reuses one key so an interrupted save replays instead of writing twice", async () => {
    installApi(() => json(savedSettings(6), 200));

    await saveKioskSettings(sessionId, 5, body());
    await saveKioskSettings(sessionId, 5, body());

    const [first, second] = saveAttempts();
    expect(first?.key).toMatch(/^kiosk-/);
    expect(second?.key).toBe(first?.key);
  });

  it("re-reads the session version once when the save is refused as stale", async () => {
    installApi((attempt) => {
      if (attempt.method === "GET") return json({ session: sessionAtVersion(9) }, 200);
      return attempt.ifMatch === '"9"'
        ? json(savedSettings(10), 200)
        : json({ error: { code: "STALE_SESSION_VERSION" } }, 412);
    });

    // The session version moves on by itself whenever a document finishes
    // validating, so a stale precondition is ordinary rather than exceptional.
    const response = await saveKioskSettings(sessionId, 5, body());
    expect(response.sessionVersion).toBe(10);
    expect(saveAttempts().map((attempt) => attempt.ifMatch)).toEqual(['"5"', '"9"']);
  });

  it("replaces a spent key instead of refusing the same settings forever", async () => {
    // A save that succeeded but whose reply was lost leaves the key spent
    // against a version the kiosk has since moved past. The key is derived
    // from the body, so without rotation every retry of this configuration
    // rebuilds the same refused key and the customer can never be priced.
    installApi((attempt, index) =>
      index === 0
        ? json({ error: { code: "IDEMPOTENCY_KEY_REUSED" } }, 409)
        : json(savedSettings(11), 200)
    );

    const response = await saveKioskSettings(sessionId, 7, body());

    expect(response.sessionVersion).toBe(11);
    const [first, second] = saveAttempts();
    expect(second?.key).not.toBe(first?.key);
    expect(second?.key).toMatch(/^kiosk-/);
  });

  it("gives up rather than rotating keys in a loop", async () => {
    installApi(() => json({ error: { code: "IDEMPOTENCY_KEY_REUSED" } }, 409));

    await expect(saveKioskSettings(sessionId, 7, body())).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED"
    });
    expect(saveAttempts()).toHaveLength(2);
  });

  it("never hands a stored key to a request it does not belong to", async () => {
    installApi(() => json(savedSettings(6), 200));
    await saveKioskSettings(sessionId, 5, body());

    const [slot] = storedSlots();
    expect(slot).toBeDefined();
    const original = window.sessionStorage.getItem(slot ?? "");

    // The storage slot is addressed by a 32-bit hash, so an unrelated request
    // can land on it. A stored key is only reused when the fingerprint beside
    // it is the one being sent.
    window.sessionStorage.setItem(
      slot ?? "",
      JSON.stringify({ fingerprint: "a different request", key: "kiosk-not-mine" })
    );
    await saveKioskSettings(sessionId, 5, body());
    expect(saveAttempts()[1]?.key).not.toBe("kiosk-not-mine");

    // A value written before keys carried their fingerprint has nothing to
    // check, so it is replaced rather than trusted.
    window.sessionStorage.setItem(slot ?? "", "kiosk-legacy-plain-string");
    await saveKioskSettings(sessionId, 5, body());
    expect(saveAttempts()[2]?.key).not.toBe("kiosk-legacy-plain-string");
    expect(original).toContain("fingerprint");
  });
});
