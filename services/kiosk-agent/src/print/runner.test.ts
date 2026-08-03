import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";
import type { AgentPrintCommand } from "@printing-kiosk/contracts";
import {
  canonicalPrintManifestJson,
  MockPrinterAdapter,
  PrinterAdapterError,
  type PrinterAdapter,
  type PrintOperationStatus,
  type PrintSubmission
} from "@printing-kiosk/printer-adapters";

import { PrintCommandRunner } from "./runner.js";

const operationId = "01900000-0000-7000-8000-000000000801";
const printJobId = "01900000-0000-7000-8000-000000000802";
const sessionId = "01900000-0000-7000-8000-000000000803";
const documentId = "01900000-0000-7000-8000-000000000804";
const documentBytes = Buffer.from("%PDF-1.7\ncontent\n", "utf8");
const documentSha256 = createHash("sha256").update(documentBytes).digest("hex");

const silentLogger = { info: () => undefined, warn: () => undefined };

let spoolDirectory: string;
let outputDirectory: string;

beforeEach(async () => {
  spoolDirectory = await mkdtemp(join(tmpdir(), "kiosk-spool-"));
  outputDirectory = await mkdtemp(join(tmpdir(), "kiosk-out-"));
});

afterEach(async () => {
  await rm(spoolDirectory, { recursive: true, force: true });
  await rm(outputDirectory, { recursive: true, force: true });
});

function buildManifest() {
  return {
    manifestVersion: 1 as const,
    printJobId,
    sessionId,
    settingsRevision: 1,
    settingsManifestHash: "b".repeat(64),
    quoteId: "01900000-0000-7000-8000-000000000805",
    paymentId: "01900000-0000-7000-8000-000000000806",
    copies: 1,
    duplex: "SIMPLEX" as const,
    paperSize: "A4" as const,
    orientation: "PORTRAIT" as const,
    scaling: "FIT" as const,
    collate: true,
    colorMode: "MONOCHROME" as const,
    selectedPages: 2,
    printedSides: 2,
    physicalSheets: 2,
    documents: [
      {
        documentId,
        position: 0,
        sha256: documentSha256,
        sizeBytes: documentBytes.byteLength,
        pageCount: 2,
        pageRanges: [[1, 2]] as [number, number][],
        selectedPages: 2
      }
    ]
  };
}

function buildCommand(overrides: Partial<AgentPrintCommand> = {}): AgentPrintCommand {
  const manifest = overrides.manifest ?? buildManifest();
  return {
    operationId,
    type: "PRINT",
    printJobId,
    sessionId,
    claimToken: "01900000-0000-7000-8000-000000000807",
    manifest,
    manifestHash: createHash("sha256")
      .update(canonicalPrintManifestJson(manifest), "utf8")
      .digest("hex"),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    redelivered: false,
    simulatedOutcome: null,
    ...overrides
  };
}

interface Recorded {
  path: string;
  body: Record<string, unknown>;
}

/**
 * A control plane that hands out one command and records everything reported
 * back, plus the print-ready document the agent is allowed to read.
 */
