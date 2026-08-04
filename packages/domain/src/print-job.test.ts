import { describe, expect, it } from "vitest";

import { settlePrintDeviceResult, type PrintDeviceResult } from "./print-job.js";

function result(overrides: Partial<PrintDeviceResult>): PrintDeviceResult {
  return {
    state: "COMPLETED",
    confidence: "CONFIRMED",
    failureCode: null,
    warningCode: null,
    sheetsProduced: 4,
    ...overrides
  };
}

describe("settlePrintDeviceResult", () => {
  it("treats a confirmed completion as the only success", () => {
    expect(settlePrintDeviceResult(result({}))).toEqual({
      status: "COMPLETED",
      resultConfidence: "CONFIRMED",
      failureCode: null,
      warningCode: null,
      sheetsProduced: 4,
      sessionState: "COMPLETED",
      refundObligation: false
    });
  });

  it("keeps a warning on an otherwise successful job", () => {
    const settlement = settlePrintDeviceResult(result({ warningCode: "TONER_LOW" }));

    expect(settlement.status).toBe("COMPLETED");
    expect(settlement.warningCode).toBe("TONER_LOW");
  });

  it("refuses to call an unconfirmed completion a success", () => {
    const settlement = settlePrintDeviceResult(result({ confidence: "UNCONFIRMED" }));

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.sessionState).toBe("RECOVERY_REQUIRED");
    // Paper may be in the customer's hand. Recording a refund here would be as
    // wrong as ignoring a real one.
    expect(settlement.refundObligation).toBe(false);
  });

  it("refuses to call a zero-sheet completion a success", () => {
    const settlement = settlePrintDeviceResult(result({ sheetsProduced: 0 }));

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.refundObligation).toBe(false);
  });

  it("owes money back when the device proves nothing was submitted", () => {
    const settlement = settlePrintDeviceResult(
      result({ state: "NOT_SUBMITTED", sheetsProduced: 0, failureCode: null })
    );

    expect(settlement).toMatchObject({
      status: "FAILED",
      resultConfidence: "CONFIRMED",
      failureCode: "PRINTER_UNAVAILABLE",
      sessionState: "FAILED",
      refundObligation: true
    });
  });

  it("does not refund a contradictory not-submitted result", () => {
    const settlement = settlePrintDeviceResult(
      result({ state: "NOT_SUBMITTED", confidence: "UNCONFIRMED", sheetsProduced: null })
    );

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.refundObligation).toBe(false);
  });

  it("owes money back for a failure that produced no sheets", () => {
    const settlement = settlePrintDeviceResult(
      result({
        state: "FAILED",
        confidence: "CONFIRMED",
        failureCode: "OUT_OF_PAPER",
        sheetsProduced: 0
      })
    );

    expect(settlement).toMatchObject({
      status: "FAILED",
      resultConfidence: "CONFIRMED",
      failureCode: "OUT_OF_PAPER",
      refundObligation: true
    });
  });

  it("does not refund an unconfirmed zero-sheet failure", () => {
    const settlement = settlePrintDeviceResult(
      result({
        state: "FAILED",
        confidence: "UNCONFIRMED",
        failureCode: "DEVICE_ERROR",
        sheetsProduced: 0
      })
    );

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.refundObligation).toBe(false);
  });

  it("escalates a partial failure to recovery instead of refunding it", () => {
    const settlement = settlePrintDeviceResult(
      result({
        state: "FAILED",
        confidence: "UNCONFIRMED",
        failureCode: "PAPER_JAM",
        sheetsProduced: 2
      })
    );

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.refundObligation).toBe(false);
    expect(settlement.sheetsProduced).toBe(2);
  });

  it("escalates a failure whose sheet count is unknown", () => {
    const settlement = settlePrintDeviceResult(
      result({ state: "FAILED", confidence: "UNCONFIRMED", sheetsProduced: null })
    );

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.refundObligation).toBe(false);
  });

  it("separates a cancellation the device is sure about from one it is not", () => {
    const beforeSubmit = settlePrintDeviceResult(
      result({ state: "CANCELED", confidence: "CONFIRMED", sheetsProduced: 0 })
    );
    expect(beforeSubmit).toMatchObject({
      status: "CANCELED",
      sessionState: "FAILED",
      failureCode: "CANCELED_BEFORE_SUBMIT",
      refundObligation: true
    });

    const atDevice = settlePrintDeviceResult(
      result({ state: "CANCELED", confidence: "UNCONFIRMED", sheetsProduced: null })
    );
    expect(atDevice).toMatchObject({
      status: "RECOVERY_REQUIRED",
      failureCode: "CANCELED_AT_DEVICE",
      refundObligation: false
    });
  });

  it("does not refund a cancellation that reports produced sheets", () => {
    const settlement = settlePrintDeviceResult(
      result({ state: "CANCELED", confidence: "CONFIRMED", sheetsProduced: 1 })
    );

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.refundObligation).toBe(false);
    expect(settlement.sheetsProduced).toBe(1);
  });

  it("never resolves an open or unknown state into an outcome", () => {
    for (const state of ["SUBMITTED", "PRINTING", "UNKNOWN"] as const) {
      const settlement = settlePrintDeviceResult(
        result({ state, confidence: "UNCONFIRMED", sheetsProduced: null })
      );
      expect(settlement.status).toBe("RECOVERY_REQUIRED");
      expect(settlement.refundObligation).toBe(false);
    }
  });

  it("preserves the device's own reason when it gave one", () => {
    const settlement = settlePrintDeviceResult(
      result({
        state: "FAILED",
        confidence: "CONFIRMED",
        failureCode: "PRINTER_OFFLINE",
        sheetsProduced: 0
      })
    );

    expect(settlement.failureCode).toBe("PRINTER_OFFLINE");
  });
});
