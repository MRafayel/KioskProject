import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrinterAdapterError, type PrintJobManifest, type PrintSubmission } from "../types.js";
import { MockPrinterAdapter, type MockPrinterScenario } from "./adapter.js";

const operationId = "01900000-0000-7000-8000-0000000000a1";
const documentId = "01900000-0000-7000-8000-0000000000b1";
const sha256 = "a".repeat(64);

let outputDirectory: string;
let sourceDirectory: string;
let artifactPath: string;

beforeEach(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "mock-printer-out-"));
  sourceDirectory = await mkdtemp(join(tmpdir(), "mock-printer-src-"));
  artifactPath = join(sourceDirectory, "document.pdf");
  await writeFile(artifactPath, "%PDF-1.7\n", "utf8");
});

afterEach(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
  await rm(sourceDirectory, { recursive: true, force: true });
});

function buildManifest(): PrintJobManifest {
  return {
    manifestVersion: 1,
    printJobId: "01900000-0000-7000-8000-0000000000c1",
    sessionId: "01900000-0000-7000-8000-0000000000d1",
    settingsRevision: 1,
    settingsManifestHash: "b".repeat(64),
    quoteId: "01900000-0000-7000-8000-0000000000e1",
    paymentId: "01900000-0000-7000-8000-0000000000f1",
    copies: 1,
    duplex: "SIMPLEX",
    paperSize: "A4",
    orientation: "PORTRAIT",
    scaling: "FIT",
    collate: true,
    colorMode: "MONOCHROME",
    selectedPages: 4,
    printedSides: 4,
    physicalSheets: 4,
    documents: [
      {
        documentId,
        position: 0,
        sha256,
        sizeBytes: 9,
        pageCount: 4,
        pageRanges: [[1, 4]],
        selectedPages: 4
      }
    ]
  };
}

function buildSubmission(scenario?: MockPrinterScenario): PrintSubmission {
  return {
    operationId,
    manifest: buildManifest(),
    ...(scenario ? { deviceScenario: scenario } : {}),
    artifacts: [{ documentId, position: 0, path: artifactPath, sha256, sizeBytes: 9 }]
  };
}

