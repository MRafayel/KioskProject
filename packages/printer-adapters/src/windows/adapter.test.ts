import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deviceJobName } from "../operation-journal.js";
import { PrinterAdapterError, type PrintJobManifest, type PrintSubmission } from "../types.js";
import { WindowsPrinterAdapter, type DeviceHostTransport } from "./adapter.js";
import type { DeviceHostRequest } from "./protocol.js";

const operationId = "01900000-0000-7000-8000-0000000000a1";
const firstDocumentId = "01900000-0000-7000-8000-0000000000b1";
const secondDocumentId = "01900000-0000-7000-8000-0000000000b2";

let journalDirectory: string;
let sourceDirectory: string;

beforeEach(async () => {
  journalDirectory = await mkdtemp(join(tmpdir(), "windows-journal-"));
  sourceDirectory = await mkdtemp(join(tmpdir(), "windows-source-"));
});

afterEach(async () => {
  await rm(journalDirectory, { recursive: true, force: true });
  await rm(sourceDirectory, { recursive: true, force: true });
});

/** Stands in for the device host process. It records what it was asked. */
class FakeDeviceHost implements DeviceHostTransport {
  public readonly requests: DeviceHostRequest[] = [];
  public readonly answers = new Map<string, unknown>();
  public failWith: Error | null = null;

  public request(request: DeviceHostRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.failWith) return Promise.reject(this.failWith);
    const answer = this.answers.get(request.op);
    return Promise.resolve(answer ?? { ok: true, result: {} });
  }

  public answer(op: DeviceHostRequest["op"], result: unknown): void {
    this.answers.set(op, { ok: true, result });
  }

  public refuse(op: DeviceHostRequest["op"], error: unknown): void {
    this.answers.set(op, { ok: false, error });
  }
}

function buildAdapter(host: FakeDeviceHost, overrides: Record<string, unknown> = {}) {
  host.answers.set(
    "health",
    host.answers.get("health") ?? { ok: true, result: { state: "READY" } }
  );
  return new WindowsPrinterAdapter({
    transport: host,
    queueName: "Kiosk A4",
    approvedQueues: ["Kiosk A4"],
    journalDirectory,
    maxCopies: 20,
    ...overrides
  });
}

async function artifact(name: string): Promise<string> {
  const path = join(sourceDirectory, name);
  await writeFile(path, "%PDF-1.7\n", "utf8");
  return path;
}

function manifest(documents: PrintJobManifest["documents"]): PrintJobManifest {
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
    printedSides: documents.reduce((total, document) => total + document.printedSides, 0),
    physicalSheets: documents.reduce((total, document) => total + document.physicalSheets, 0),
    documents
  };
}

async function submission(): Promise<PrintSubmission> {
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
        copies: 3,
        duplex: "LONG_EDGE",
        orientation: "PORTRAIT",
        printedSides: 6,
        physicalSheets: 3
      }
    ]),
    artifacts: [
      {
        documentId: firstDocumentId,
        position: 0,
        path: await artifact("first.pdf"),
        sha256: "a".repeat(64),
        sizeBytes: 9
      }
    ]
  };
}

describe("WindowsPrinterAdapter discovery", () => {
  it("reads the machine's queues and refuses to trust what it cannot read", async () => {
    const host = new FakeDeviceHost();
    host.answer("list-queues", [
      {
        queueName: " Kiosk A4 ",
        deviceUri: "wsd://10.0.0.9",
        driverName: "Generic PCL6",
        portName: "IP_10.0.0.9",
        state: "READY",
        isDefault: true,
        shared: false
      },
      { queueName: "Odd Queue", state: "SOMETHING_NEW" },
      { queueName: "   " },
      { notAQueue: true }
    ]);

    const queues = await buildAdapter(host).listQueues();

    expect(queues).toEqual([
      {
        queueName: "Kiosk A4",
        deviceUri: "wsd://10.0.0.9",
        driverName: "Generic PCL6",
        portName: "IP_10.0.0.9",
        state: "READY",
        isDefault: true,
        shared: false
      },
      {
        queueName: "Odd Queue",
        deviceUri: null,
        driverName: null,
        portName: null,
        // A state this side does not recognise is not a ready printer, and a
        // queue that did not say whether it is shared is treated as shared.
        state: "ERROR",
        isDefault: false,
        shared: true
      }
    ]);
  });

  it("maps the driver's own capability vocabulary", async () => {
    const host = new FakeDeviceHost();
    host.answer("capabilities", {
      mediaSizes: ["A4", "Letter"],
      sides: ["OneSided", "TwoSidedLongEdge"],
      colorModes: ["Monochrome"],
      maxCopies: 99
    });

    expect(await buildAdapter(host).getCapabilities()).toMatchObject({
      paperSizes: ["A4"],
      duplexModes: ["SIMPLEX", "LONG_EDGE"],
      colorModes: ["MONOCHROME"],
      maxCopies: 20
    });
  });

  it("reports a host that cannot answer as an offline printer", async () => {
    const host = new FakeDeviceHost();
    host.failWith = new Error("DEVICE_HOST_UNAVAILABLE");

    expect(await buildAdapter(host).getHealth()).toEqual({ state: "OFFLINE", warningCode: null });
  });

  it("treats a health state it does not recognise as offline", async () => {
    const host = new FakeDeviceHost();
    host.answer("health", { state: "PAUSED" });

    expect(await buildAdapter(host).getHealth()).toEqual({ state: "OFFLINE", warningCode: null });
  });
});

