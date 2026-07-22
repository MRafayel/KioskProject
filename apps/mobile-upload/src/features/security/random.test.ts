// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { secureRandomUuid } from "./random.js";

describe("secure mobile identifiers", () => {
  it("uses the platform randomUUID implementation when available", () => {
    const generated = "01900000-0000-4000-8000-000000000001" as const;
    const randomUUID = vi.fn<Crypto["randomUUID"]>(() => generated);
    const getRandomValues = vi.fn((value: Uint8Array) => value);

    expect(
      secureRandomUuid({
        randomUUID,
        getRandomValues: getRandomValues as Crypto["getRandomValues"]
      })
    ).toBe("01900000-0000-4000-8000-000000000001");
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("builds an RFC 4122 version-4 UUID from getRandomValues as a secure fallback", () => {
    const source = {
      getRandomValues: ((value: Uint8Array) => {
        value.set(Array.from({ length: 16 }, (_, index) => index));
        return value;
      }) as Crypto["getRandomValues"]
    };

    expect(secureRandomUuid(source)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("fails closed when no cryptographic source exists", () => {
    expect(() => secureRandomUuid(null)).toThrow("SECURE_RANDOM_UNAVAILABLE");
  });
});
