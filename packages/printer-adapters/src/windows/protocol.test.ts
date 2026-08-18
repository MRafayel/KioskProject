import { describe, expect, it } from "vitest";

import { PrinterAdapterError } from "../types.js";
import { readDiagnostics, readHostBinding, readHostResult, readOperationReport } from "./protocol.js";

describe("device diagnostics from an untrusted host", () => {
  it("carries the evidence an outcome was decided from", () => {
    const report = readOperationReport({
      state: "COMPLETED",
      confidence: "CONFIRMED",
      sheetsProduced: 2,
      diagnostics: {
        queue: "Kiosk A4",
        pollCount: 3,
        processStartMs: 812,
        phaseMs: { queueResolved: 40, rendered: 900, "document.0.endDoc": 1500 },
        jobs: [
          {
            position: 0,
            jobId: 20,
            present: false,
            observed: true,
            completed: true,
            faulted: false,
            status: "",
            pagesPrinted: 0,
            expectedPages: 2,
            expectedSheets: 2
          }
        ]
      }
    });

    expect(report.diagnostics).toMatchObject({
      queueName: "Kiosk A4",
      pollCount: 3,
      processStartMs: 812
    });
    expect(report.diagnostics?.phaseMs).toEqual({
      queueResolved: 40,
      rendered: 900,
      "document.0.endDoc": 1500
    });
    // The spooler's own identifier is what maps an outcome to the Windows
    // queue, and it never used to leave the machine.
    expect(report.diagnostics?.jobs?.[0]).toMatchObject({ jobId: 20, observed: true });
  });

  it("does not let a report without diagnostics become an error", () => {
    // An older host, or any operation that has nothing to say.
    const report = readOperationReport({ state: "COMPLETED", confidence: "CONFIRMED" });
    expect(report.state).toBe("COMPLETED");
    expect(report.diagnostics).toBeNull();
  });

  it("caps what a host can push into the control plane", () => {
    const diagnostics = readDiagnostics({
      queue: "q".repeat(5_000),
      phaseMs: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`p${index}`, index])),
      jobs: Array.from({ length: 100 }, () => ({ position: 0, jobId: 1 }))
    });

    expect(diagnostics?.queueName?.length).toBeLessThanOrEqual(400);
    expect(Object.keys(diagnostics?.phaseMs ?? {}).length).toBeLessThanOrEqual(40);
    expect(diagnostics?.jobs?.length).toBeLessThanOrEqual(16);
  });

  it("drops values a host reported in a shape nobody can use", () => {
    const diagnostics = readDiagnostics({
      queue: 17,
      pollCount: -4,
      processStartMs: 1.5,
      phaseMs: { good: 10, negative: -1, fractional: 2.5, text: "soon" },
      jobs: [{ position: 0, jobId: "twenty", status: 42, pagesPrinted: null }]
    });

    expect(diagnostics?.queueName).toBeNull();
    expect(diagnostics?.pollCount).toBeNull();
    expect(diagnostics?.processStartMs).toBeNull();
    expect(diagnostics?.phaseMs).toEqual({ good: 10 });
    // A field that could not be read becomes a harmless zero or null, never a
    // string the control plane would go on to store as a number.
    expect(diagnostics?.jobs?.[0]).toMatchObject({ jobId: 0, status: null, pagesPrinted: 0 });
  });

  it("ignores diagnostics that are not an object at all", () => {
    expect(readDiagnostics(null)).toBeNull();
    expect(readDiagnostics("everything is fine")).toBeNull();
    expect(readDiagnostics([1, 2, 3])).toBeNull();
  });
});

describe("device refusals", () => {
  it("keeps the stage a refusal named", () => {
    // A bare DEVICE_ERROR cannot tell an operator whether the queue was busy or
    // the document would not render.
    expect(() =>
      readHostResult({
        ok: false,
        error: { code: "DEVICE_ERROR", ambiguous: false, stage: "submit.document.0.render" }
      })
    ).toThrow(
      expect.objectContaining({
        code: "DEVICE_ERROR",
        submissionAmbiguous: false,
        deviceStage: "submit.document.0.render"
      })
    );
  });

  it("still refuses without a stage, and stays ambiguous by default", () => {
    try {
      readHostResult({ ok: false, error: { code: "DEVICE_ERROR" } });
      expect.unreachable("the refusal should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PrinterAdapterError);
      expect((error as PrinterAdapterError).submissionAmbiguous).toBe(true);
      expect((error as PrinterAdapterError).deviceStage).toBeNull();
    }
  });
});

describe("device identity", () => {
  it("keeps the printer and the driver that drives it apart", () => {
    // `Canon Generic Plus UFR II` drives most of a product line. Recording it as
    // the make and model left the certification record unable to name the
    // machine an operator actually certified.
    const binding = readHostBinding({
      deviceId: "USB001",
      makeAndModel: "Canon LBP361/362",
      driverName: "Canon Generic Plus UFR II",
      driverVersion: "844596728823808",
      firmware: null
    });

    expect(binding.makeAndModel).toBe("Canon LBP361/362");
    expect(binding.driverName).toBe("Canon Generic Plus UFR II");
    expect(binding.driverVersion).toBe("844596728823808");
    expect(binding.firmware).toBeNull();
  });

  it("reports an unknown model as unknown rather than as the driver", () => {
    const binding = readHostBinding({
      deviceId: "USB001",
      makeAndModel: null,
      driverName: "Canon Generic Plus UFR II",
      driverVersion: "1.0"
    });

    expect(binding.makeAndModel).toBeNull();
    expect(binding.driverName).toBe("Canon Generic Plus UFR II");
  });
});
