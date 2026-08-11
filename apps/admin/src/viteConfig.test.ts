import { describe, expect, it } from "vitest";

import {
  alwaysSendSecurityHeaders,
  DEVELOPMENT_STYLE_SOURCE,
  PRODUCTION_STYLE_SOURCE,
  resolveAdminDevelopmentOrigin,
  securityHeaders
} from "../vite.config.js";

/**
 * Capture what the plugin registers, without standing up a server.
 *
 * The behaviour under test is that the headers are applied by a middleware at
 * all — `server.headers` would satisfy every assertion about their *content*
 * while still omitting them from a 304, which is the failure this guards.
 */
type FakeResponse = { setHeader: (name: string, value: string) => void };
type FakeMiddleware = (request: unknown, response: FakeResponse, next: () => void) => void;

function applyPluginHeaders(headers: Readonly<Record<string, string>>) {
  const plugin = alwaysSendSecurityHeaders(headers);
  const registered: FakeMiddleware[] = [];
  const server = { middlewares: { use: (handler: FakeMiddleware) => registered.push(handler) } };

  // The hook is typed against Vite's own server objects. Its middleware stack
  // is the only part this test touches, so it is handed a stand-in for that.
  const configure = plugin.configureServer as unknown as (target: typeof server) => void;
  configure(server);

  const sent: Record<string, string> = {};
  let nextCalled = false;
  for (const middleware of registered) {
    middleware(
      {},
      {
        setHeader: (name, value) => {
          sent[name] = value;
        }
      },
      () => {
        nextCalled = true;
      }
    );
  }
  return { sent, nextCalled, middlewareCount: registered.length };
}

describe("admin Vite origin alignment", () => {
  it("does not inherit phone-only HTTPS certificates for an HTTP admin origin", () => {
    const result = resolveAdminDevelopmentOrigin(
      "http://localhost:5175",
      ".certs/phone-key.pem",
      ".certs/phone.pem",
      true
    );

    expect(result.origin.origin).toBe("http://localhost:5175");
    expect(result.https).toBe(false);
  });

  it("fails fast when the WebAuthn origin expects HTTPS without a certificate pair", () => {
    expect(() =>
      resolveAdminDevelopmentOrigin("https://localhost:5175", undefined, undefined, true)
    ).toThrow("HTTPS ADMIN_ORIGIN requires DEV_HTTPS_CERT_PATH and DEV_HTTPS_KEY_PATH");
  });

  it("keeps preview compatible with externally terminated TLS", () => {
    const result = resolveAdminDevelopmentOrigin(
      "https://admin.example.test",
      undefined,
      undefined,
      false
    );

    expect(result.origin.origin).toBe("https://admin.example.test");
    expect(result.https).toBe(false);
  });

  it("refuses a non-loopback development bind", () => {
    expect(() =>
      resolveAdminDevelopmentOrigin("http://192.0.2.10:5175", undefined, undefined, true)
    ).toThrow("Development ADMIN_ORIGIN must use a loopback hostname");
    expect(() =>
      resolveAdminDevelopmentOrigin("http://127.attacker.test:5175", undefined, undefined, true)
    ).toThrow("Development ADMIN_ORIGIN must use a loopback hostname");
  });
});

describe("admin content security policy", () => {
  it("ships without any inline allowance", () => {
    const policy = securityHeaders(PRODUCTION_STYLE_SOURCE)["Content-Security-Policy"];

    expect(policy).toContain("style-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("relaxes styles and nothing else for the development server", () => {
    const policy = securityHeaders(DEVELOPMENT_STYLE_SOURCE)["Content-Security-Policy"];

    // Vite injects development CSS through a script, so this one directive has
    // to admit an inline style block or no screen renders at all.
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");

    // Everything that could execute or exfiltrate stays exactly as it ships.
    // A relaxed style source is a cosmetic concession; a relaxed script source
    // would put an operator's session inside the blast radius of a dev tool.
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("sets the headers from a middleware, so a 304 carries the current policy", () => {
    const headers = securityHeaders(PRODUCTION_STYLE_SOURCE);
    const { sent, nextCalled, middlewareCount } = applyPluginHeaders(headers);

    expect(middlewareCount).toBe(1);
    // `res.setHeader` before the status is chosen is what makes a bodyless
    // response carry these. A cache treats a header missing from a 304 as
    // unchanged and keeps the one it stored, so a policy that skips this path
    // can never be tightened for anyone who already has the page.
    expect(sent).toEqual({ ...headers });
    expect(nextCalled).toBe(true);
  });

  it("keeps every non-CSP header identical in both modes", () => {
    const shipped = securityHeaders(PRODUCTION_STYLE_SOURCE);
    const development = securityHeaders(DEVELOPMENT_STYLE_SOURCE);

    for (const header of Object.keys(shipped) as (keyof typeof shipped)[]) {
      if (header === "Content-Security-Policy") continue;
      expect(development[header]).toBe(shipped[header]);
    }
  });
});
