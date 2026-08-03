import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PaymentProviderError, type Money } from "../types.js";
import { MOCK_PAYMENT_SIGNATURE_HEADER, MockPaymentProvider, mockIntentId } from "./provider.js";

const webhookSecret = "mock-payment-webhook-secret-for-tests-0001";
const paymentId = "0190efb7-0000-7000-8000-000000000001";
const amount: Money = { amountMinor: 84_000, currency: "AMD", currencyExponent: 2 };
const occurredAt = new Date("2026-08-02T10:00:00.000Z");

function createProvider(overrides: { unavailable?: boolean } = {}) {
  return new MockPaymentProvider({ webhookSecret, ...overrides });
}

describe("MockPaymentProvider", () => {
  it("derives one intent identifier per payment, whatever the idempotency key", async () => {
    const provider = createProvider();
    const first = await provider.createIntent({
      paymentId,
      sessionId: "0190efb7-0000-7000-8000-0000000000ff",
      amount,
      idempotencyKey: "one"
    });
    const second = await provider.createIntent({
      paymentId,
      sessionId: "0190efb7-0000-7000-8000-0000000000ff",
      amount,
      idempotencyKey: "two"
    });

    expect(first.providerIntentId).toBe(mockIntentId(paymentId));
    expect(second.providerIntentId).toBe(first.providerIntentId);
    expect(first.status).toBe("PENDING");
  });

  it("never reports a capture from confirmation", async () => {
    const provider = createProvider();
    const confirmed = await provider.confirm(mockIntentId(paymentId));
    expect(confirmed.status).toBe("PENDING");
  });

  it("reports an unknown intent status rather than inventing an outcome", async () => {
    const provider = createProvider();
    await expect(provider.getIntentStatus(mockIntentId(paymentId))).resolves.toBe("UNKNOWN");
  });

  it("refuses every operation while the provider is unavailable", async () => {
    const provider = createProvider({ unavailable: true });
    await expect(
      provider.createIntent({
        paymentId,
        sessionId: "0190efb7-0000-7000-8000-0000000000ff",
        amount,
        idempotencyKey: "one"
      })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("verifies a signed callback over the exact bytes it signed", async () => {
    const provider = createProvider();
    const signed = provider.signOutcome({ paymentId, outcome: "SUCCEEDED", amount, occurredAt });

    const event = await provider.verifyAndParseWebhook(
      Buffer.from(signed.body, "utf8"),
      signed.headers,
      occurredAt
    );

    expect(event.type).toBe("PAYMENT_CAPTURED");
    expect(event.providerIntentId).toBe(mockIntentId(paymentId));
    expect(event.amount).toEqual(amount);
    expect(event.failureCode).toBeNull();
    expect(event.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives one outcome one event identifier, so a repeat delivery is a duplicate", () => {
    const provider = createProvider();
    const first = provider.signOutcome({ paymentId, outcome: "SUCCEEDED", amount, occurredAt });
    const second = provider.signOutcome({
      paymentId,
      outcome: "SUCCEEDED",
      amount,
      occurredAt: new Date(occurredAt.getTime() + 5_000)
    });
    const declined = provider.signOutcome({ paymentId, outcome: "DECLINED", amount, occurredAt });

    expect(eventId(second.body)).toBe(eventId(first.body));
    expect(eventId(declined.body)).not.toBe(eventId(first.body));
  });

  it("carries a failure code for every unsuccessful outcome", async () => {
    const provider = createProvider();
    for (const outcome of ["DECLINED", "CANCELED", "TIMEOUT"] as const) {
      const signed = provider.signOutcome({ paymentId, outcome, amount, occurredAt });
      const event = await provider.verifyAndParseWebhook(
        Buffer.from(signed.body, "utf8"),
        signed.headers,
        occurredAt
      );
      expect(event.failureCode).toMatch(/^[A-Z_]+$/);
    }
  });

  it("rejects a body that was altered after signing", async () => {
    const provider = createProvider();
    const signed = provider.signOutcome({ paymentId, outcome: "SUCCEEDED", amount, occurredAt });
    const tampered = signed.body.replace("84000", "1");

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(tampered, "utf8"), signed.headers, occurredAt)
    ).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
  });

  it("rejects a signature made with another secret", async () => {
    const provider = createProvider();
    const signed = provider.signOutcome({ paymentId, outcome: "SUCCEEDED", amount, occurredAt });
    const timestamp = Math.floor(occurredAt.getTime() / 1_000);
    const forged = createHmac("sha256", "another-secret-that-is-long-enough-0001")
      .update(`${timestamp}.${signed.body}`, "utf8")
      .digest("hex");

    await expect(
      provider.verifyAndParseWebhook(
        Buffer.from(signed.body, "utf8"),
        { [MOCK_PAYMENT_SIGNATURE_HEADER]: `t=${timestamp},v1=${forged}` },
        occurredAt
      )
    ).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
  });

  it("rejects a replayed callback outside the tolerance window", async () => {
    const provider = createProvider();
    const signed = provider.signOutcome({ paymentId, outcome: "SUCCEEDED", amount, occurredAt });

    await expect(
      provider.verifyAndParseWebhook(
        Buffer.from(signed.body, "utf8"),
        signed.headers,
        new Date(occurredAt.getTime() + 601_000)
      )
    ).rejects.toMatchObject({ code: "WEBHOOK_STALE" });
  });

  it("rejects a missing, malformed or oversized callback", async () => {
    const provider = createProvider();
    const signed = provider.signOutcome({ paymentId, outcome: "SUCCEEDED", amount, occurredAt });

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(signed.body, "utf8"), {}, occurredAt)
    ).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(
      provider.verifyAndParseWebhook(Buffer.alloc(0), signed.headers, occurredAt)
    ).rejects.toMatchObject({ code: "WEBHOOK_TOO_LARGE" });
    await expect(
      provider.verifyAndParseWebhook(Buffer.alloc(9_000, 0x61), signed.headers, occurredAt)
    ).rejects.toMatchObject({ code: "WEBHOOK_TOO_LARGE" });
  });

  it("rejects a correctly signed body that is not a payment event", async () => {
    const provider = new MockPaymentProvider({ webhookSecret });
    const body = JSON.stringify({ id: "mock_evt_1", type: "unrelated.event", data: {} });
    const timestamp = Math.floor(occurredAt.getTime() / 1_000);
    const signature = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${body}`, "utf8")
      .digest("hex");

    await expect(
      provider.verifyAndParseWebhook(
        Buffer.from(body, "utf8"),
        { [MOCK_PAYMENT_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}` },
        occurredAt
      )
    ).rejects.toMatchObject({ code: "WEBHOOK_MALFORMED" });
  });

  it("refuses to run with a secret short enough to guess", () => {
    expect(() => new MockPaymentProvider({ webhookSecret: "too-short" })).toThrow(
      "MOCK_PAYMENT_SECRET_TOO_SHORT"
    );
  });
});

function eventId(body: string): string {
  return (JSON.parse(body) as { id: string }).id;
}