describe("WindowsPrinterAdapter submission", () => {
  it("hands the host the settings each document was priced with", async () => {
    const host = new FakeDeviceHost();
    host.answer("submit", { state: "COMPLETED", confidence: "CONFIRMED", sheetsProduced: 3 });

    const status = await buildAdapter(host).submit(await submission());

    expect(status).toMatchObject({
      state: "COMPLETED",
      confidence: "CONFIRMED",
      sheetsProduced: 3
    });
    const submitRequest = host.requests.find((request) => request.op === "submit");
    expect(submitRequest).toMatchObject({
      queue: "Kiosk A4",
      operationId,
      media: "iso_a4_210x297mm",
      colorMode: "monochrome",
      documents: [
        {
          position: 0,
          copies: 3,
          sides: "two-sided-long-edge",
          jobName: deviceJobName(operationId, 0, 1)
        }
      ]
    });
  });

  /**
   * Approval is operator policy, and it is enforced on this side. A host that
   * offered a printer nobody certified must not be taken up on it, and the
   * check is per call rather than at construction so a reloaded configuration
   * cannot drop it.
   */
  it("refuses a queue nobody certified", async () => {
    const host = new FakeDeviceHost();
    const adapter = buildAdapter(host, { approvedQueues: ["Some Other Printer"] });

    await expect(adapter.submit(await submission())).rejects.toMatchObject({
      code: "QUEUE_NOT_APPROVED"
    });
    expect(host.requests).toHaveLength(0);
  });

  it("refuses an offline printer before anything is sent", async () => {
    const host = new FakeDeviceHost();
    host.answer("health", { state: "OFFLINE" });

    await expect(buildAdapter(host).submit(await submission())).rejects.toMatchObject({
      code: "PRINTER_OFFLINE",
      submissionAmbiguous: false
    });
    expect(host.requests.some((request) => request.op === "submit")).toBe(false);
    expect(await readdir(journalDirectory)).toHaveLength(0);
  });

  it("records the intent before the host is asked to print", async () => {
    const host = new FakeDeviceHost();
    host.failWith = null;
    host.answers.set("submit", undefined);
    const adapter = buildAdapter(host);
    const order: string[] = [];
    const originalRequest = host.request.bind(host);
    host.request = async (request: DeviceHostRequest) => {
      if (request.op === "submit") order.push(...(await readdir(journalDirectory)));
      return originalRequest(request);
    };
    host.answer("submit", { state: "COMPLETED", confidence: "CONFIRMED", sheetsProduced: 3 });

    await adapter.submit(await submission());

    expect(order).toEqual([`${operationId}.json`]);
  });

  /**
   * A Windows spooler considers a job finished when it leaves the queue, which
   * is not the same as paper. A host repeating that as a confirmed success must
   * not be believed past what its own numbers support.
   */
  it("downgrades a confirmation the host's own numbers do not support", async () => {
    const host = new FakeDeviceHost();
    host.answer("submit", { state: "COMPLETED", confidence: "CONFIRMED", sheetsProduced: null });

    const status = await buildAdapter(host).submit(await submission());

    expect(status.confidence).toBe("UNCONFIRMED");
  });

  it("keeps a confirmed failure that proved no sheet was produced", async () => {
    const host = new FakeDeviceHost();
    host.answer("submit", {
      state: "FAILED",
      confidence: "CONFIRMED",
      failureCode: "OUT_OF_PAPER",
      sheetsProduced: 0
    });

    expect(await buildAdapter(host).submit(await submission())).toMatchObject({
      state: "FAILED",
      confidence: "CONFIRMED",
      failureCode: "OUT_OF_PAPER"
    });
  });

  it("treats a host that goes away mid-submission as ambiguous", async () => {
    const host = new FakeDeviceHost();
    const adapter = buildAdapter(host);
    const prepared = await submission();
    host.request = (request: DeviceHostRequest) => {
      if (request.op === "health") return Promise.resolve({ ok: true, result: { state: "READY" } });
      return Promise.reject(new Error("DEVICE_HOST_TIMEOUT"));
    };

    await expect(adapter.submit(prepared)).rejects.toMatchObject({
      code: "DEVICE_UNREACHABLE",
      submissionAmbiguous: true
    });
  });

  it("takes a refusal that does not say as ambiguous", async () => {
    const host = new FakeDeviceHost();
    host.refuse("submit", { code: "DEVICE_ERROR" });

    await expect(buildAdapter(host).submit(await submission())).rejects.toMatchObject({
      code: "DEVICE_ERROR",
      submissionAmbiguous: true
    });
  });

  it("refuses a manifest whose documents and artifacts disagree", async () => {
    const host = new FakeDeviceHost();
    const prepared = await submission();

    await expect(
      buildAdapter(host).submit({
        ...prepared,
        artifacts: [
          {
            ...prepared.artifacts[0]!,
            documentId: secondDocumentId
          }
        ]
      })
    ).rejects.toBeInstanceOf(PrinterAdapterError);
  });
});

