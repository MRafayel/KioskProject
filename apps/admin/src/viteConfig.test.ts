import { describe, expect, it } from "vitest";

import { resolveAdminDevelopmentOrigin } from "../vite.config.js";

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
