import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deviceJobName, parseDeviceJobName } from "../operation-journal.js";
import { PrinterAdapterError, type PrintJobManifest, type PrintSubmission } from "../types.js";
import { IppPrinterAdapter } from "./adapter.js";
import {
  decodeIppResponse,
  encodeIppRequest,
  findAttribute,
  integerAttribute,
  IPP_DELIMITER,
  IPP_JOB_STATE,
  IPP_OPERATION,
  IPP_PRINTER_STATE,
  keywordAttribute,
  nameAttribute,
  readIntegerAttribute,
  readStringListAttribute,
  type IppAttribute,
  type IppGroup
} from "./encoding.js";

const operationId = "01900000-0000-7000-8000-0000000000a1";
const firstDocumentId = "01900000-0000-7000-8000-0000000000b1";
const secondDocumentId = "01900000-0000-7000-8000-0000000000b2";
const printerUri = "ipp://printer.local/ipp/print";

let journalDirectory: string;
let sourceDirectory: string;

beforeEach(async () => {
  journalDirectory = await mkdtemp(join(tmpdir(), "ipp-journal-"));
  sourceDirectory = await mkdtemp(join(tmpdir(), "ipp-source-"));
});

afterEach(async () => {
  await rm(journalDirectory, { recursive: true, force: true });
  await rm(sourceDirectory, { recursive: true, force: true });
});

interface FakeJob {
  jobId: number;
  jobName: string;
  state: number;
  reasons: string[];
  sheets: number | null;
  copies: number;
  sides: string;
}

/**
 * A printer that answers IPP.
 *
 * It is deliberately literal: it decodes the bytes the adapter actually sends
 * rather than intercepting method calls, so a change to the wire format fails
 * here instead of on hardware.
 */
class FakeIppDevice {
  public readonly jobs: FakeJob[] = [];
  public printerState: number = IPP_PRINTER_STATE.IDLE;
  public printerReasons: string[] = ["none"];
  public acceptingJobs = true;
  public documentFormats = ["application/pdf", "application/octet-stream"];
  public mediaReady = ["iso_a4_210x297mm"];
  public mediaSupported = ["iso_a4_210x297mm", "na_letter_8.5x11in"];
  public submitStatus: number | null = null;
  public transportFails = false;
  /** How each accepted job resolves. */
  public jobOutcome: { state: number; reasons: string[]; sheets: number | null } = {
    state: IPP_JOB_STATE.COMPLETED,
    reasons: ["job-completed-successfully"],
    sheets: 1
  };
  public readonly operations: number[] = [];
  private nextJobId = 400;

  public readonly fetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (this.transportFails) return Promise.reject(new Error("ECONNREFUSED"));
    const request = decodeIppResponse(new Uint8Array(init?.body as Uint8Array));
    const operation = request.statusCode;
    this.operations.push(operation);
    void input;

