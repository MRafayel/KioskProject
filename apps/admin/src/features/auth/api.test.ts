// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError, adminApi } from "./api.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin API client", () => {
  it("fails closed on a malformed CSRF cookie and applies bounded same-origin fetch policy", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-admin_csrf=%");
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);

    await adminApi.logout();

    expect(request).toHaveBeenCalledOnce();
    const [path, init] = request.mock.calls[0] ?? [];
    expect(path).toBe("/v1/admin/auth/logout");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("");
  });

  it("does not render malformed or unbounded upstream error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: { code: "UPSTREAM_ERROR", message: "sensitive".repeat(100) } },
            { status: 502 }
          )
        )
    );

    await expect(adminApi.me()).rejects.toEqual(
      new AdminApiError(502, "UPSTREAM_ERROR", "The request could not be completed.")
    );
  });

  it("rejects a successful response that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("proxy error page", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      )
    );

    await expect(adminApi.me()).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE"
    });
  });

  it("encodes the authenticator identifier before placing it in the request path", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("");
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);

    await adminApi.revokeAuthenticator("../another/account", "Lost key");

    expect(request).toHaveBeenCalledWith(
      "/v1/admin/authenticators/..%2Fanother%2Faccount/revoke",
      expect.objectContaining({ method: "POST" })
    );
  });
});
