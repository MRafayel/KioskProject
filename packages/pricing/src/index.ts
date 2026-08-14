/**
 * Pure pricing.
 *
 * Money is always an integer count of ISO minor units plus an explicit
 * currency. No value in this package is ever a floating-point amount, a
 * percentage as a fraction, or a locale-formatted string. Percentages are
 * integer basis points and every division states its rounding rule, so the
 * same inputs and the same published rule set always produce the same total.
 */

export const ROUNDING_MODES = ["HALF_UP", "HALF_EVEN", "AWAY_FROM_ZERO", "TOWARD_ZERO"] as const;
export const TAX_MODES = ["EXCLUSIVE"] as const;
export const MINIMUM_APPLICATION_POINTS = ["BEFORE_TAX", "AFTER_TAX"] as const;

export const BASIS_POINT_SCALE = 10_000;
/**
 * A ceiling well above any plausible kiosk transaction. It exists so that a
 * corrupted rule set or an absurd copy count fails loudly instead of quietly
 * producing an unpayable or precision-losing amount.
 */
export const MAX_QUOTE_AMOUNT_MINOR = 100_000_000;

export type RoundingMode = (typeof ROUNDING_MODES)[number];
export type TaxMode = (typeof TAX_MODES)[number];
export type MinimumApplicationPoint = (typeof MINIMUM_APPLICATION_POINTS)[number];

export interface PricingRule {
  service: string;
  paperSize: string;
  colorMode: string;
  /** Charged per printed side, not per sheet: duplex changes paper, not ink. */
  unitAmountMinor: number;
  /** Signed adjustment applied to the print charge when output is duplex. */
  duplexAdjustmentBasisPoints: number;
  serviceFeeMinor: number;
  minimumAmountMinor: number;
  taxBasisPoints: number;
  priority: number;
}

export interface PricingRuleSet {
  id: string;
  version: string;
  currency: string;
  currencyExponent: number;
  rounding: RoundingMode;
  taxMode: TaxMode;
  minimumApplication: MinimumApplicationPoint;
  rules: readonly PricingRule[];
}

/**
 * One document's contribution to the job.
 *
 * Sides are priced at the job's single rule, but the duplex adjustment is a
 * property of how a document is printed, so a job that is duplex for one
 * document and simplex for another cannot be adjusted as a whole.
 */
export interface PricingDocumentUsage {
  duplex: boolean;
  printedSides: number;
}

export interface PricingUsage {
  service: string;
  paperSize: string;
  colorMode: string;
  documents: readonly PricingDocumentUsage[];
  selectedPages: number;
  printedSides: number;
  physicalSheets: number;
}