    if (operation === IPP_OPERATION.GET_PRINTER_ATTRIBUTES) {
      return this.respond(request.requestId, [
        { tag: IPP_DELIMITER.PRINTER_ATTRIBUTES, attributes: this.printerAttributes() }
      ]);
    }
    if (operation === IPP_OPERATION.PRINT_JOB)
      return this.printJob(request.requestId, request.groups);
    if (operation === IPP_OPERATION.GET_JOBS) {
      return this.respond(
        request.requestId,
        this.jobs.map((job) => ({
          tag: IPP_DELIMITER.JOB_ATTRIBUTES,
          attributes: [
            integerAttribute("job-id", job.jobId),
            nameAttribute("job-name", job.jobName),
            integerAttribute("job-state", job.state),
            ...(job.reasons.length === 0
              ? []
              : [keywordAttribute("job-state-reasons", job.reasons)]),
            ...(job.sheets === null
              ? []
              : [integerAttribute("job-media-sheets-completed", job.sheets)])
          ]
        }))
      );
    }
    if (operation === IPP_OPERATION.CANCEL_JOB) {
      const jobId = readIntegerAttribute(request, IPP_DELIMITER.OPERATION_ATTRIBUTES, "job-id");
      const job = this.jobs.find((entry) => entry.jobId === jobId);
      if (job) {
        job.state = IPP_JOB_STATE.CANCELED;
        job.reasons = ["job-canceled-by-user"];
        job.sheets = job.sheets ?? 0;
      }
      return this.respond(request.requestId, []);
    }
    return this.respond(request.requestId, [], 0x0501);
  };

  private printJob(requestId: number, groups: readonly IppGroup[]): Promise<Response> {
    if (this.submitStatus !== null) return this.respond(requestId, [], this.submitStatus);

    const operationGroup = groups.find((group) => group.tag === IPP_DELIMITER.OPERATION_ATTRIBUTES);
    const jobGroup = groups.find((group) => group.tag === IPP_DELIMITER.JOB_ATTRIBUTES);
    const jobName = String(
      operationGroup?.attributes.find((attribute) => attribute.name === "job-name")?.values[0] ?? ""
    );
    const jobId = this.nextJobId++;
    this.jobs.push({
      jobId,
      jobName,
      state: this.jobOutcome.state,
      reasons: [...this.jobOutcome.reasons],
      sheets: this.jobOutcome.sheets,
      copies: Number(
        jobGroup?.attributes.find((attribute) => attribute.name === "copies")?.values[0] ?? 0
      ),
      sides: String(
        jobGroup?.attributes.find((attribute) => attribute.name === "sides")?.values[0] ?? ""
      )
    });

    return this.respond(requestId, [
      {
        tag: IPP_DELIMITER.JOB_ATTRIBUTES,
        attributes: [
          integerAttribute("job-id", jobId),
          integerAttribute("job-state", IPP_JOB_STATE.PENDING)
        ]
      }
    ]);
  }

  private printerAttributes(): IppAttribute[] {
    return [
      integerAttribute("printer-state", this.printerState),
      ...optionalKeywords("printer-state-reasons", this.printerReasons),
      { name: "printer-is-accepting-jobs", tag: 0x22, values: [this.acceptingJobs] },
      ...optionalKeywords("document-format-supported", this.documentFormats),
      ...optionalKeywords("media-ready", this.mediaReady),
      ...optionalKeywords("media-supported", this.mediaSupported),
      keywordAttribute("sides-supported", ["one-sided", "two-sided-long-edge"]),
      keywordAttribute("print-color-mode-supported", ["monochrome"]),
      integerAttribute("copies-supported", 50),
      nameAttribute("printer-make-and-model", "Kiosk Laser 400"),
      nameAttribute("printer-uuid", "urn:uuid:1f2a"),
      nameAttribute("printer-firmware-string-version", "4.2.1")
    ];
  }

  private respond(requestId: number, groups: IppGroup[], statusCode = 0x0000): Promise<Response> {
    const bytes = encodeIppRequest({
      operation: statusCode,
      requestId,
      groups:
        groups.length > 0 ? groups : [{ tag: IPP_DELIMITER.OPERATION_ATTRIBUTES, attributes: [] }]
    });
    return Promise.resolve(
      new Response(bytes, { status: 200, headers: { "content-type": "application/ipp" } })
    );
  }
}

/** An IPP attribute with no values cannot be encoded, so an empty list is absent. */
function optionalKeywords(name: string, values: readonly string[]): IppAttribute[] {
  return values.length === 0 ? [] : [keywordAttribute(name, [...values])];
}

function buildAdapter(device: FakeIppDevice, overrides: Record<string, unknown> = {}) {
  return new IppPrinterAdapter({
    printerUri,
    queueName: "Kiosk A4",
    journalDirectory,
    maxCopies: 20,
    fetch: device.fetch,
    sleep: () => Promise.resolve(),
    ...overrides
  });
}

async function artifact(name: string, bytes = "%PDF-1.7\n"): Promise<string> {
  const path = join(sourceDirectory, name);
  await writeFile(path, bytes, "utf8");
  return path;
}

function manifest(documents: PrintJobManifest["documents"]): PrintJobManifest {
  const printedSides = documents.reduce((total, document) => total + document.printedSides, 0);
  const physicalSheets = documents.reduce((total, document) => total + document.physicalSheets, 0);
  return {
    manifestVersion: 2,
    printJobId: "01900000-0000-7000-8000-0000000000c1",
    sessionId: "01900000-0000-7000-8000-0000000000d1",
    settingsRevision: 1,
    settingsManifestHash: "b".repeat(64),
    quoteId: "01900000-0000-7000-8000-0000000000e1",
    paymentId: "01900000-0000-7000-8000-0000000000f1",
    paperSize: "A4",
    scaling: "FIT",
    collate: true,
    colorMode: "MONOCHROME",
    selectedPages: documents.reduce((total, document) => total + document.selectedPages, 0),
    printedSides,
    physicalSheets,
    documents
  };
}

