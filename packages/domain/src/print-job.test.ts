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

  /**
   * The shape the device host now sends when the spooler retired every job but
   * the printer itself was faulted the moment afterwards. The regression it
   * guards: two sheets were paid for, both jobs left the queue, and only one
   * sheet existed to print on.
   *
   * It must not be a success, and it must not be a refund either — some sheets
   * almost certainly did print, so what the customer holds is a question for a
   * person.
   */
  it("routes a printer that faulted after its queue emptied to a person", () => {
    const settlement = settlePrintDeviceResult(
      result({
        state: "FAILED",
        confidence: "UNCONFIRMED",
        failureCode: "OUT_OF_PAPER",
        sheetsProduced: null
      })
    );

    expect(settlement.status).toBe("RECOVERY_REQUIRED");
    expect(settlement.resultConfidence).toBe("UNCONFIRMED");
    // The operator is told what the device said, not a generic device error.
    expect(settlement.failureCode).toBe("OUT_OF_PAPER");
    expect(settlement.refundObligation).toBe(false);
    // The count the host intended to produce must not survive as a fact.
    expect(settlement.sheetsProduced).toBeNull();
  });

  /**
   * A consumable warning is not a fault. The host's veto pattern excludes them
   * on purpose, and this pins the consequence: low toner still completes.
   */
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

  /**
   * The transport contract narrows what a device may say, and it has been
   * loosened before to let an honest device be heard. These hold over every
   * result the reducer could ever be handed, including shapes the contract
   * currently refuses, so relaxing that contract again cannot quietly create a
   * refund nobody proved was owed or a row the database will not store.
   */
  it("never owes money back without the device confirming nothing came out", () => {
    const states = [
      "NOT_SUBMITTED",
      "SUBMITTED",
      "PRINTING",
      "COMPLETED",
      "FAILED",
      "CANCELED",
      "UNKNOWN"
    ] as const;
    const confidences = ["CONFIRMED", "UNCONFIRMED"] as const;
    const sheetCounts = [null, 0, 1, 5];
    const failureCodes = [null, "PAPER_JAM", "DEVICE_ERROR"];

    for (const state of states) {
      for (const confidence of confidences) {
        for (const sheetsProduced of sheetCounts) {
          for (const failureCode of failureCodes) {
            const where = `${state}/${confidence}/${String(sheetsProduced)}/${String(failureCode)}`;
            const settlement = settlePrintDeviceResult(
              result({ state, confidence, failureCode, sheetsProduced })
            );

            if (settlement.refundObligation) {
              expect(settlement.resultConfidence, where).toBe("CONFIRMED");
              expect(settlement.sheetsProduced, where).toBe(0);
              expect(["FAILED", "CANCELED"], where).toContain(settlement.status);
            }

            // The same shapes `print_jobs_outcome_consistency_check` allows, so
            // a device can never turn a settlement into a constraint violation.
            expect(storableOutcome(settlement), where).toBe(true);
          }
        }
      }
    }
  });
});

function storableOutcome(settlement: ReturnType<typeof settlePrintDeviceResult>): boolean {
  if (settlement.status === "COMPLETED") {
    return (
      settlement.resultConfidence === "CONFIRMED" &&
      settlement.failureCode === null &&
      settlement.sheetsProduced !== null &&
      settlement.sheetsProduced > 0
    );
  }
  if (settlement.status === "FAILED" || settlement.status === "CANCELED") {
    return (
      settlement.resultConfidence === "CONFIRMED" &&
      settlement.failureCode !== null &&
      settlement.sheetsProduced === 0
    );
  }
  return settlement.resultConfidence === "UNCONFIRMED" && settlement.failureCode !== null;
}
