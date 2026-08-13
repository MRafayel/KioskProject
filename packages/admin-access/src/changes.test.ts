import { describe, expect, it } from "vitest";

import {
  PRICING_PREVIEW_BASKETS,
  canonicalPricingPublishText,
  previewChangeBodySchema,
  publishChangeBodySchema
} from "./changes.js";

const tariff = {
  scope: "GLOBAL",
  scopeRef: "",
  currency: "AMD",
  currencyExponent: 2,
  rounding: "HALF_UP",
  taxMode: "EXCLUSIVE",
  minimumApplication: "BEFORE_TAX"
};

const payload = {
  version: "price-v3",
  unitAmountMinor: 5_000,
  duplexAdjustmentBasisPoints: -1_000,
  serviceFeeMinor: 0,
  minimumAmountMinor: 10_000,
  taxBasisPoints: 2_000
};

describe("the canonical text a change's digest is taken over", () => {
  /**
   * The format is reproduced in SQL by `pricing_rule_sets_canonical_text`, and a
   * publication fails closed if the two ever disagree. This asserts the exact
   * bytes so that a well-meaning tidy-up here has to fail a test rather than
   * silently invalidate every publication record the database has ever checked.
   */
  it("is exactly the four lines the database recomputes", () => {
    expect(canonicalPricingPublishText({ ...tariff, payload })).toBe(
      [
        "pricing.publish/v1",
        "version=price-v3",
        "scope=GLOBAL|ref=|currency=AMD|exponent=2|rounding=HALF_UP|tax=EXCLUSIVE|minimum=BEFORE_TAX",
        "rule=PRINT|A4|MONOCHROME|5000|-1000|0|10000|2000|0"
      ].join("\n")
    );
  });

  it("changes when any single number changes", () => {
    const base = canonicalPricingPublishText({ ...tariff, payload });
    for (const key of [
      "unitAmountMinor",
      "duplexAdjustmentBasisPoints",
      "serviceFeeMinor",
      "minimumAmountMinor",
      "taxBasisPoints"
    ] as const) {
      const moved = { ...payload, [key]: payload[key] + 1 };
      expect(canonicalPricingPublishText({ ...tariff, payload: moved })).not.toBe(base);
    }
  });

  // The currency is not part of the request, and this is what stops a change
  // priced out against one tariff being published on top of a redenominated one:
  // the baseline digest moves even though the payload did not.
  it("changes when the tariff it is derived from changes", () => {
    expect(canonicalPricingPublishText({ ...tariff, currency: "USD", payload })).not.toBe(
      canonicalPricingPublishText({ ...tariff, payload })
    );
  });
});

describe("what may be priced out", () => {
  it("accepts a whole tariff", () => {
    const parsed = previewChangeBodySchema.parse({
      payload: { kind: "PRICING_PUBLISH", pricing: payload }
    });
    expect(parsed.payload.pricing.version).toBe("price-v3");
  });

  it("refuses a currency, a scope, or a validity window", () => {
    for (const extra of [{ currency: "USD" }, { scope: "KIOSK" }, { validFrom: "2026-01-01" }]) {
      expect(() =>
        previewChangeBodySchema.parse({
          payload: { kind: "PRICING_PUBLISH", pricing: { ...payload, ...extra } }
        })
      ).toThrow();
    }
  });

  it("refuses amounts outside what the database would accept", () => {
    for (const invalid of [
      { unitAmountMinor: -1 },
      { taxBasisPoints: 10_001 },
      { duplexAdjustmentBasisPoints: -10_001 },
      { minimumAmountMinor: 100_000_001 },
      { unitAmountMinor: 1.5 }
    ]) {
      expect(() =>
        previewChangeBodySchema.parse({
          payload: { kind: "PRICING_PUBLISH", pricing: { ...payload, ...invalid } }
        })
      ).toThrow();
    }
  });
});

describe("what may be published", () => {
  const body = {
    payload: { kind: "PRICING_PUBLISH", pricing: payload },
    payloadDigest: "a".repeat(64),
    baselineDigest: "b".repeat(64),
    reason: "Paper costs went up in March."
  };

  it("accepts a tariff, both digests and a reason", () => {
    const parsed = publishChangeBodySchema.parse(body);
    expect(parsed.payloadDigest).toHaveLength(64);
    expect(parsed.baselineDigest).toHaveLength(64);
  });

  // Publishing without echoing what was previewed would make the review step
  // decorative: the digests are the only thing tying the numbers on screen to
  // the numbers being written.
  it("refuses a publication that echoes no preview", () => {
    for (const missing of ["payloadDigest", "baselineDigest"] as const) {
      const rest: Record<string, unknown> = { ...body };
      delete rest[missing];
      expect(() => publishChangeBodySchema.parse(rest)).toThrow();
    }
    expect(() => publishChangeBodySchema.parse({ ...body, payloadDigest: "nope" })).toThrow();
  });

  it("refuses a reason nobody could act on", () => {
    expect(() => publishChangeBodySchema.parse({ ...body, reason: "up" })).toThrow();
  });
});

describe("the shape of the workflow", () => {
  // One page is where the minimum charge shows up, and duplex is the only place
  // the adjustment appears at all. A basket list without both would let a change
  // to either be published without anybody seeing what it did.
  it("prices a basket that exposes the minimum and one that exposes duplex", () => {
    expect(PRICING_PREVIEW_BASKETS.some((basket) => basket.printedSides === 1)).toBe(true);
    expect(PRICING_PREVIEW_BASKETS.some((basket) => basket.duplex)).toBe(true);
  });
});
