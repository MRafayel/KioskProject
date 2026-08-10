import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_STYLE_SOURCE,
  PRODUCTION_STYLE_SOURCE,
  resolveAdminDevelopmentOrigin,
  securityHeaders
} from "../vite.config.js";

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

  it("keeps every non-CSP header identical in both modes", () => {
    const shipped = securityHeaders(PRODUCTION_STYLE_SOURCE);
    const development = securityHeaders(DEVELOPMENT_STYLE_SOURCE);

    for (const header of Object.keys(shipped) as (keyof typeof shipped)[]) {
      if (header === "Content-Security-Policy") continue;
      expect(development[header]).toBe(shipped[header]);
    }
  });
});