export interface QuoteBreakdown {
  pricingVersion: string;
  ruleSetId: string;
  currency: string;
  currencyExponent: number;
  selectedPages: number;
  printedSides: number;
  physicalSheets: number;
  printAmountMinor: number;
  duplexAdjustmentMinor: number;
  serviceFeeMinor: number;
  minimumAdjustmentMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export type PricingErrorCode =
  | "PRICING_RULE_NOT_FOUND"
  | "PRICING_RULE_SET_INVALID"
  | "PRICING_USAGE_INVALID"
  | "PRICING_AMOUNT_LIMIT_EXCEEDED";

export class PricingError extends Error {
  public constructor(
    public readonly code: PricingErrorCode,
    public readonly details: Readonly<Record<string, string | number>> = {}
  ) {
    super(code);
    this.name = "PricingError";
  }
}

/**
 * Multiply an integer minor amount by integer basis points and round the
 * single division exactly once, at the stated rounding point.
 */
export function applyBasisPoints(
  amountMinor: number,
  basisPoints: number,
  rounding: RoundingMode
): number {
  assertSafeInteger(amountMinor, "amountMinor");
  assertSafeInteger(basisPoints, "basisPoints");

  const product = amountMinor * basisPoints;
  if (!Number.isSafeInteger(product)) {
    throw new PricingError("PRICING_AMOUNT_LIMIT_EXCEEDED", { amountMinor, basisPoints });
  }

  const sign = product < 0 ? -1 : 1;
  const magnitude = Math.abs(product);
  const quotient = Math.floor(magnitude / BASIS_POINT_SCALE);
  const remainder = magnitude % BASIS_POINT_SCALE;
  if (remainder === 0) return sign * quotient;

  const twiceRemainder = remainder * 2;
  switch (rounding) {
    case "TOWARD_ZERO":
      return sign * quotient;
    case "AWAY_FROM_ZERO":
      return sign * (quotient + 1);
    case "HALF_UP":
      return sign * (twiceRemainder >= BASIS_POINT_SCALE ? quotient + 1 : quotient);
    case "HALF_EVEN": {
      if (twiceRemainder > BASIS_POINT_SCALE) return sign * (quotient + 1);
      if (twiceRemainder < BASIS_POINT_SCALE) return sign * quotient;
      return sign * (quotient % 2 === 0 ? quotient : quotient + 1);
    }
    default:
      return assertNever(rounding);
  }
}

export function selectPricingRule(ruleSet: PricingRuleSet, usage: PricingUsage): PricingRule {
  const matches = ruleSet.rules.filter(
    (rule) =>
      rule.service === usage.service &&
      rule.paperSize === usage.paperSize &&
      rule.colorMode === usage.colorMode
  );
  const selected = [...matches].sort((left, right) => right.priority - left.priority)[0];
  if (!selected) {
    throw new PricingError("PRICING_RULE_NOT_FOUND", {
      service: usage.service,
      paperSize: usage.paperSize,
      colorMode: usage.colorMode
    });
  }
  return selected;
}

export function calculateQuote(input: {
  ruleSet: PricingRuleSet;
  usage: PricingUsage;
}): QuoteBreakdown {
  assertRuleSet(input.ruleSet);
  assertUsage(input.usage);

  const rule = selectPricingRule(input.ruleSet, input.usage);
  assertRule(rule);

  const printAmountMinor = boundedProduct(input.usage.printedSides, rule.unitAmountMinor);
  // The adjustment is worked out per document and summed, so a job that is
  // duplex for one document and simplex for another is adjusted only on the
  // sides that were actually printed double-sided. Each document is rounded on
  // its own, which is the same arithmetic a single-document job has always had.
  const duplexAdjustmentMinor = input.usage.documents.reduce((total, document) => {
    if (!document.duplex) return total;
    const documentAmountMinor = boundedProduct(document.printedSides, rule.unitAmountMinor);
    return (
      total +
      applyBasisPoints(
        documentAmountMinor,
        rule.duplexAdjustmentBasisPoints,
        input.ruleSet.rounding
      )
    );
  }, 0);

  const adjustedMinor = printAmountMinor + duplexAdjustmentMinor + rule.serviceFeeMinor;
  // A negative promotion or duplex discount must never produce a refundable
  // total; the floor is zero before the published minimum is considered.
  const flooredMinor = Math.max(adjustedMinor, 0);

  const appliesBeforeTax = input.ruleSet.minimumApplication === "BEFORE_TAX";
  const beforeTaxMinor = appliesBeforeTax
    ? Math.max(flooredMinor, rule.minimumAmountMinor)
    : flooredMinor;
  const taxMinor = applyBasisPoints(beforeTaxMinor, rule.taxBasisPoints, input.ruleSet.rounding);
  const grossMinor = beforeTaxMinor + taxMinor;
  const totalMinor = appliesBeforeTax ? grossMinor : Math.max(grossMinor, rule.minimumAmountMinor);
  const minimumAdjustmentMinor = appliesBeforeTax
    ? beforeTaxMinor - flooredMinor
    : totalMinor - grossMinor;

  assertWithinLimit(totalMinor);

  return {
    pricingVersion: input.ruleSet.version,
    ruleSetId: input.ruleSet.id,
    currency: input.ruleSet.currency,
    currencyExponent: input.ruleSet.currencyExponent,
    selectedPages: input.usage.selectedPages,
    printedSides: input.usage.printedSides,
    physicalSheets: input.usage.physicalSheets,
    printAmountMinor,
    duplexAdjustmentMinor,
    serviceFeeMinor: rule.serviceFeeMinor,
    minimumAdjustmentMinor,
    subtotalMinor: beforeTaxMinor,
    taxMinor,
    totalMinor
  };
}

function assertRuleSet(ruleSet: PricingRuleSet): void {
  if (!/^[A-Z]{3}$/.test(ruleSet.currency)) {
    throw new PricingError("PRICING_RULE_SET_INVALID", { currency: ruleSet.currency });
  }
  if (!Number.isSafeInteger(ruleSet.currencyExponent) || ruleSet.currencyExponent < 0) {
    throw new PricingError("PRICING_RULE_SET_INVALID", {
      currencyExponent: ruleSet.currencyExponent
    });
  }
  if (!ROUNDING_MODES.includes(ruleSet.rounding)) {
    throw new PricingError("PRICING_RULE_SET_INVALID", { rounding: ruleSet.rounding });
  }
  if (!TAX_MODES.includes(ruleSet.taxMode)) {
    throw new PricingError("PRICING_RULE_SET_INVALID", { taxMode: ruleSet.taxMode });
  }
  if (!MINIMUM_APPLICATION_POINTS.includes(ruleSet.minimumApplication)) {
    throw new PricingError("PRICING_RULE_SET_INVALID", {
      minimumApplication: ruleSet.minimumApplication
    });
  }
}

function assertRule(rule: PricingRule): void {
  const nonNegative: Array<[string, number]> = [
    ["unitAmountMinor", rule.unitAmountMinor],
    ["serviceFeeMinor", rule.serviceFeeMinor],
    ["minimumAmountMinor", rule.minimumAmountMinor],
    ["taxBasisPoints", rule.taxBasisPoints]
  ];
  for (const [name, value] of nonNegative) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PricingError("PRICING_RULE_SET_INVALID", { [name]: value });
    }
  }
  if (
    !Number.isSafeInteger(rule.duplexAdjustmentBasisPoints) ||
    rule.duplexAdjustmentBasisPoints < -BASIS_POINT_SCALE ||
    rule.duplexAdjustmentBasisPoints > BASIS_POINT_SCALE
  ) {
    throw new PricingError("PRICING_RULE_SET_INVALID", {
      duplexAdjustmentBasisPoints: rule.duplexAdjustmentBasisPoints
    });
  }
}

