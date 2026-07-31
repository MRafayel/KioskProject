import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyBasisPoints,
  calculateQuote,
  MAX_QUOTE_AMOUNT_MINOR,
  selectPricingRule,
  type PricingError,
  type PricingRule,
  type PricingRuleSet,
  type PricingUsage,
  type RoundingMode
} from "./index.js";

function ruleSet(overrides: Partial<PricingRuleSet> = {}): PricingRuleSet {
  return {
    id: "0190efb7-0000-7000-8000-000000000101",
    version: "price-test-1",
    currency: "USD",
    currencyExponent: 2,
    rounding: "HALF_UP",
    taxMode: "EXCLUSIVE",
    minimumApplication: "BEFORE_TAX",
    rules: [rule()],
    ...overrides
  };
}

function rule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    service: "PRINT",
    paperSize: "A4",
    colorMode: "MONOCHROME",
    unitAmountMinor: 12,
    duplexAdjustmentBasisPoints: 0,
    serviceFeeMinor: 20,
    minimumAmountMinor: 100,
    taxBasisPoints: 1_000,
    priority: 0,
    ...overrides
  };
}

function usage(overrides: Partial<PricingUsage> = {}): PricingUsage {
  return {
    service: "PRINT",
    paperSize: "A4",
    colorMode: "MONOCHROME",
    duplex: true,
    selectedPages: 5,
    printedSides: 6,
    physicalSheets: 4,
    ...overrides
  };
}

describe("worked example from the build plan", () => {
  it("prices five pages, two copies, two-up duplex at 110 cents", () => {
    const breakdown = calculateQuote({ ruleSet: ruleSet(), usage: usage() });

    expect(breakdown).toMatchObject({
      printAmountMinor: 72,
      serviceFeeMinor: 20,
      minimumAdjustmentMinor: 8,
      subtotalMinor: 100,
      taxMinor: 10,
      totalMinor: 110,
      currency: "USD",
      currencyExponent: 2,
      pricingVersion: "price-test-1"
    });
  });

  it("reproduces the identical total for identical inputs and pricing version", () => {
    const first = calculateQuote({ ruleSet: ruleSet(), usage: usage() });
    const second = calculateQuote({ ruleSet: ruleSet(), usage: usage() });
    expect(second).toEqual(first);
  });
});

describe("rounding", () => {
  it("rounds a single division at the stated point", () => {
    const cases: Array<[RoundingMode, number, number]> = [
      ["HALF_UP", 105, 11],
      ["HALF_EVEN", 105, 10],
      ["HALF_EVEN", 115, 12],
      ["TOWARD_ZERO", 199, 19],
      ["AWAY_FROM_ZERO", 101, 11]
    ];

    for (const [mode, amount, expected] of cases) {
      expect(applyBasisPoints(amount, 1_000, mode)).toBe(expected);
    }
  });

  it("rounds a negative adjustment symmetrically about zero", () => {
    expect(applyBasisPoints(-105, 1_000, "HALF_UP")).toBe(-11);
    expect(applyBasisPoints(-199, 1_000, "TOWARD_ZERO")).toBe(-19);
    expect(applyBasisPoints(-101, 1_000, "AWAY_FROM_ZERO")).toBe(-11);
  });

  it("returns an exact integer whenever the division is exact", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.constantFrom<RoundingMode>("HALF_UP", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"),
        (multiple, mode) => {
          expect(applyBasisPoints(multiple * 10_000, 1, mode)).toBe(multiple);
          expect(applyBasisPoints(multiple, 10_000, mode)).toBe(multiple);
        }
      )
    );
  });
});

