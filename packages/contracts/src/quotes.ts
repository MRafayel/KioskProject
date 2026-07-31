import { z } from "zod";

export const quoteStatusSchema = z.enum(["ACTIVE", "EXPIRED", "INVALIDATED", "CONSUMED"]);

export const quoteInvalidationReasonSchema = z.enum([
  "SETTINGS_CHANGED",
  "DOCUMENTS_CHANGED",
  "SUPERSEDED",
  "SESSION_TERMINAL"
]);

export const createQuoteBodySchema = z
  .object({ settingsRevision: z.number().int().positive() })
  .strict();

/**
 * Money crosses this boundary only as integer minor units plus a currency and
 * its exponent. No request ever carries a price: the browser can render this
 * breakdown but never proposes one.
 */
const minorAmountSchema = z.number().int().min(0).max(100_000_000);

export const quoteBreakdownSchema = z
  .object({
    printAmountMinor: minorAmountSchema,
    duplexAdjustmentMinor: z.number().int().min(-100_000_000).max(100_000_000),
    serviceFeeMinor: minorAmountSchema,
    minimumAdjustmentMinor: minorAmountSchema
  })
  .strict();

export const priceQuoteSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    settingsRevision: z.number().int().positive(),
    pricingVersion: z.string().min(1).max(40),
    status: quoteStatusSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    currencyExponent: z.number().int().min(0).max(4),
    selectedPages: z.number().int().positive(),
    printedSides: z.number().int().positive(),
    physicalSheets: z.number().int().positive(),
    breakdown: quoteBreakdownSchema,
    subtotalMinor: minorAmountSchema,
    taxMinor: minorAmountSchema,
    totalMinor: minorAmountSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime()
  })
  .strict();

export const createQuoteResponseSchema = z.object({ quote: priceQuoteSchema }).strict();
export const getQuoteResponseSchema = z.object({ quote: priceQuoteSchema }).strict();

export type QuoteStatus = z.infer<typeof quoteStatusSchema>;
export type QuoteInvalidationReason = z.infer<typeof quoteInvalidationReasonSchema>;
export type CreateQuoteBody = z.infer<typeof createQuoteBodySchema>;
export type QuoteBreakdown = z.infer<typeof quoteBreakdownSchema>;
export type PriceQuote = z.infer<typeof priceQuoteSchema>;
export type CreateQuoteResponse = z.infer<typeof createQuoteResponseSchema>;
export type GetQuoteResponse = z.infer<typeof getQuoteResponseSchema>;
