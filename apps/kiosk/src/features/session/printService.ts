import {
  cancelPrintJobResponseSchema,
  createPrintJobResponseSchema,
  getPrintJobResponseSchema,
  type PrintJobSnapshot,
  type SimulatedPrintOutcome
} from "@printing-kiosk/contracts";

import { clearStoredKeys, stableKey } from "./idempotencyKeys.js";

const PRINT_KEY_PREFIX = "printing-kiosk.pending-print.";
const PRINT_CANCEL_KEY_PREFIX = "printing-kiosk.pending-print-cancel.";

export class PrintRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
    this.name = "PrintRequestError";
  }
}

/**
 * Whether retrying can plausibly recover without operator intervention.
 *
 * Network failures do not reveal whether the request reached the control
 * plane. HTTP 408, 425, 429 and 5xx explicitly describe temporary service
 * conditions. Other 4xx responses are deterministic refusals: replaying the
 * same paid request and credentials cannot repair them.
 */
export function isRetryablePrintFailure(error: unknown): boolean {
  if (!(error instanceof PrintRequestError)) return true;
  return (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status >= 500 && error.status <= 599)
  );
}

/**
 * Ask the control plane to print what a capture already paid for.
 *
 * The request names the payment and nothing else. This screen cannot describe
 * what to print: the job is built from the settings revision that capture was
 * bound to, and a session prints once, so a repeated request returns the job
 * that already exists rather than starting a second one.
 */
export async function startKioskPrintJob(
  sessionId: string,
  paymentId: string,
  simulatedOutcome?: SimulatedPrintOutcome
): Promise<PrintJobSnapshot> {
  const idempotencyKey = stableKey(`${PRINT_KEY_PREFIX}${sessionId}`, paymentId);
  const send = (body: Record<string, unknown>) =>
    fetch(`/agent/v1/sessions/${encodeURIComponent(sessionId)}/print-jobs`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      cache: "no-store",
      body: JSON.stringify(body)
    });

  let response = await send(simulatedOutcome ? { paymentId, simulatedOutcome } : { paymentId });
  // A deployment that has not enabled the deterministic device scenarios
  // refuses the field outright. That is a configuration answer, not a print
  // failure, so the job is simply started without it.
  if (simulatedOutcome && response.status === 400) {
    response = await send({ paymentId });
  }

  if (!response.ok) throw await printError(response, "PRINT_START_FAILED");
  return createPrintJobResponseSchema.parse(await response.json()).printJob;
}

export async function readKioskPrintJob(printJobId: string): Promise<PrintJobSnapshot> {
  const response = await fetch(`/agent/v1/print-jobs/${encodeURIComponent(printJobId)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) throw await printError(response, "PRINT_READ_FAILED");
  return getPrintJobResponseSchema.parse(await response.json()).printJob;
}

export async function cancelKioskPrintJob(printJobId: string): Promise<PrintJobSnapshot> {
  const idempotencyKey = stableKey(`${PRINT_CANCEL_KEY_PREFIX}${printJobId}`, "cancel");
  const response = await fetch(`/agent/v1/print-jobs/${encodeURIComponent(printJobId)}/cancel`, {
    method: "POST",
    headers: { accept: "application/json", "idempotency-key": idempotencyKey },
    cache: "no-store"
  });

  if (!response.ok) throw await printError(response, "PRINT_CANCEL_FAILED");
  return cancelPrintJobResponseSchema.parse(await response.json()).printJob;
}

export function isPrintJobSettled(printJob: PrintJobSnapshot): boolean {
  return (
    printJob.status === "COMPLETED" ||
    printJob.status === "FAILED" ||
    printJob.status === "CANCELED" ||
    printJob.status === "RECOVERY_REQUIRED"
  );
}

/** Only a confirmed completion is a success. Nothing else is rounded up. */
export function isPrintJobSuccessful(printJob: PrintJobSnapshot): boolean {
  return printJob.status === "COMPLETED" && printJob.resultConfidence === "CONFIRMED";
}

/**
 * Whether the device could not say what happened. The screen must ask for an
 * operator rather than telling the customer their documents are or are not
 * printed.
 */
export function isPrintRecoveryRequired(printJob: PrintJobSnapshot): boolean {
  return printJob.status === "RECOVERY_REQUIRED";
}

export function clearStoredPrintKeys(sessionId: string): void {
  clearStoredKeys([`${PRINT_KEY_PREFIX}${sessionId}`, PRINT_CANCEL_KEY_PREFIX]);
}

async function printError(response: Response, fallbackCode: string): Promise<PrintRequestError> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return new PrintRequestError(body.error?.code ?? fallbackCode, response.status);
  } catch {
    return new PrintRequestError(fallbackCode, response.status);
  }
}