async function singleDocumentSubmission(): Promise<PrintSubmission> {
  const path = await artifact("first.pdf");
  return {
    operationId,
    manifest: manifest([
      {
        documentId: firstDocumentId,
        position: 0,
        sha256: "a".repeat(64),
        sizeBytes: 9,
        pageCount: 2,
        pageRanges: [[1, 2]],
        selectedPages: 2,
        copies: 1,
        duplex: "SIMPLEX",
        orientation: "PORTRAIT",
        printedSides: 2,
        physicalSheets: 2
      }
    ]),
    artifacts: [
      { documentId: firstDocumentId, position: 0, path, sha256: "a".repeat(64), sizeBytes: 9 }
    ]
  };
}

describe("IppPrinterAdapter submission", () => {
  it("prints a document and reports the device's own sheet count", async () => {
    const device = new FakeIppDevice();
    device.jobOutcome = {
      state: IPP_JOB_STATE.COMPLETED,
      reasons: ["job-completed-successfully"],
      sheets: 2
    };

    const status = await buildAdapter(device).submit(await singleDocumentSubmission());

    expect(status).toEqual({
      operationId,
      state: "COMPLETED",
      confidence: "CONFIRMED",
      failureCode: null,
      warningCode: null,
      sheetsProduced: 2
    });
    expect(device.jobs[0]?.jobName).toBe(deviceJobName(operationId, 0, 1));
  });

  /**
   * A completion the device counted no sheets for is a queue that stopped
   * complaining, not a delivery. Rounding it up would let a lost job become a
   * silent non-delivery a customer already paid for.
   */
  it("refuses to confirm a completion with no sheet count", async () => {
    const device = new FakeIppDevice();
    device.jobOutcome = { state: IPP_JOB_STATE.COMPLETED, reasons: [], sheets: null };

    const status = await buildAdapter(device).submit(await singleDocumentSubmission());

    expect(status.state).toBe("COMPLETED");
    expect(status.confidence).toBe("UNCONFIRMED");
    expect(status.sheetsProduced).toBeNull();
  });

  it("sends the manifest settings each document was priced with", async () => {
    const device = new FakeIppDevice();
    const documents: PrintJobManifest["documents"] = [
      {
        documentId: firstDocumentId,
        position: 0,
        sha256: "a".repeat(64),
        sizeBytes: 9,
        pageCount: 2,
        pageRanges: [[1, 2]],
        selectedPages: 2,
        copies: 3,
        duplex: "SIMPLEX",
        orientation: "PORTRAIT",
        printedSides: 6,
        physicalSheets: 6
      },
      {
        documentId: secondDocumentId,
        position: 1,
        sha256: "c".repeat(64),
        sizeBytes: 9,
        pageCount: 4,
        pageRanges: [[1, 4]],
        selectedPages: 4,
        copies: 1,
        duplex: "LONG_EDGE",
        orientation: "PORTRAIT",
        printedSides: 4,
        physicalSheets: 2
      }
    ];

    await buildAdapter(device).submit({
      operationId,
      manifest: manifest(documents),
      artifacts: [
        {
          documentId: firstDocumentId,
          position: 0,
          path: await artifact("first.pdf"),
          sha256: "a".repeat(64),
          sizeBytes: 9
        },
        {
          documentId: secondDocumentId,
          position: 1,
          path: await artifact("second.pdf"),
          sha256: "c".repeat(64),
          sizeBytes: 9
        }
      ]
    });

    // Copies and duplex belong to a document in this product and to a job in
    // IPP, so one manifest becomes one device job per document.
    expect(device.jobs.map((job) => [job.copies, job.sides])).toEqual([
      [3, "one-sided"],
      [1, "two-sided-long-edge"]
    ]);
    expect(device.jobs.map((job) => parseDeviceJobName(job.jobName)?.position)).toEqual([0, 1]);
    expect(device.jobs.every((job) => parseDeviceJobName(job.jobName)?.documentCount === 2)).toBe(
      true
    );
  });

  /**
   * Asking is free and submitting is not. A stopped queue must be found before
   * anything is sent, because that is the only point at which a refusal proves
   * nothing was printed.
   */
  it("refuses a stopped queue before anything is sent", async () => {
    const device = new FakeIppDevice();
    device.printerState = IPP_PRINTER_STATE.STOPPED;

    await expect(
      buildAdapter(device).submit(await singleDocumentSubmission())
    ).rejects.toMatchObject({
      code: "PRINTER_OFFLINE",
      submissionAmbiguous: false
    });
    expect(device.jobs).toHaveLength(0);
    expect(await readdir(journalDirectory)).toHaveLength(0);
  });

  it("refuses a queue that is not accepting jobs", async () => {
    const device = new FakeIppDevice();
    device.acceptingJobs = false;

    await expect(
      buildAdapter(device).submit(await singleDocumentSubmission())
    ).rejects.toMatchObject({
      code: "PRINTER_OFFLINE",
      submissionAmbiguous: false
    });
  });

  /**
   * A queue that cannot take PDF would print the file as text. That is a
   * certification failure, and it is caught before submission rather than
   * discovered on paper.
   */
  it("refuses a queue that does not accept PDF", async () => {
    const device = new FakeIppDevice();
    device.documentFormats = ["application/postscript"];

    await expect(
      buildAdapter(device).submit(await singleDocumentSubmission())
    ).rejects.toMatchObject({
      code: "DEVICE_ERROR",
      submissionAmbiguous: false
    });
    expect(device.jobs).toHaveLength(0);
  });

  it("treats a device that stops answering mid-submission as ambiguous", async () => {
    const device = new FakeIppDevice();
    const adapter = buildAdapter(device);
    const submission = await singleDocumentSubmission();
    device.submitStatus = null;
    const originalFetch = device.fetch;
    let call = 0;
    const adapterWithFlakyDevice = buildAdapter(device, {
      fetch: (input: string | URL, init?: RequestInit) => {
        call += 1;
        // The readiness check succeeds; the submission itself goes quiet.
        if (call === 2) return Promise.reject(new Error("ECONNRESET"));
        return originalFetch(input, init);
      }
    });
    void adapter;

    await expect(adapterWithFlakyDevice.submit(submission)).rejects.toMatchObject({
      code: "DEVICE_UNREACHABLE",
      submissionAmbiguous: true
    });
    // The intent was journalled before the device was touched, so the result is
    // resolvable rather than resubmittable.
    expect(await readdir(journalDirectory)).toEqual([`${operationId}.json`]);
  });

  it("reports a device timeout as unknown rather than a failure", async () => {
    const device = new FakeIppDevice();
    device.jobOutcome = {
      state: IPP_JOB_STATE.PROCESSING,
      reasons: ["job-printing"],
      sheets: null
    };
    let clock = 0;

    const status = await buildAdapter(device, {
      completionTimeoutMilliseconds: 5_000,
      now: () => {
        clock += 3_000;
        return new Date(clock);
      }
    }).submit(await singleDocumentSubmission());

    expect(status.state).toBe("UNKNOWN");
    expect(status.confidence).toBe("UNCONFIRMED");
    expect(status.failureCode).toBe("DEVICE_TIMEOUT");
  });

  it("maps a jam to a failure nobody may call confirmed", async () => {
    const device = new FakeIppDevice();
    device.jobOutcome = { state: IPP_JOB_STATE.ABORTED, reasons: ["media-jam"], sheets: 1 };

    const status = await buildAdapter(device).submit(await singleDocumentSubmission());

    expect(status).toMatchObject({
      state: "FAILED",
      confidence: "UNCONFIRMED",
      failureCode: "PAPER_JAM",
      sheetsProduced: 1
    });
  });

  it("confirms a failure the device proved produced nothing", async () => {
    const device = new FakeIppDevice();
    device.jobOutcome = { state: IPP_JOB_STATE.ABORTED, reasons: ["media-empty"], sheets: 0 };

    const status = await buildAdapter(device).submit(await singleDocumentSubmission());

    expect(status).toMatchObject({
      state: "FAILED",
      confidence: "CONFIRMED",
      failureCode: "OUT_OF_PAPER",
      sheetsProduced: 0
    });
  });
});

