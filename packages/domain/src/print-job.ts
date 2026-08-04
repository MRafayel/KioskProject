/**
 * What a device result means for the job, the session, and the money.
 *
 * This module is pure: no clock, no randomness, no database. Both the API's
 * cancel path and the worker's result and deadline paths reduce through it, so
 * they cannot disagree about when a print is a success, when it is a definite
 * failure that owes money back, and when nobody may claim to know.
 *
 * The rule that shapes everything here is that acceptance by a queue is not
 * proof that paper left the printer. A result is only a success when the device
 * confirmed it; anything a device could not confirm becomes a state a person
 * settles, never one this code guesses at.
 */

export type PrintDeviceState =
  "NOT_SUBMITTED" | "SUBMITTED" | "PRINTING" | "COMPLETED" | "FAILED" | "CANCELED" | "UNKNOWN";

export type PrintConfidence = "CONFIRMED" | "UNCONFIRMED";

export type PrintJobSettledStatus = "COMPLETED" | "FAILED" | "CANCELED" | "RECOVERY_REQUIRED";

export type SettledSessionState = "COMPLETED" | "FAILED" | "RECOVERY_REQUIRED";

export interface PrintDeviceResult {
  state: PrintDeviceState;
  confidence: PrintConfidence;
  failureCode: string | null;
  warningCode: string | null;
  sheetsProduced: number | null;
}

export interface PrintJobSettlement {
  status: PrintJobSettledStatus;
  resultConfidence: PrintConfidence;
  failureCode: string | null;
  warningCode: string | null;
  sheetsProduced: number | null;
  sessionState: SettledSessionState;
  /**
   * True only when the device proved that nothing usable came out. A capture
   * that bought nothing is money owed back; an ambiguous result is not, because
   * paper may well be in the customer's hand and only an operator can say.
   */
  refundObligation: boolean;
}

/** The reason recorded when a device result carries none of its own. */
const DEFAULT_FAILURE_CODE = "DEVICE_ERROR";

export function settlePrintDeviceResult(result: PrintDeviceResult): PrintJobSettlement {
  const warningCode = result.warningCode;

  if (result.state === "COMPLETED") {
    if (
      result.confidence === "CONFIRMED" &&
      result.sheetsProduced !== null &&
      result.sheetsProduced > 0
    ) {
      return {
        status: "COMPLETED",
        resultConfidence: "CONFIRMED",
        failureCode: null,
        warningCode,
        sheetsProduced: result.sheetsProduced,
        sessionState: "COMPLETED",
        refundObligation: false
      };
    }
    // The output was written but nobody watched the tray. Calling this a
    // success would let a lost acknowledgement become a silent non-delivery.
    return recovery(result, "SUBMISSION_UNCONFIRMED", warningCode);
  }

  if (result.state === "NOT_SUBMITTED") {
    // The device is certain it never saw the work, so nothing was printed.
    if (result.confidence === "CONFIRMED" && result.sheetsProduced === 0) {
      return definiteFailure("FAILED", result, "PRINTER_UNAVAILABLE", warningCode, 0);
    }
    return recovery(result, "SUBMISSION_UNCONFIRMED", warningCode);
  }

  if (result.state === "FAILED") {
    const produced = result.sheetsProduced;
    if (result.confidence === "CONFIRMED" && produced === 0) {
      return definiteFailure("FAILED", result, DEFAULT_FAILURE_CODE, warningCode, 0);
    }
    // Some paper may already carry ink. Whether the customer got anything
    // usable is a question for a person, not for a status column.
    return recovery(result, DEFAULT_FAILURE_CODE, warningCode);
  }

  if (result.state === "CANCELED") {
    if (result.confidence === "CONFIRMED" && result.sheetsProduced === 0) {
      return definiteFailure("CANCELED", result, "CANCELED_BEFORE_SUBMIT", warningCode, 0);
    }
    return recovery(result, "CANCELED_AT_DEVICE", warningCode);
  }

  // SUBMITTED, PRINTING and UNKNOWN all describe work whose fate is open. A
  // result report is the end of the road, so an open state here is ambiguity.
  return recovery(
    result,
    result.state === "UNKNOWN" ? "DEVICE_TIMEOUT" : "SUBMISSION_UNCONFIRMED",
    warningCode
  );
}

function definiteFailure(
  status: "FAILED" | "CANCELED",
  result: PrintDeviceResult,
  fallbackCode: string,
  warningCode: string | null,
  sheetsProduced: number
): PrintJobSettlement {
  return {
    status,
    resultConfidence: "CONFIRMED",
    failureCode: result.failureCode ?? fallbackCode,
    warningCode,
    sheetsProduced,
    sessionState: "FAILED",
    refundObligation: true
  };
}

function recovery(
  result: PrintDeviceResult,
  fallbackCode: string,
  warningCode: string | null
): PrintJobSettlement {
  return {
    status: "RECOVERY_REQUIRED",
    resultConfidence: "UNCONFIRMED",
    failureCode: result.failureCode ?? fallbackCode,
    warningCode,
    sheetsProduced: result.sheetsProduced,
    sessionState: "RECOVERY_REQUIRED",
    refundObligation: false
  };
}