function assertUsage(usage: PricingUsage): void {
  const positive: Array<[string, number]> = [
    ["selectedPages", usage.selectedPages],
    ["printedSides", usage.printedSides],
    ["physicalSheets", usage.physicalSheets]
  ];
  for (const [name, value] of positive) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PricingError("PRICING_USAGE_INVALID", { [name]: value });
    }
  }
  if (usage.physicalSheets > usage.printedSides) {
    throw new PricingError("PRICING_USAGE_INVALID", {
      printedSides: usage.printedSides,
      physicalSheets: usage.physicalSheets
    });
  }

  // The per-document breakdown decides the duplex adjustment, so it has to
  // account for exactly the sides the job is charged for. A breakdown that
  // disagrees with the total would price sides nobody is paying for.
  if (usage.documents.length === 0) {
    throw new PricingError("PRICING_USAGE_INVALID", { documents: usage.documents.length });
  }
  let documentSides = 0;
  for (const document of usage.documents) {
    if (!Number.isSafeInteger(document.printedSides) || document.printedSides < 1) {
      throw new PricingError("PRICING_USAGE_INVALID", { printedSides: document.printedSides });
    }
    documentSides += document.printedSides;
  }
  if (documentSides !== usage.printedSides) {
    throw new PricingError("PRICING_USAGE_INVALID", {
      printedSides: usage.printedSides,
      documentSides
    });
  }
}

function boundedProduct(left: number, right: number): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new PricingError("PRICING_AMOUNT_LIMIT_EXCEEDED", { left, right });
  }
  assertWithinLimit(product);
  return product;
}

function assertWithinLimit(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor > MAX_QUOTE_AMOUNT_MINOR) {
    throw new PricingError("PRICING_AMOUNT_LIMIT_EXCEEDED", { amountMinor });
  }
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new PricingError("PRICING_USAGE_INVALID", { [name]: String(value) });
  }
}

function assertNever(value: never): never {
  throw new PricingError("PRICING_RULE_SET_INVALID", { rounding: String(value) });
}