describe("IppPrinterAdapter resolution after a restart", () => {
  it("reports nothing submitted when this machine never recorded an intent", async () => {
    const status = await buildAdapter(new FakeIppDevice()).getOperationStatus(operationId);

    expect(status).toEqual({
      operationId,
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED",
      failureCode: null,
      warningCode: null,
      sheetsProduced: 0
    });
  });

  /**
   * A spooler restart purges job history, and a purged queue answers a status
   * query exactly the way a queue that never saw the job does. The journal is
   * the only thing that separates them, and reading this as "never submitted"
   * is what would print a paid job a second time.
   */
  it("reports unknown when the journal knows about a job the queue has forgotten", async () => {
    const device = new FakeIppDevice();
    const adapter = buildAdapter(device);
    await adapter.submit(await singleDocumentSubmission());
    device.jobs.length = 0;

    const status = await adapter.getOperationStatus(operationId);

    expect(status.state).toBe("UNKNOWN");
    expect(status.confidence).toBe("UNCONFIRMED");
    expect(status.failureCode).toBe("SUBMISSION_UNCONFIRMED");
  });

  it("resolves a completed operation from the queue's own listing", async () => {
    const device = new FakeIppDevice();
    device.jobs.push(
      {
        jobId: 1,
        jobName: deviceJobName(operationId, 0, 2),
        state: IPP_JOB_STATE.COMPLETED,
        reasons: ["job-completed-successfully"],
        sheets: 2,
        copies: 1,
        sides: "one-sided"
      },
      {
        jobId: 2,
        jobName: deviceJobName(operationId, 1, 2),
        state: IPP_JOB_STATE.COMPLETED,
        reasons: ["job-completed-successfully"],
        sheets: 3,
        copies: 1,
        sides: "one-sided"
      }
    );

    const status = await buildAdapter(device).getOperationStatus(operationId);

    expect(status).toMatchObject({
      state: "COMPLETED",
      confidence: "CONFIRMED",
      sheetsProduced: 5
    });
  });

  /**
   * The document count travels in the job name, so a listing showing fewer jobs
   * than the operation had is a partial submission and is reported as unknown.
   */
  it("reports unknown when the queue accounts for only part of the operation", async () => {
    const device = new FakeIppDevice();
    device.jobs.push({
      jobId: 1,
      jobName: deviceJobName(operationId, 0, 2),
      state: IPP_JOB_STATE.COMPLETED,
      reasons: [],
      sheets: 2,
      copies: 1,
      sides: "one-sided"
    });

    const status = await buildAdapter(device).getOperationStatus(operationId);

    expect(status.state).toBe("UNKNOWN");
  });

  it("ignores jobs belonging to another operation", async () => {
    const device = new FakeIppDevice();
    device.jobs.push({
      jobId: 1,
      jobName: deviceJobName("01900000-0000-7000-8000-0000000000ff", 0, 1),
      state: IPP_JOB_STATE.COMPLETED,
      reasons: [],
      sheets: 2,
      copies: 1,
      sides: "one-sided"
    });

    expect((await buildAdapter(device).getOperationStatus(operationId)).state).toBe(
      "NOT_SUBMITTED"
    );
  });

  it("keeps the ambiguity when the device cannot be reached at all", async () => {
    const device = new FakeIppDevice();
    const adapter = buildAdapter(device);
    await adapter.submit(await singleDocumentSubmission());
    device.transportFails = true;

    expect((await adapter.getOperationStatus(operationId)).state).toBe("UNKNOWN");
  });
});