describe("WindowsPrinterAdapter resolution after a restart", () => {
  it("reports nothing submitted when this machine never recorded an intent", async () => {
    const host = new FakeDeviceHost();
    host.answer("status", { state: "NOT_SUBMITTED", confidence: "CONFIRMED", sheetsProduced: 0 });

    expect(await buildAdapter(host).getOperationStatus(operationId)).toMatchObject({
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED",
      sheetsProduced: 0
    });
  });

  /**
   * The spooler purges job history and the host may lose its state file.
   * Neither is evidence that nothing printed, and reading it that way is what
   * would hand a paid job to a printer a second time.
   */
  it("reports unknown when the host forgot an operation this machine submitted", async () => {
    const host = new FakeDeviceHost();
    host.answer("submit", { state: "COMPLETED", confidence: "CONFIRMED", sheetsProduced: 3 });
    const adapter = buildAdapter(host);
    await adapter.submit(await submission());
    host.answer("status", { state: "NOT_SUBMITTED", confidence: "CONFIRMED", sheetsProduced: 0 });

    expect(await adapter.getOperationStatus(operationId)).toMatchObject({
      state: "UNKNOWN",
      confidence: "UNCONFIRMED",
      failureCode: "SUBMISSION_UNCONFIRMED"
    });
  });

  it("keeps the ambiguity when the host cannot be asked", async () => {
    const host = new FakeDeviceHost();
    host.answer("submit", { state: "COMPLETED", confidence: "CONFIRMED", sheetsProduced: 3 });
    const adapter = buildAdapter(host);
    await adapter.submit(await submission());
    host.failWith = new Error("DEVICE_HOST_UNAVAILABLE");

    expect((await adapter.getOperationStatus(operationId)).state).toBe("UNKNOWN");
  });

  it("treats a report with no readable state as unknown rather than a state", async () => {
    const host = new FakeDeviceHost();
    host.answer("status", { state: "SOMETHING_NEW" });

    await expect(buildAdapter(host).getOperationStatus(operationId)).resolves.toMatchObject({
      state: "NOT_SUBMITTED"
    });
  });
});

describe("WindowsPrinterAdapter cancellation and retention", () => {
  it("confirms nothing was printed when the operation never reached the spooler", async () => {
    const host = new FakeDeviceHost();
    host.answer("cancel", { state: "NOT_SUBMITTED", confidence: "CONFIRMED", sheetsProduced: 0 });

    expect(await buildAdapter(host).cancel(operationId)).toMatchObject({
      state: "CANCELED",
      confidence: "CONFIRMED",
      failureCode: "CANCELED_BEFORE_SUBMIT",
      sheetsProduced: 0
    });
  });

  it("refuses to claim nothing came out of a job already at the device", async () => {
    const host = new FakeDeviceHost();
    host.answer("submit", { state: "PRINTING", confidence: "UNCONFIRMED", sheetsProduced: null });
    const adapter = buildAdapter(host);
    await adapter.submit(await submission());
    host.answer("cancel", { state: "CANCELED", confidence: "CONFIRMED", sheetsProduced: null });

    expect(await adapter.cancel(operationId)).toMatchObject({
      state: "CANCELED",
      confidence: "UNCONFIRMED",
      failureCode: "CANCELED_AT_DEVICE"
    });
  });

  it("sweeps the host and this machine's own record together", async () => {
    const host = new FakeDeviceHost();
    host.answer("submit", { state: "COMPLETED", confidence: "CONFIRMED", sheetsProduced: 3 });
    host.answer("discard", { discarded: 1 });
    const adapter = buildAdapter(host);
    await adapter.submit(await submission());

    const discarded = await adapter.discardOutputsBefore(new Date(Date.now() + 60_000));

    expect(discarded).toBe(1);
    expect(await readdir(journalDirectory)).toHaveLength(0);
    expect(host.requests.some((request) => request.op === "discard")).toBe(true);
  });
});
