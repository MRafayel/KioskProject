import { describe, expect, it } from "vitest";

import {
  deriveCsrfToken,
  deriveMobileCookie,
  digestClientNonce,
  digestMobileCookie,
  safelyEqualSecrets
} from "./crypto.js";

const signingKey = "test-cookie-signing-key-that-is-long-enough";
const pepper = "test-mobile-token-pepper-that-is-long-enough";

describe("mobile access secrets", () => {
  it("derives stable domain-separated cookie and CSRF values", () => {
    const cookie = deriveMobileCookie(
      "01900000-0000-7000-8000-000000000001",
      `u_${"a".repeat(43)}`,
      "01900000-0000-7000-8000-000000000002",
      signingKey
    );

    expect(cookie).toMatch(/^m_[A-Za-z0-9_-]{43}$/);
    expect(digestMobileCookie(cookie, pepper)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestClientNonce("01900000-0000-7000-8000-000000000002", pepper)).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(deriveCsrfToken(cookie, "01900000-0000-7000-8000-000000000003", signingKey)).toMatch(
      /^c_[A-Za-z0-9_-]{43}$/
    );
    expect(
      deriveMobileCookie(
        "01900000-0000-7000-8000-000000000001",
        `u_${"a".repeat(43)}`,
        "01900000-0000-7000-8000-000000000002",
        signingKey
      )
    ).toBe(cookie);
  });

  it("compares secrets without accepting different lengths", () => {
    expect(safelyEqualSecrets("same", "same")).toBe(true);
    expect(safelyEqualSecrets("same", "different")).toBe(false);
    expect(safelyEqualSecrets("same", "sam")).toBe(false);
  });
});
