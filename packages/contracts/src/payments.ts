import { z } from "zod";

export const paymentProviderSchema = z.enum(["MOCK"]);

export const paymentStatusSchema = z.enum([
  "PENDING",
  "AUTHORIZED",
  "CAPTURED",
  "DECLINED",
  "CANCELED",
  "TIMED_OUT"
]);

/**
 * Why a payment stopped short of a capture. The set is closed so a provider
 * string can never be echoed into an event payload or onto the screen.
 */
export const paymentFailureCodeSchema = z.enum([
  "CARD_DECLINED",
  "CUSTOMER_CANCELED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "SESSION_TERMINAL"
]);

/**
 * Starting a payment names the quote to be paid and nothing else. There is no
 * field for an amount: the total comes from the stored quote, so a browser
 * cannot propose what it would like to pay.
 */
export const createPaymentBodySchema = z
  .object({
    quoteId: z.string().uuid(),
    provider: paymentProviderSchema.default("MOCK")
  })
  .strict();

const minorAmountSchema = z.number().int().min(0).max(100_000_000);

export const paymentSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    quoteId: z.string().uuid(),
    provider: paymentProviderSchema,
    status: paymentStatusSchema,
    amountMinor: minorAmountSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    currencyExponent: z.number().int().min(0).max(4),
    failureCode: paymentFailureCodeSchema.nullable(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    capturedAt: z.string().datetime().nullable()
  })
  .strict();

export const createPaymentResponseSchema = z.object({ payment: paymentSnapshotSchema }).strict();
export const confirmPaymentResponseSchema = z.object({ payment: paymentSnapshotSchema }).strict();
export const getPaymentResponseSchema = z.object({ payment: paymentSnapshotSchema }).strict();

export const paymentWebhookAckSchema = z.object({ received: z.literal(true) }).strict();

/**
 * The development-only outcome control. It exists so the deterministic
 * provider scenarios can be driven without card hardware, and it is never
 * registered by a production configuration.
 */
export const simulatePaymentOutcomeBodySchema = z
  .object({
    outcome: z.enum(["SUCCEEDED", "DECLINED", "CANCELED", "TIMEOUT"]),
    /** Repeat deliveries prove that a duplicate callback changes nothing. */
    deliveries: z.number().int().min(1).max(3).default(1),
    delayMilliseconds: z.number().int().min(0).max(30_000).default(0)
  })
  .strict();

export const simulatePaymentOutcomeResponseSchema = z
  .object({
    payment: paymentSnapshotSchema,
    delivered: z.number().int().min(0).max(3),
    scheduled: z.boolean()
  })
  .strict();

export type PaymentProviderName = z.infer<typeof paymentProviderSchema>;
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type PaymentFailureCode = z.infer<typeof paymentFailureCodeSchema>;
export type CreatePaymentBody = z.infer<typeof createPaymentBodySchema>;
export type PaymentSnapshot = z.infer<typeof paymentSnapshotSchema>;
export type CreatePaymentResponse = z.infer<typeof createPaymentResponseSchema>;
export type ConfirmPaymentResponse = z.infer<typeof confirmPaymentResponseSchema>;
export type GetPaymentResponse = z.infer<typeof getPaymentResponseSchema>;
export type SimulatePaymentOutcomeBody = z.infer<typeof simulatePaymentOutcomeBodySchema>;
export type SimulatePaymentOutcomeResponse = z.infer<typeof simulatePaymentOutcomeResponseSchema>;
