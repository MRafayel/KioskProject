import { createHmac, createHash, timingSafeEqual } from "node:crypto";

import {
  PaymentProviderError,
  type CreateIntentInput,
  type CreateIntentResult,
  type Money,
  type PaymentIntentStatus,
  type PaymentProvider,
  type ProviderWebhookEvent,
  type ProviderWebhookType,
  type RefundInput,
  type RefundResult
} from "../types.js";

export const MOCK_PAYMENT_SIGNATURE_HEADER = "x-mock-payment-signature";
const SIGNATURE_SCHEME = "v1";
const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_WEBHOOK_BYTES = 8_192;

export type MockPaymentOutcome = "SUCCEEDED" | "DECLINED" | "CANCELED" | "TIMEOUT";

const OUTCOME_EVENTS: Readonly<Record<MockPaymentOutcome, ProviderWebhookType>> = {
  SUCCEEDED: "PAYMENT_CAPTURED",
  DECLINED: "PAYMENT_DECLINED",
  CANCELED: "PAYMENT_CANCELED",
  TIMEOUT: "PAYMENT_TIMED_OUT"
};

const EVENT_TYPES: Readonly<Record<string, ProviderWebhookType>> = {
  "payment_intent.captured": "PAYMENT_CAPTURED",
  "payment_intent.declined": "PAYMENT_DECLINED",
  "payment_intent.canceled": "PAYMENT_CANCELED",
  "payment_intent.timed_out": "PAYMENT_TIMED_OUT"
};

const WIRE_TYPES: Readonly<Record<ProviderWebhookType, string>> = {
  PAYMENT_CAPTURED: "payment_intent.captured",
  PAYMENT_DECLINED: "payment_intent.declined",
  PAYMENT_CANCELED: "payment_intent.canceled",
  PAYMENT_TIMED_OUT: "payment_intent.timed_out"
};

const FAILURE_CODES: Readonly<Record<ProviderWebhookType, string | null>> = {
  PAYMENT_CAPTURED: null,
  PAYMENT_DECLINED: "CARD_DECLINED",
  PAYMENT_CANCELED: "CUSTOMER_CANCELED",
  PAYMENT_TIMED_OUT: "PROVIDER_TIMEOUT"
};

export interface MockPaymentProviderOptions {
  /** Shared secret for webhook signatures. Never leaves the control plane. */
  webhookSecret: string;
  signatureToleranceSeconds?: number;
  maxWebhookBytes?: number;
  /**
   * Simulates a provider outage. Only a test or a local scenario sets this;
   * nothing in a request can reach it.
   */
  unavailable?: boolean;
}

export interface SignedMockWebhook {
  body: string;
  headers: Record<string, string>;
}

/**
 * A deterministic payment provider.
 *
 * It holds no state, performs no input or output, and derives every identifier
 * from the payment it was asked about, so the same call always produces the
 * same answer — including after a crash and a retry. Outcomes are not decided
 * here: a signed callback is authoritative, exactly as it is with a real
 * provider, and the mock only knows how to sign and verify one.
 */
export class MockPaymentProvider implements PaymentProvider {
  public readonly name = "MOCK";
  private readonly toleranceSeconds: number;
  private readonly maxWebhookBytes: number;

  public constructor(private readonly options: MockPaymentProviderOptions) {
    if (options.webhookSecret.length < 32) throw new Error("MOCK_PAYMENT_SECRET_TOO_SHORT");
    this.toleranceSeconds = options.signatureToleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.maxWebhookBytes = options.maxWebhookBytes ?? DEFAULT_MAX_WEBHOOK_BYTES;
  }

