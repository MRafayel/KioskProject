// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MobileRequestError,
  captureQrGrant,
  createMobileBootstrap,
  getPublicSessionIdFromPath,
  startMobileBootstrap
} from "./bootstrap.js";

const publicSessionId = "ps_1234567890abcdef";
const uploadToken = `u_${"A".repeat(43)}`;
const responseBody = {
  session: {
    id: "01900000-0000-7000-8000-000000000031",
    publicId: publicSessionId,
    locale: "hy",
    state: "WAITING_FOR_UPLOAD",
    version: 1,
    expiresAt: "2030-01-01T00:10:00.000Z",
    hardExpiresAt: "2030-01-01T00:30:00.000Z"
  },
  csrfToken: `c_${"B".repeat(43)}`,
  limits: {
    maxFiles: 1,
    maxFileBytes: 10_485_760,
    maxTotalBytes: 10_485_760,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"]
  }
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("mobile bootstrap security", () => {
  it("captures one token and erases the complete fragment immediately", () => {
    const replaceState = vi.fn();
    const result = captureQrGrant(
      {
        hash: `#t=${uploadToken}`,
        pathname: `/s/${publicSessionId}`,
        search: "?source=qr"
      },
      { replaceState }
    );

    expect(result).toEqual({ kind: "present", token: uploadToken });
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, "", `/s/${publicSessionId}?source=qr`);
  });

  it.each([`#t=${uploadToken}&t=${uploadToken}`, `#t=${uploadToken}&debug=true`, "#t=not-a-token"])(
    "rejects ambiguous or malformed fragments without retaining them",
    (hash) => {
      const replaceState = vi.fn();
      expect(
        captureQrGrant({ hash, pathname: `/s/${publicSessionId}`, search: "" }, { replaceState })
      ).toEqual({ kind: "invalid" });
      expect(replaceState).toHaveBeenCalledOnce();
    }
  );

  it("exchanges once, stores only a temporary nonce, and removes it after success", async () => {
    const storage = createStorage();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const nonce = "01900000-0000-7000-8000-000000000032";

    const promise = startMobileBootstrap(
      publicSessionId,
      { kind: "present", token: uploadToken },
      { fetch: request, storage, randomUUID: () => nonce }
    );
    await expect(promise).resolves.toEqual(responseBody);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "/v1/mobile-auth/exchange",
      expect.objectContaining({ method: "POST", credentials: "include", cache: "no-store" })
    );
    const init = request.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") throw new Error("EXPECTED_JSON_BODY");
    const parsedBody: unknown = JSON.parse(init.body);
    expect(parsedBody).toEqual({
      publicSessionId,
      uploadToken,
      clientNonce: nonce
    });
    expect(storage.values.size).toBe(0);
    expect(storage.writes).toEqual([
      ["printing-kiosk:mobile-client-nonce:ps_1234567890abcdef", nonce]
    ]);
    expect(storage.writes.flat()).not.toContain(uploadToken);
  });

  it("refreshes through the scoped cookie without an upload token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await startMobileBootstrap(
      publicSessionId,
      { kind: "missing" },
      {
        fetch: request,
        storage: createStorage(),
        randomUUID: () => crypto.randomUUID()
      }
    );

    expect(request).toHaveBeenCalledWith(
      `/v1/mobile-auth/${publicSessionId}/context`,
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" })
    );
  });

  it("retries a transient exchange with the same in-memory grant and nonce", async () => {
    const storage = createStorage();
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const randomUUID = vi.fn(() => "01900000-0000-7000-8000-000000000033");
    const bootstrap = createMobileBootstrap(
      publicSessionId,
      { kind: "present", token: uploadToken },
      { fetch: request, storage, randomUUID }
    );

    await expect(bootstrap.run()).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await expect(bootstrap.run()).resolves.toEqual(responseBody);

    expect(request).toHaveBeenCalledTimes(2);
    const requestBodies = request.mock.calls.map((call) => {
      const body = call[1]?.body;
      if (typeof body !== "string") throw new Error("EXPECTED_JSON_BODY");
      return JSON.parse(body) as { uploadToken: string; clientNonce: string };
    });
    expect(requestBodies).toEqual([
      {
        publicSessionId,
        uploadToken,
        clientNonce: "01900000-0000-7000-8000-000000000033"
      },
      {
        publicSessionId,
        uploadToken,
        clientNonce: "01900000-0000-7000-8000-000000000033"
      }
    ]);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(storage.values.size).toBe(0);
  });

  it("aborts a bootstrap request at the configured deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const pending = startMobileBootstrap(
      publicSessionId,
      { kind: "present", token: uploadToken },
      {
        fetch: request,
        storage: createStorage(),
        randomUUID: () => "01900000-0000-7000-8000-000000000034",
        requestTimeoutMs: 20
      }
    );

    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).rejects.toEqual(new MobileRequestError("REQUEST_TIMEOUT"));
  });

  it("accepts only the intended session route shape", () => {
    expect(getPublicSessionIdFromPath(`/s/${publicSessionId}`)).toBe(publicSessionId);
    expect(getPublicSessionIdFromPath(`/s/${publicSessionId}/files`)).toBeNull();
    expect(getPublicSessionIdFromPath("/s/not-valid")).toBeNull();
  });
});

function createStorage() {
  const values = new Map<string, string>();
  const writes: [string, string][] = [];
  return {
    values,
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push([key, value]);
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key)
  };
}