describe("duplex, fees, minimum and tax", () => {
  it("applies the duplex adjustment only to duplex output", () => {
    const discounted = ruleSet({
      rules: [
        rule({ duplexAdjustmentBasisPoints: -1_000, minimumAmountMinor: 0, serviceFeeMinor: 0 })
      ]
    });

    const duplex = calculateQuote({ ruleSet: discounted, usage: usage({ duplex: true }) });
    const simplex = calculateQuote({
      ruleSet: discounted,
      usage: usage({ duplex: false, physicalSheets: 6 })
    });

    expect(duplex.duplexAdjustmentMinor).toBe(-7);
    expect(duplex.totalMinor).toBe(72 - 7 + 7);
    expect(simplex.duplexAdjustmentMinor).toBe(0);
    expect(simplex.printAmountMinor).toBe(72);
  });

  it("charges the same per printed side whether or not sheets are shared", () => {
    const flat = ruleSet({
      rules: [rule({ serviceFeeMinor: 0, minimumAmountMinor: 0, taxBasisPoints: 0 })]
    });
    const duplex = calculateQuote({ ruleSet: flat, usage: usage({ physicalSheets: 3 }) });
    const simplex = calculateQuote({
      ruleSet: flat,
      usage: usage({ duplex: false, physicalSheets: 6 })
    });
    expect(duplex.totalMinor).toBe(simplex.totalMinor);
  });

  it("can apply the minimum after tax when the rule set says so", () => {
    // Taxed on the un-topped-up charge: 92 + 9 already clears a 100 minimum.
    const clears = calculateQuote({
      ruleSet: ruleSet({ minimumApplication: "AFTER_TAX" }),
      usage: usage()
    });
    expect(clears).toMatchObject({
      subtotalMinor: 92,
      taxMinor: 9,
      totalMinor: 101,
      minimumAdjustmentMinor: 0
    });

    // A higher minimum tops the gross amount up instead of the subtotal, so
    // the same job is charged differently than under BEFORE_TAX.
    const topsUp = calculateQuote({
      ruleSet: ruleSet({
        minimumApplication: "AFTER_TAX",
        rules: [rule({ minimumAmountMinor: 150 })]
      }),
      usage: usage()
    });
    expect(topsUp).toMatchObject({
      subtotalMinor: 92,
      taxMinor: 9,
      totalMinor: 150,
      minimumAdjustmentMinor: 49
    });
  });

  it("never returns a negative total when an adjustment exceeds the charge", () => {
    const generous = ruleSet({
      rules: [
        rule({
          duplexAdjustmentBasisPoints: -10_000,
          serviceFeeMinor: 0,
          minimumAmountMinor: 0,
          taxBasisPoints: 0
        })
      ]
    });
    expect(calculateQuote({ ruleSet: generous, usage: usage() }).totalMinor).toBe(0);
  });
});

describe("rule selection and validation", () => {
  it("prefers the highest priority matching rule", () => {
    const set = ruleSet({
      rules: [
        rule({ priority: 0, unitAmountMinor: 12 }),
        rule({ priority: 5, unitAmountMinor: 30 })
      ]
    });
    expect(selectPricingRule(set, usage()).unitAmountMinor).toBe(30);
  });

  it("refuses to price a combination it has no published rule for", () => {
    expect(attemptError(ruleSet(), usage({ paperSize: "A3" })).code).toBe("PRICING_RULE_NOT_FOUND");
    expect(attemptError(ruleSet(), usage({ colorMode: "COLOR" })).code).toBe(
      "PRICING_RULE_NOT_FOUND"
    );
  });

  it("refuses impossible usage rather than inventing a total", () => {
    expect(attemptError(ruleSet(), usage({ printedSides: 0 })).code).toBe("PRICING_USAGE_INVALID");
    expect(attemptError(ruleSet(), usage({ printedSides: 2, physicalSheets: 3 })).code).toBe(
      "PRICING_USAGE_INVALID"
    );
    expect(attemptError(ruleSet(), usage({ selectedPages: 1.5 })).code).toBe(
      "PRICING_USAGE_INVALID"
    );
  });

  it("refuses a malformed published rule set", () => {
    expect(attemptError(ruleSet({ currency: "usd" }), usage()).code).toBe(
      "PRICING_RULE_SET_INVALID"
    );
    expect(attemptError(ruleSet({ rules: [rule({ unitAmountMinor: -1 })] }), usage()).code).toBe(
      "PRICING_RULE_SET_INVALID"
    );
    expect(
      attemptError(ruleSet({ rules: [rule({ duplexAdjustmentBasisPoints: 20_000 })] }), usage())
        .code
    ).toBe("PRICING_RULE_SET_INVALID");
  });

  it("refuses an amount beyond the payable ceiling", () => {
    expect(
      attemptError(
        ruleSet({ rules: [rule({ unitAmountMinor: 1_000_000 })] }),
        usage({ printedSides: 1_000, physicalSheets: 500 })
      ).code
    ).toBe("PRICING_AMOUNT_LIMIT_EXCEEDED");
  });
});