describe("IppPrinterAdapter cancellation", () => {
  it("confirms nothing was printed when the operation never reached the queue", async () => {
    const status = await buildAdapter(new FakeIppDevice()).cancel(operationId);

    expect(status).toMatchObject({
      state: "CANCELED",
      confidence: "CONFIRMED",
      failureCode: "CANCELED_BEFORE_SUBMIT",
      sheetsProduced: 0
    });
  });

  it("cancels the queued jobs and refuses to claim nothing came out", async () => {
    const device = new FakeIppDevice();
    device.jobs.push({
      jobId: 7,
      jobName: deviceJobName(operationId, 0, 1),
      state: IPP_JOB_STATE.PROCESSING,
      reasons: ["job-printing"],
      sheets: 1,
      copies: 1,
      sides: "one-sided"
    });

    const status = await buildAdapter(device).cancel(operationId);

    expect(device.jobs[0]?.state).toBe(IPP_JOB_STATE.CANCELED);
    expect(status.state).toBe("CANCELED");
    expect(status.confidence).toBe("UNCONFIRMED");
  });

  it("reports a completed operation as completed rather than canceled", async () => {
    const device = new FakeIppDevice();
    device.jobs.push({
      jobId: 7,
      jobName: deviceJobName(operationId, 0, 1),
      state: IPP_JOB_STATE.COMPLETED,
      reasons: ["job-completed-successfully"],
      sheets: 2,
      copies: 1,
      sides: "one-sided"
    });

    expect((await buildAdapter(device).cancel(operationId)).state).toBe("COMPLETED");
  });
});

