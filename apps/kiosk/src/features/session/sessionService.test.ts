// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeKioskSession, createKioskSession } from "./sessionService.js";
import type { SessionRequestError } from "./sessionService.js";

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

  it("does not forget the blocking session when its cancellation is rejected", async () => {
    const blockingSessionId = "01900000-0000-7000-8000-000000000020";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push(`${init?.method ?? "GET"} ${url}`);

        if (url.endsWith("/agent/v1/sessions")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "ACTIVE_SESSION_EXISTS",
                  details: { sessionId: blockingSessionId, currentState: "FILES_UPLOADED" }
                }
              }),
              { status: 409, headers: { "content-type": "application/json" } }
            )
          );
        }

        if (url.endsWith("/cancel")) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: "PAYMENT_ALREADY_CAPTURED" } }), {
              status: 409,
              headers: { "content-type": "application/json" }
            })
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              session: {
                ...createdSession.session,
                id: blockingSessionId,
                state: "FILES_UPLOADED",
                version: 2
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      })
    );

    await expect(createKioskSession("hy")).rejects.toEqual(
      expect.objectContaining<Partial<SessionRequestError>>({
        code: "PAYMENT_ALREADY_CAPTURED",
        status: 409
      })
    );
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("/cancel");
    expect(window.sessionStorage.getItem("printing-kiosk.pending-create")).not.toBeNull();
  });
});

describe("closeKioskSession", () => {
  it("refreshes a stale version and retries once if the session changes again", async () => {
    const versions = [5, 6];
    const ifMatches: string[] = [];
    const cancelKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (init?.method === "GET") {
          const version = versions.shift();
          return Promise.resolve(
            new Response(
              JSON.stringify({
                session: {
                  ...createdSession.session,
                  state: "CONFIGURING",
                  version
                }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          );
        }

        expect(url).toContain("/cancel");
        const headers = new Headers(init?.headers);
        ifMatches.push(headers.get("if-match") ?? "");
        cancelKeys.push(headers.get("idempotency-key") ?? "");
        return Promise.resolve(
          new Response(
            ifMatches.length === 1
              ? JSON.stringify({ error: { code: "STALE_SESSION_VERSION" } })
              : "{}",
            {
              status: ifMatches.length === 1 ? 412 : 200,
              headers: { "content-type": "application/json" }
            }
          )
        );
      })
    );

    window.sessionStorage.setItem("printing-kiosk.pending-create", "original-create-key");
    await closeKioskSession({
      id: createdSession.session.id,
      publicId: createdSession.session.publicId,
      version: 1,
      uploadUrl: createdSession.upload.qrUrl,
      expiresAt: createdSession.session.expiresAt,
      hardExpiresAt: createdSession.session.hardExpiresAt
    });

    expect(ifMatches).toEqual(['"5"', '"6"']);
    expect(cancelKeys[0]).toBeTruthy();
    expect(cancelKeys[1]).toBe(cancelKeys[0]);
    expect(window.sessionStorage.getItem("printing-kiosk.pending-create")).toBeNull();
    expect(
      window.sessionStorage.getItem(`printing-kiosk.pending-cancel.${createdSession.session.id}`)
    ).toBeNull();
  });
});

/**
 * What somebody standing at the machine is told when the printer cannot finish
 * a job. The reason is only ever repeated, never inferred: the kiosk names a
 * cause when the control plane vouches for one and stays general otherwise, so
 * a jam never sends staff to look at the paper tray.
 */
describe("a printer that cannot print stops the session at the welcome screen", () => {
  it("carries the reason through so the screen can be specific", async () => {
    installApi(() => printerUnavailable("PRINTER_OUT_OF_PAPER"));

    const error = (await createKioskSession("en").then(
      () => null,
      (thrown: unknown) => thrown
    )) as SessionRequestError;

    expect(error.code).toBe("PRINTER_UNAVAILABLE");
    expect(error.reason).toBe("PRINTER_OUT_OF_PAPER");
  });

  it("leaves the reason empty when the control plane did not give one", async () => {
    installApi(() => printerUnavailable(null));

    const error = (await createKioskSession("en").then(
      () => null,
      (thrown: unknown) => thrown
    )) as SessionRequestError;

    expect(error.code).toBe("PRINTER_UNAVAILABLE");
    expect(error.reason).toBeNull();
  });

  it("does not retry a refusal into a second session", async () => {
    let calls = 0;
    installApi(() => {
      calls += 1;
      return printerUnavailable("PRINTER_OFFLINE");
    });

    await createKioskSession("en").catch(() => undefined);

    // A blocked printer is not a conflict to recover from. Retrying would create
    // a session the customer cannot use and leave it to expire.
    expect(calls).toBe(1);
  });
});

function printerUnavailable(reason: string | null): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "PRINTER_UNAVAILABLE",
        ...(reason ? { details: { reason } } : {})
      }
    }),
    { status: 409, headers: { "content-type": "application/json" } }
  );
}