describe("pricing properties", () => {
  it("keeps every amount an integer, non-negative and internally consistent", () => {
    fc.assert(
      fc.property(
        fc.record({
          unitAmountMinor: fc.integer({ min: 0, max: 5_000 }),
          serviceFeeMinor: fc.integer({ min: 0, max: 5_000 }),
          minimumAmountMinor: fc.integer({ min: 0, max: 20_000 }),
          taxBasisPoints: fc.integer({ min: 0, max: 10_000 }),
          duplexAdjustmentBasisPoints: fc.integer({ min: -10_000, max: 10_000 })
        }),
        fc.record({
          rounding: fc.constantFrom<RoundingMode>(
            "HALF_UP",
            "HALF_EVEN",
            "TOWARD_ZERO",
            "AWAY_FROM_ZERO"
          ),
          minimumApplication: fc.constantFrom<PricingRuleSet["minimumApplication"]>(
            "BEFORE_TAX",
            "AFTER_TAX"
          )
        }),
        fc.integer({ min: 1, max: 400 }),
        fc.boolean(),
        (ruleValues, setValues, printedSides, duplex) => {
          const physicalSheets = duplex ? Math.ceil(printedSides / 2) : printedSides;
          const breakdown = calculateQuote({
            ruleSet: ruleSet({ ...setValues, rules: [rule(ruleValues)] }),
            usage: usage({
              duplex,
              printedSides,
              physicalSheets,
              selectedPages: printedSides
            })
          });

          for (const amount of [
            breakdown.printAmountMinor,
            breakdown.serviceFeeMinor,
            breakdown.minimumAdjustmentMinor,
            breakdown.subtotalMinor,
            breakdown.taxMinor,
            breakdown.totalMinor,
            breakdown.duplexAdjustmentMinor
          ]) {
            expect(Number.isSafeInteger(amount)).toBe(true);
          }

          expect(breakdown.totalMinor).toBeGreaterThanOrEqual(0);
          expect(breakdown.totalMinor).toBeLessThanOrEqual(MAX_QUOTE_AMOUNT_MINOR);
          expect(breakdown.subtotalMinor).toBeGreaterThanOrEqual(0);

          // The same identity the database check constraint enforces.
          const charged = Math.max(
            breakdown.printAmountMinor +
              breakdown.duplexAdjustmentMinor +
              breakdown.serviceFeeMinor,
            0
          );
          expect(
            breakdown.subtotalMinor -
              charged +
              (breakdown.totalMinor - breakdown.subtotalMinor - breakdown.taxMinor)
          ).toBe(breakdown.minimumAdjustmentMinor);
        }
      )
    );
  });

  it("is monotonic in printed sides", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (printedSides) => {
        const cheaper = calculateQuote({
          ruleSet: ruleSet(),
          usage: usage({ duplex: false, printedSides, physicalSheets: printedSides })
        });
        const dearer = calculateQuote({
          ruleSet: ruleSet(),
          usage: usage({
            duplex: false,
            printedSides: printedSides + 1,
            physicalSheets: printedSides + 1
          })
        });
        expect(dearer.totalMinor).toBeGreaterThanOrEqual(cheaper.totalMinor);
      })
    );
  });
});

function attemptError(set: PricingRuleSet, input: PricingUsage): PricingError {
  try {
    calculateQuote({ ruleSet: set, usage: input });
  } catch (error) {
    return error as PricingError;
  }
  throw new Error("EXPECTED_PRICING_ERROR");
}
