/**
 * The boundary between payment orchestration and a payment provider.
 *
 * Everything above this line — the ledger, the state machine, the session
 * transitions — is provider-agnostic. A provider sees an amount, a currency,
 * an intent identifier and an idempotency key, and answers with a status. It
 * never sees a document, and this system never sees a card number: primary
 * account numbers, track data, PINs and contactless cryptograms must not reach
 * this process, its database, its logs or its telemetry.
 */

export interface Money {
  /** Integer minor units. Money is never a floating-point number. */
  amountMinor: number;
  currency: string;
  currencyExponent: number;
}

export type PaymentIntentStatus = "PENDING" | "AUTHORIZED" | "CAPTURED" | "CANCELED";

export type ProviderWebhookType =
  "PAYMENT_CAPTURED" | "PAYMENT_DECLINED" | "PAYMENT_CANCELED" | "PAYMENT_TIMED_OUT";

export interface CreateIntentInput {
  paymentId: string;
  sessionId: string;
  amount: Money;
  idempotencyKey: string;
}

export interface CreateIntentResult {
  providerIntentId: string;
  status: PaymentIntentStatus;
}

export interface RefundInput {
  providerIntentId: string;
  amount: Money;
  reason: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: "PENDING" | "COMPLETED";
}

export interface ProviderWebhookEvent {
  providerEventId: string;
  providerIntentId: string;
  type: ProviderWebhookType;
  amount: Money;
  occurredAt: Date;
  failureCode: string | null;
  /** sha256 of the exact bytes that were signed, for the webhook inbox. */
  payloadDigest: string;
}

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: CreateIntentInput): Promise<CreateIntentResult>;
  confirm(
    providerIntentId: string,
    idempotencyKey: string
  ): Promise<{ status: PaymentIntentStatus }>;
  cancel(
    providerIntentId: string,
    idempotencyKey: string
  ): Promise<{ status: PaymentIntentStatus }>;
  refund(input: RefundInput): Promise<RefundResult>;
  /**
   * What the provider believes about an intent, used only by reconciliation.
   * `UNKNOWN` is a real answer: it means the provider cannot yet say, and the
   * caller must not invent an outcome from it.
   */
  getIntentStatus(providerIntentId: string): Promise<PaymentIntentStatus | "UNKNOWN">;
  /**
   * Verify a webhook against its raw bytes. Parsing a re-serialized body would
   * verify a signature over something the provider never sent.
   */
  verifyAndParseWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | string[] | undefined>>,
    receivedAt: Date
  ): Promise<ProviderWebhookEvent>;
}

export type PaymentProviderErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "WEBHOOK_SIGNATURE_INVALID"
  | "WEBHOOK_MALFORMED"
  | "WEBHOOK_STALE"
  | "WEBHOOK_TOO_LARGE";

export class PaymentProviderError extends Error {
  public constructor(public readonly code: PaymentProviderErrorCode) {
    super(code);
    this.name = "PaymentProviderError";
  }
}
