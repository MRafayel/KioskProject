import { describe, expect, it } from "vitest";

import { deriveUploadSecrets, digestIdempotencyKey, safelyEqualHexDigests } from "./crypto.js";

const PEPPER = "test-only-pepper-with-at-least-32-characters";
const SESSION_ID = "01900000-0000-7000-8000-000000000001";
const IDEMPOTENCY_KEY = "kiosk-01900000-0000-7000-8000-000000000002";

describe("session secret derivation", () => {
  it("is deterministic, formatted, and domain separated", () => {
    const first = deriveUploadSecrets(SESSION_ID, IDEMPOTENCY_KEY, PEPPER);
    const replay = deriveUploadSecrets(SESSION_ID, IDEMPOTENCY_KEY, PEPPER);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      uploadToken: "u_bSkWjV93_08NRci-JMahsAsRC1Xc2gGIkXxrFbbFBl4",
      shortCode: "86921169"
    });
    expect(first.uploadToken).toMatch(/^u_[A-Za-z0-9_-]{43}$/);
    expect(first.shortCode).toMatch(/^\d{8}$/);
    expect(first.uploadToken).not.toContain(first.shortCode);
  });

  it("changes when the session, caller key, or pepper changes", () => {
    const baseline = deriveUploadSecrets(SESSION_ID, IDEMPOTENCY_KEY, PEPPER);

    expect(
      deriveUploadSecrets("01900000-0000-7000-8000-000000000003", IDEMPOTENCY_KEY, PEPPER)
    ).not.toEqual(baseline);
    expect(deriveUploadSecrets(SESSION_ID, `${IDEMPOTENCY_KEY}-different`, PEPPER)).not.toEqual(
      baseline
    );
    expect(deriveUploadSecrets(SESSION_ID, IDEMPOTENCY_KEY, `${PEPPER}-different`)).not.toEqual(
      baseline
    );
  });

  it("preserves leading zeroes in the eight-digit fallback code", () => {
    expect(deriveUploadSecrets(SESSION_ID, "leading-zero-26", PEPPER).shortCode).toBe("05446984");
  });

  it("binds stored idempotency-key digests to actor and action", () => {
    const digest = digestIdempotencyKey(
      "kiosk_dev_001",
      "sessions.create",
      IDEMPOTENCY_KEY,
      PEPPER
    );

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      digestIdempotencyKey("another-kiosk", "sessions.create", IDEMPOTENCY_KEY, PEPPER)
    ).not.toBe(digest);
    expect(
      digestIdempotencyKey("kiosk_dev_001", "sessions.cancel", IDEMPOTENCY_KEY, PEPPER)
    ).not.toBe(digest);
  });

  it("compares only valid SHA-256 hex digests", () => {
    const digest = "a".repeat(64);
    expect(safelyEqualHexDigests(digest, digest)).toBe(true);
    expect(safelyEqualHexDigests(digest, "b".repeat(64))).toBe(false);
    expect(safelyEqualHexDigests(digest, "not-a-digest")).toBe(false);
  });
});