function buildTransport(commands: AgentPrintCommand[], documentOverride?: Buffer) {
  const recorded: Recorded[] = [];
  let claimed = false;

  const fetchImpl = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === "/v1/agent/commands/claim") {
      const body = claimed ? { commands: [] } : { commands };
      claimed = true;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    }
    if (url.pathname.includes("/documents/")) {
      const payload = documentOverride ?? documentBytes;
      return Promise.resolve(
        new Response(new Uint8Array(payload), {
          status: 200,
          headers: { "content-type": "application/pdf" }
        })
      );
    }
    recorded.push({
      path: url.pathname,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
    });
    return Promise.resolve(
      new Response(JSON.stringify({ accepted: true, printJobStatus: "PRINTING" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  };

  return {
    fetch: fetchImpl,
    results: () => recorded.filter((entry) => entry.path.endsWith("/result")),
    progress: () => recorded.filter((entry) => entry.path.endsWith("/progress"))
  };
}

function buildRunner(adapter: PrinterAdapter, fetchImpl: typeof fetch) {
  return new PrintCommandRunner({
    environment: loadEnvironment({
      NODE_ENV: "test",
      PRINTER_SPOOL_DIR: spoolDirectory,
      PRINTER_MOCK_OUTPUT_DIR: outputDirectory
    }),
    adapter,
    logger: silentLogger,
    fetch: fetchImpl
  });
}

describe("PrintCommandRunner", () => {
  it("prints one claimed command and reports a confirmed completion", async () => {
    const transport = buildTransport([buildCommand()]);
    const adapter = new MockPrinterAdapter({ outputDirectory });

    const handled = await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    expect(handled).toBe(1);
    expect(transport.results()).toHaveLength(1);
    expect(transport.results()[0]?.body).toMatchObject({
      state: "COMPLETED",
      confidence: "CONFIRMED",
      sheetsProduced: 2
    });
    // The device is told it is working on the job before it is given the job,
    // so an interrupted print is visible rather than silent.
    expect(transport.progress().map((entry) => entry.body.state)).toEqual([
      "PRINTING",
      "SUBMITTED"
    ]);
  });

  it("never resubmits a redelivered operation the device already completed", async () => {
    const transport = buildTransport([buildCommand({ redelivered: true })]);
    const adapter = new MockPrinterAdapter({ outputDirectory });
    // The device already ran this operation before the agent was restarted.
    await adapter.submit({
      operationId,
      manifest: buildManifest(),
      artifacts: [
        {
          documentId,
          position: 0,
          path: await writeArtifact(spoolDirectory),
          sha256: documentSha256,
          sizeBytes: documentBytes.byteLength
        }
      ]
    });

    let submissions = 0;
    const counting: PrinterAdapter = {
      ...adapter,
      name: adapter.name,
      getHealth: () => adapter.getHealth(),
      getCapabilities: () => adapter.getCapabilities(),
      getOperationStatus: (id) => adapter.getOperationStatus(id),
      cancel: (id) => adapter.cancel(id),
      submit: (submission: PrintSubmission) => {
        submissions += 1;
        return adapter.submit(submission);
      }
    };

    await buildRunner(counting, transport.fetch as typeof fetch).runOnce();

    expect(submissions).toBe(0);
    // The device can prove it ran, but not that paper emerged.
    expect(transport.results()[0]?.body).toMatchObject({
      state: "COMPLETED",
      confidence: "UNCONFIRMED"
    });
  });

  it("reports an ambiguous submission rather than a success or a failure", async () => {
    const transport = buildTransport([buildCommand({ simulatedOutcome: "UNKNOWN_AFTER_SUBMIT" })]);
    const adapter = new MockPrinterAdapter({ outputDirectory });

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    expect(transport.results()[0]?.body).toMatchObject({
      state: "COMPLETED",
      confidence: "UNCONFIRMED"
    });
  });

  it("reports an offline printer as a definite failure that printed nothing", async () => {
    const transport = buildTransport([buildCommand({ simulatedOutcome: "OFFLINE" })]);
    const adapter = new MockPrinterAdapter({ outputDirectory });

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    expect(transport.results()[0]?.body).toMatchObject({
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED",
      failureCode: "PRINTER_OFFLINE",
      sheetsProduced: 0
    });
  });

  it("refuses a manifest whose hash does not match what it was told", async () => {
    const transport = buildTransport([buildCommand({ manifestHash: "c".repeat(64) })]);
    let submissions = 0;
    const adapter = stubAdapter(() => {
      submissions += 1;
      return completed();
    });

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    expect(submissions).toBe(0);
    expect(transport.results()[0]?.body).toMatchObject({
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED",
      failureCode: "ARTIFACT_UNAVAILABLE"
    });
  });

  it("refuses a document whose bytes do not match the manifest digest", async () => {
    const transport = buildTransport(
      [buildCommand()],
      Buffer.from("%PDF-1.7\nsomething else\n", "utf8")
    );
    let submissions = 0;
    const adapter = stubAdapter(() => {
      submissions += 1;
      return completed();
    });

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    expect(submissions).toBe(0);
    expect(transport.results()[0]?.body).toMatchObject({
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED"
    });
  });

  it("asks the device when an adapter failure could have started printing", async () => {
    const transport = buildTransport([buildCommand()]);
    let asked = 0;
    const adapter = stubAdapter(
      () => {
        throw new PrinterAdapterError("OUTPUT_WRITE_FAILED", true);
      },
      () => {
        asked += 1;
        return {
          operationId,
          state: "UNKNOWN",
          confidence: "UNCONFIRMED",
          failureCode: "SUBMISSION_UNCONFIRMED",
          warningCode: null,
          sheetsProduced: null
        } satisfies PrintOperationStatus;
      }
    );

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    expect(asked).toBe(1);
    expect(transport.results()[0]?.body).toMatchObject({
      state: "UNKNOWN",
      confidence: "UNCONFIRMED"
    });
  });

  it("leaves no local copy of a customer document behind", async () => {
    const transport = buildTransport([buildCommand()]);
    const adapter = new MockPrinterAdapter({ outputDirectory });

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    await expect(
      rm(join(spoolDirectory, "operations", operationId), { recursive: true })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function completed(): PrintOperationStatus {
  return {
    operationId,
    state: "COMPLETED",
    confidence: "CONFIRMED",
    failureCode: null,
    warningCode: null,
    sheetsProduced: 2
  };
}

function stubAdapter(
  submit: () => PrintOperationStatus,
  status?: () => PrintOperationStatus
): PrinterAdapter {
  return {
    name: "STUB",
    getHealth: () => Promise.resolve({ state: "READY", warningCode: null }),
    getCapabilities: () =>
      Promise.resolve({
        version: 1,
        paperSizes: ["A4"],
        duplexModes: ["SIMPLEX"],
        colorModes: ["MONOCHROME"],
        maxCopies: 1
      }),
    submit: () => Promise.resolve(submit()),
    getOperationStatus: () =>
      Promise.resolve(
        status?.() ?? {
          operationId,
          state: "NOT_SUBMITTED",
          confidence: "CONFIRMED",
          failureCode: null,
          warningCode: null,
          sheetsProduced: 0
        }
      ),
    cancel: () => Promise.resolve(completed())
  };
}

async function writeArtifact(directory: string): Promise<string> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const target = join(directory, "seed");
  await mkdir(target, { recursive: true });
  const path = join(target, "document.pdf");
  await writeFile(path, documentBytes);
  return path;
}