describe("MockPrinterAdapter", () => {
  it("completes a successful job with confirmed confidence and writes its output", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const status = await adapter.submit(buildSubmission("SUCCESS"));

    expect(status).toMatchObject({
      state: "COMPLETED",
      confidence: "CONFIRMED",
      failureCode: null,
      warningCode: null,
      sheetsProduced: 4
    });
    const written = await readdir(resolve(outputDirectory, operationId));
    expect(written.sort()).toEqual(["document-000.pdf", "manifest.json", "operation.json"]);
  });

  it("reports a warning alongside a completed job", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const status = await adapter.submit(buildSubmission("WARNING"));

    expect(status.state).toBe("COMPLETED");
    expect(status.warningCode).toBe("TONER_LOW");
  });

  it("refuses an offline device before any evidence exists", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    await expect(adapter.submit(buildSubmission("OFFLINE"))).rejects.toMatchObject({
      code: "PRINTER_OFFLINE",
      submissionAmbiguous: false
    });
    // Nothing reached the device, so a caller may safely call this a definite
    // failure rather than an ambiguous one.
    const status = await adapter.getOperationStatus(operationId);
    expect(status.state).toBe("NOT_SUBMITTED");
    expect(status.confidence).toBe("CONFIRMED");
  });

  it("reports out of paper as a confirmed failure that produced nothing", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const status = await adapter.submit(buildSubmission("OUT_OF_PAPER"));

    expect(status).toMatchObject({
      state: "FAILED",
      confidence: "CONFIRMED",
      failureCode: "OUT_OF_PAPER",
      sheetsProduced: 0
    });
  });

  it("reports a jam as a partial, unconfirmed failure", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const status = await adapter.submit(buildSubmission("PAPER_JAM"));

    expect(status).toMatchObject({
      state: "FAILED",
      confidence: "UNCONFIRMED",
      failureCode: "PAPER_JAM",
      sheetsProduced: 2
    });
  });

  it("reports a device cancellation without claiming that nothing printed", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const status = await adapter.submit(buildSubmission("CANCELED"));

    expect(status.state).toBe("CANCELED");
    expect(status.confidence).toBe("UNCONFIRMED");
  });

  it("reports a timeout as unknown rather than as a failure", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const status = await adapter.submit(buildSubmission("TIMEOUT"));

    expect(status).toMatchObject({
      state: "UNKNOWN",
      confidence: "UNCONFIRMED",
      failureCode: "DEVICE_TIMEOUT",
      sheetsProduced: null
    });
  });

  it("raises an ambiguous submission when the acknowledgement is lost", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    await expect(adapter.submit(buildSubmission("UNKNOWN_AFTER_SUBMIT"))).rejects.toMatchObject({
      code: "SUBMISSION_UNCONFIRMED",
      submissionAmbiguous: true
    });

    // The output exists, so asking the device afterwards proves it ran — but
    // not that paper emerged. This is exactly what a blind retry would turn
    // into two printed jobs.
    const status = await adapter.getOperationStatus(operationId);
    expect(status.state).toBe("COMPLETED");
    expect(status.confidence).toBe("UNCONFIRMED");
  });

  it("reports an interrupted operation as unknown from its submission evidence", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });
    await adapter.submit(buildSubmission("OUT_OF_PAPER"));

    const status = await adapter.getOperationStatus(operationId);

    expect(status.state).toBe("UNKNOWN");
    expect(status.failureCode).toBe("SUBMISSION_UNCONFIRMED");
  });

  it("cancels a never-submitted operation with certainty and a printed one without", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const untouched = await adapter.cancel(operationId);
    expect(untouched).toMatchObject({
      state: "CANCELED",
      confidence: "CONFIRMED",
      failureCode: "CANCELED_BEFORE_SUBMIT"
    });

    await adapter.submit(buildSubmission("PAPER_JAM"));
    const late = await adapter.cancel(operationId);
    expect(late).toMatchObject({ state: "CANCELED", confidence: "UNCONFIRMED" });
  });

  it("refuses an operation identifier that is not a plain identifier", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });

    for (const candidate of ["../escape", "..", "a/b", `${operationId}/../..`, ""]) {
      await expect(adapter.getOperationStatus(candidate)).rejects.toBeInstanceOf(
        PrinterAdapterError
      );
    }
    const entries = await readdir(outputDirectory);
    expect(entries).toEqual([]);
  });

  it("refuses a submission whose artifacts do not match its manifest", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory });
    const submission = buildSubmission("SUCCESS");

    await expect(adapter.submit({ ...submission, artifacts: [] })).rejects.toMatchObject({
      code: "MANIFEST_INVALID"
    });
    await expect(
      adapter.submit({
        ...submission,
        artifacts: [{ ...submission.artifacts[0]!, path: "relative/document.pdf" }]
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
    await expect(
      adapter.submit({
        ...submission,
        artifacts: [{ ...submission.artifacts[0]!, sha256: "f".repeat(64) }]
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
    await expect(
      adapter.submit({
        ...submission,
        artifacts: [
          {
            ...submission.artifacts[0]!,
            documentId: "01900000-0000-7000-8000-0000000000ff"
          }
        ]
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
  });

  it("ignores an unrecognised scenario name instead of failing the print", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory, defaultScenario: "SUCCESS" });

    const status = await adapter.submit({
      ...buildSubmission(),
      deviceScenario: "DROP_EVERYTHING"
    });

    expect(status.state).toBe("COMPLETED");
  });

  it("reports health from the configured behaviour", async () => {
    expect(await new MockPrinterAdapter({ outputDirectory }).getHealth()).toEqual({
      state: "READY",
      warningCode: null
    });
    expect(
      await new MockPrinterAdapter({ outputDirectory, defaultScenario: "OFFLINE" }).getHealth()
    ).toEqual({ state: "OFFLINE", warningCode: null });
  });

  it("describes only the monochrome A4 output this product sells", async () => {
    const capabilities = await new MockPrinterAdapter({ outputDirectory }).getCapabilities();

    expect(capabilities.colorModes).toEqual(["MONOCHROME"]);
    expect(capabilities.paperSizes).toEqual(["A4"]);
  });
});
