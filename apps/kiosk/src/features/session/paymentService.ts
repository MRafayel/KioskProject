import {
  confirmPaymentResponseSchema,
  createPaymentResponseSchema,
  getPaymentResponseSchema,
  type PaymentSnapshot
} from "@printing-kiosk/contracts";

import { clearStoredKeys, stableKey } from "./idempotencyKeys.js";

const PAYMENT_KEY_PREFIX = "printing-kiosk.pending-payment.";
const CONFIRM_KEY_PREFIX = "printing-kiosk.pending-payment-confirm.";

export class PaymentRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
    this.name = "PaymentRequestError";
  }
}

/** The provider outcome the touchscreen is standing in for. */
export type SimulatedPaymentOutcome = "SUCCEEDED" | "DECLINED";

/**
 * Ask the control plane to take payment for a price it issued.
 *
 * The request names the quote and nothing else. No amount is sent, no card
 * detail is ever handled here, and the answer is the only description of the
 * payment this screen will trust.
 */
export async function startKioskPayment(
  sessionId: string,
  quoteId: string,
  attempt: number
): Promise<PaymentSnapshot> {
  // A new attempt number is what asks for a genuinely new payment after one
  // was declined; repeating the same attempt safely replays the first.
  const idempotencyKey = stableKey(`${PAYMENT_KEY_PREFIX}${sessionId}`, `${quoteId}:${attempt}`);
  const response = await fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}/payments`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    cache: "no-store",
    body: JSON.stringify({ quoteId, provider: "MOCK" })
  });

  if (!response.ok) throw await paymentError(response, "PAYMENT_START_FAILED");
  return createPaymentResponseSchema.parse(await response.json()).payment;
}

export async function confirmKioskPayment(paymentId: string): Promise<PaymentSnapshot> {
  const idempotencyKey = stableKey(`${CONFIRM_KEY_PREFIX}${paymentId}`, "confirm");
  const response = await fetch(`/agent/v1/payments/${encodeURIComponent(paymentId)}/confirm`, {
    method: "POST",
    headers: { accept: "application/json", "idempotency-key": idempotencyKey },
    cache: "no-store"
  });

  if (!response.ok) throw await paymentError(response, "PAYMENT_CONFIRM_FAILED");
  return confirmPaymentResponseSchema.parse(await response.json()).payment;
}

export async function readKioskPayment(paymentId: string): Promise<PaymentSnapshot> {
  const response = await fetch(`/agent/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) throw await paymentError(response, "PAYMENT_READ_FAILED");
  return getPaymentResponseSchema.parse(await response.json()).payment;
}

/**
 * Stand in for the payment terminal this pilot does not have.
 *
 * The agent exposes this only where the deployment enabled the deterministic
 * provider scenarios, so a refusal is expected and never a failure of the
 * payment itself: the control plane, not this screen, decides the outcome.
 */
export async function requestSimulatedOutcome(
  paymentId: string,
  outcome: SimulatedPaymentOutcome
): Promise<void> {
  try {
    await fetch(`/agent/v1/payments/${encodeURIComponent(paymentId)}/simulate`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ outcome })
    });
  } catch {
    // The screen keeps watching the payment either way.
  }
}

export function clearStoredPaymentKeys(sessionId: string): void {
  clearStoredKeys([`${PAYMENT_KEY_PREFIX}${sessionId}`, CONFIRM_KEY_PREFIX]);
}

export function isPaymentSettled(payment: PaymentSnapshot): boolean {
  return payment.status !== "PENDING" && payment.status !== "AUTHORIZED";
}

async function paymentError(
  response: Response,
  fallbackCode: string
): Promise<PaymentRequestError> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return new PaymentRequestError(body.error?.code ?? fallbackCode, response.status);
  } catch {
    return new PaymentRequestError(fallbackCode, response.status);
  }
}
