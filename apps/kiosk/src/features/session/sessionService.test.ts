// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createKioskSession } from "./sessionService.js";

const createdSession = {
  session: {
    id: "01900000-0000-7000-8000-000000000010",
    publicId: "ps_1234567890abcdef",
    kioskId: "kiosk_dev_001",
    locale: "en",
    state: "WAITING_FOR_UPLOAD",
    version: 1,
    expiresAt: "2030-01-01T00:10:00.000Z",
    hardExpiresAt: "2030-01-01T00:30:00.000Z",
    createdAt: "2030-01-01T00:00:00.000Z",
    canceledAt: null
  },
  upload: {
    shortCode: "48291357",
    qrUrl: "https://upload.example.test/s/ps_1234567890abcdef#t=u_example"
  }
};

interface CreateAttempt {
  key: string;
  locale: unknown;
}

let attempts: CreateAttempt[];

function installApi(respond: (attempt: CreateAttempt, index: number) => Response): void {
  attempts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as { locale?: unknown };
      const attempt = { key, locale: body.locale };
      attempts.push(attempt);
      return Promise.resolve(respond(attempt, attempts.length - 1));
    })
  );
}

const created = () =>
  new Response(JSON.stringify(createdSession), {
    status: 201,
    headers: { "content-type": "application/json" }
  });

const conflict = () =>
  new Response(JSON.stringify({ error: { code: "ACTIVE_SESSION_EXISTS" } }), {
    status: 409,
    headers: { "content-type": "application/json" }
  });

const gone = () =>
  new Response(JSON.stringify({ error: { code: "SESSION_UPLOAD_GRANT_EXPIRED" } }), {
    status: 410,
    headers: { "content-type": "application/json" }
  });

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createKioskSession", () => {
  it("replays the stored request after a reload reset the interface language", async () => {
    // The authoritative API refuses a fresh key while a session is active, and
    // refuses the stored key with a different body. Only an exact replay works.
    installApi((attempt, index) => {
      if (index === 0) return created();
      if (attempt.key !== attempts[0]?.key) return conflict();
      if (attempt.locale !== attempts[0]?.locale) return conflict();
      return created();
    });

    await createKioskSession("en");
    const session = await createKioskSession("hy");

    expect(session.id).toBe(createdSession.session.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(attempts[1]?.locale).toBe("en");
  });

  it("starts a genuinely new session in the current language once the stored one is gone", async () => {
    installApi((attempt, index) => {
      if (index === 0) return created();
      // The stored session has ended, so its key is answered with 410.
      if (attempt.key === attempts[0]?.key) return gone();
      return created();
    });

    await createKioskSession("en");
    const session = await createKioskSession("hy");

    expect(session.id).toBe(createdSession.session.id);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.key).not.toBe(attempts[0]?.key);
    expect(attempts[2]?.locale).toBe("hy");
  });

  it("reuses one key for repeated attempts in the same language", async () => {
    installApi(() => created());

    await createKioskSession("hy");
    await createKioskSession("hy");

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
  });

  it("replaces malformed stored state with a fresh request", async () => {
    window.sessionStorage.setItem("printing-kiosk.pending-create", "{not json");
    installApi(() => created());

    await createKioskSession("ru");

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.key).toMatch(/^kiosk-/);
    expect(attempts[0]?.locale).toBe("ru");
  });
});