describe("IppPrinterAdapter device reporting", () => {
  it("maps printer state reasons onto health", async () => {
    const device = new FakeIppDevice();
    const adapter = buildAdapter(device);

    device.printerReasons = ["none"];
    expect(await adapter.getHealth()).toEqual({ state: "READY", warningCode: null });

    device.printerReasons = ["toner-low-warning"];
    expect(await adapter.getHealth()).toEqual({ state: "WARNING", warningCode: "TONER_LOW" });

    device.printerReasons = ["media-empty-error"];
    expect(await adapter.getHealth()).toEqual({ state: "OFFLINE", warningCode: null });

    device.transportFails = true;
    expect(await adapter.getHealth()).toEqual({ state: "OFFLINE", warningCode: null });
  });

  /**
   * What is loaded beats what is possible. A model that supports A4 cannot
   * print it out of a tray holding Letter, and offering it would sell a
   * customer a job the hardware refuses.
   */
  it("prefers the media that is loaded over the media that is supported", async () => {
    const device = new FakeIppDevice();
    device.mediaReady = ["na_letter_8.5x11in"];

    expect((await buildAdapter(device).getCapabilities()).paperSizes).toEqual([]);

    device.mediaReady = ["iso_a4_210x297mm"];
    expect((await buildAdapter(device).getCapabilities()).paperSizes).toEqual(["A4"]);
  });

  it("falls back to supported media when the device reports none as ready", async () => {
    const device = new FakeIppDevice();
    device.mediaReady = [];

    expect((await buildAdapter(device).getCapabilities()).paperSizes).toEqual(["A4"]);
  });

  it("reports the device identity a certification record needs", async () => {
    const binding = await buildAdapter(new FakeIppDevice()).describe();

    expect(binding).toEqual({
      adapter: "IPP",
      driverVersion: null,
      queueName: "Kiosk A4",
      deviceId: "urn:uuid:1f2a",
      makeAndModel: "Kiosk Laser 400",
      driverName: null,
      firmware: "4.2.1"
    });
  });

  it("prunes the local record of operations past their retention window", async () => {
    const device = new FakeIppDevice();
    const adapter = buildAdapter(device);
    await adapter.submit(await singleDocumentSubmission());

    expect(await adapter.discardOutputsBefore(new Date(Date.now() - 60_000))).toBe(0);
    expect(await adapter.discardOutputsBefore(new Date(Date.now() + 60_000))).toBe(1);
    expect(await readdir(journalDirectory)).toHaveLength(0);
  });
});

describe("IppPrinterAdapter transport", () => {
  it("refuses a manifest whose paper size has no device vocabulary", async () => {
    const device = new FakeIppDevice();
    const submission = await singleDocumentSubmission();

    await expect(
      buildAdapter(device).submit({
        ...submission,
        manifest: { ...submission.manifest, paperSize: "A3" }
      })
    ).rejects.toBeInstanceOf(PrinterAdapterError);
  });

  it("asks the device only for the attributes it uses", async () => {
    const device = new FakeIppDevice();
    const requested: string[][] = [];
    await buildAdapter(device, {
      fetch: (input: string | URL, init?: RequestInit) => {
        const request = decodeIppResponse(new Uint8Array(init?.body as Uint8Array));
        if (findAttribute(request, IPP_DELIMITER.OPERATION_ATTRIBUTES, "requested-attributes")) {
          requested.push(
            readStringListAttribute(
              request,
              IPP_DELIMITER.OPERATION_ATTRIBUTES,
              "requested-attributes"
            )
          );
        }
        return device.fetch(input, init);
      }
    }).getHealth();

    expect(requested).toEqual([["printer-state", "printer-state-reasons"]]);
  });
});