  public createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    return this.settle(() => {
      this.assertAvailable();
      return { providerIntentId: mockIntentId(input.paymentId), status: "PENDING" };
    });
  }

  public confirm(providerIntentId: string): Promise<{ status: PaymentIntentStatus }> {
    return this.settle(() => {
      this.assertAvailable();
      assertIntentId(providerIntentId);
      // Confirmation only tells the provider the customer is ready. Whether
      // money moved is answered by a signed callback, never by this response.
      return { status: "PENDING" };
    });
  }

  public cancel(providerIntentId: string): Promise<{ status: PaymentIntentStatus }> {
    return this.settle(() => {
      this.assertAvailable();
      assertIntentId(providerIntentId);
      return { status: "CANCELED" };
    });
  }

  public refund(input: RefundInput): Promise<RefundResult> {
    return this.settle(() => {
      this.assertAvailable();
      assertIntentId(input.providerIntentId);
      return {
        providerRefundId: `mock_re_${digest(input.providerIntentId, input.idempotencyKey)}`,
        status: "PENDING"
      };
    });
  }

  public getIntentStatus(providerIntentId: string): Promise<PaymentIntentStatus | "UNKNOWN"> {
    return this.settle(() => {
      this.assertAvailable();
      assertIntentId(providerIntentId);
      // The mock keeps no ledger, so it can never claim an intent settled. A
      // reconciler must treat this as "still unknown" rather than as a failure.
      return "UNKNOWN";
    });
  }

  public verifyAndParseWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | string[] | undefined>>,
    receivedAt: Date
  ): Promise<ProviderWebhookEvent> {
    return this.settle(() => {
      if (rawBody.byteLength === 0 || rawBody.byteLength > this.maxWebhookBytes) {
        throw new PaymentProviderError("WEBHOOK_TOO_LARGE");
      }

      const signature = parseSignatureHeader(readHeader(headers, MOCK_PAYMENT_SIGNATURE_HEADER));
      const skewSeconds = Math.abs(Math.floor(receivedAt.getTime() / 1_000) - signature.timestamp);
      if (skewSeconds > this.toleranceSeconds) throw new PaymentProviderError("WEBHOOK_STALE");

      const body = Buffer.from(rawBody);
      const expected = this.sign(signature.timestamp, body);
      if (!safelyEqualHex(expected, signature.signature)) {
        throw new PaymentProviderError("WEBHOOK_SIGNATURE_INVALID");
      }

      return {
        ...parseWebhookBody(body),
        payloadDigest: createHash("sha256").update(body).digest("hex")
      };
    });
  }

  /**
   * Produce the callback a provider would send for a chosen outcome. Only the
   * development outcome route and tests use this; the identifiers are derived
   * from the payment, so re-signing the same outcome is a duplicate delivery
   * rather than a second event.
   */
  public signOutcome(input: {
    paymentId: string;
    outcome: MockPaymentOutcome;
    amount: Money;
    occurredAt: Date;
  }): SignedMockWebhook {
    const type = OUTCOME_EVENTS[input.outcome];
    const body = JSON.stringify({
      id: `mock_evt_${digest(input.paymentId, type)}`,
      type: WIRE_TYPES[type],
      occurredAt: input.occurredAt.toISOString(),
      data: {
        intentId: mockIntentId(input.paymentId),
        amountMinor: input.amount.amountMinor,
        currency: input.amount.currency,
        currencyExponent: input.amount.currencyExponent,
        ...(FAILURE_CODES[type] ? { failureCode: FAILURE_CODES[type] } : {})
      }
    });
    const timestamp = Math.floor(input.occurredAt.getTime() / 1_000);

    return {
      body,
      headers: {
        "content-type": "application/json",
        [MOCK_PAYMENT_SIGNATURE_HEADER]: `t=${timestamp},${SIGNATURE_SCHEME}=${this.sign(
          timestamp,
          Buffer.from(body, "utf8")
        )}`
      }
    };
  }

  /**
   * Every refusal reaches the caller as a rejected promise rather than a
   * synchronous throw, so a provider that answers over the network and this
   * one behave identically at the call site.
   */
  private settle<T>(compute: () => T): Promise<T> {
    try {
      return Promise.resolve(compute());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("MOCK_PAYMENT_FAILED"));
    }
  }

  private sign(timestamp: number, body: Buffer): string {
    return createHmac("sha256", this.options.webhookSecret)
      .update(`${timestamp}.`, "utf8")
      .update(body)
      .digest("hex");
  }

  private assertAvailable(): void {
    if (this.options.unavailable) throw new PaymentProviderError("PROVIDER_UNAVAILABLE");
  }
}

export function mockIntentId(paymentId: string): string {
  return `mock_pi_${paymentId}`;
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);
}

function assertIntentId(providerIntentId: string): void {
  if (!/^mock_pi_[0-9a-f-]{36}$/.test(providerIntentId)) {
    throw new PaymentProviderError("WEBHOOK_MALFORMED");
  }
}

function readHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseSignatureHeader(value: string | undefined): { timestamp: number; signature: string } {
  if (!value || value.length > 256) throw new PaymentProviderError("WEBHOOK_SIGNATURE_INVALID");

  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const item = part.slice(separator + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(item)) timestamp = Number(item);
    if (key === SIGNATURE_SCHEME && /^[0-9a-f]{64}$/.test(item)) signature = item;
  }

  if (timestamp === undefined || signature === undefined) {
    throw new PaymentProviderError("WEBHOOK_SIGNATURE_INVALID");
  }
  return { timestamp, signature };
}

function safelyEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseWebhookBody(body: Buffer): Omit<ProviderWebhookEvent, "payloadDigest"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new PaymentProviderError("WEBHOOK_MALFORMED");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PaymentProviderError("WEBHOOK_MALFORMED");
  }

  const record = parsed as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  const type = typeof record.type === "string" ? EVENT_TYPES[record.type] : undefined;
  const occurredAt =
    typeof record.occurredAt === "string" ? new Date(record.occurredAt) : undefined;
  const failureCode = typeof data.failureCode === "string" ? data.failureCode : null;

  if (
    !type ||
    !occurredAt ||
    Number.isNaN(occurredAt.getTime()) ||
    !isIdentifier(record.id, 120) ||
    !isIdentifier(data.intentId, 120) ||
    !isMinorAmount(data.amountMinor) ||
    typeof data.currency !== "string" ||
    !/^[A-Z]{3}$/.test(data.currency) ||
    !Number.isInteger(data.currencyExponent) ||
    (data.currencyExponent as number) < 0 ||
    (data.currencyExponent as number) > 4 ||
    (failureCode !== null && !/^[A-Z_]{3,48}$/.test(failureCode))
  ) {
    throw new PaymentProviderError("WEBHOOK_MALFORMED");
  }

  return {
    providerEventId: record.id as string,
    providerIntentId: data.intentId as string,
    type,
    amount: {
      amountMinor: data.amountMinor as number,
      currency: data.currency,
      currencyExponent: data.currencyExponent as number
    },
    occurredAt,
    failureCode
  };
}

function isIdentifier(value: unknown, maximumLength: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}

function isMinorAmount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100_000_000;
}
