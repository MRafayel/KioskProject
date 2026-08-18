import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
    manifestVersion: 2 as const,
    printJobId,
    sessionId,
    settingsRevision: 1,
    settingsManifestHash: "b".repeat(64),
    quoteId: "01900000-0000-7000-8000-000000000805",
    paymentId: "01900000-0000-7000-8000-000000000806",
    paperSize: "A4" as const,
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
        selectedPages: 2,
        copies: 1,
        duplex: "SIMPLEX" as const,
        orientation: "PORTRAIT" as const,
        printedSides: 2,
        physicalSheets: 2
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
function buildTransport(
  commands: AgentPrintCommand[],
  documentOverride?: Buffer,
  rejectProgressState?: string
) {
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
    if (url.pathname.endsWith("/progress") && recorded.at(-1)?.body.state === rejectProgressState) {
      return Promise.resolve(
        new Response(JSON.stringify({ accepted: false, printJobStatus: "DISPATCHED" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    }
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

function buildRunner(
  adapter: PrinterAdapter,
  fetchImpl: typeof fetch,
  overrides: {
    leaseRenewalMilliseconds?: number;
    devicePollIntervalMilliseconds?: number;
  } = {}
) {
  return new PrintCommandRunner({
    environment: loadEnvironment({
      NODE_ENV: "test",
      PRINTER_SPOOL_DIR: spoolDirectory,
      PRINTER_MOCK_OUTPUT_DIR: outputDirectory
    }),
    adapter,
    logger: silentLogger,
    fetch: fetchImpl,
    ...overrides
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
    // Preparation renews the lease without pretending the device has the job;
    // SUBMITTED is the handoff boundary.
    expect(transport.progress().map((entry) => entry.body.state)).toEqual([
      "PREPARING",
      "SUBMITTED"
    ]);
  });

  it("never submits after the control plane rejects the submission boundary", async () => {
    const transport = buildTransport([buildCommand()], undefined, "SUBMITTED");
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
      failureCode: "CANCELED_BEFORE_SUBMIT",
      sheetsProduced: 0
    });
  });

  it("classifies an unexpected artifact-fetch failure as definitely pre-submission", async () => {
    const transport = buildTransport([buildCommand()]);
    let submissions = 0;
    const adapter = stubAdapter(() => {
      submissions += 1;
      return completed();
    });
    const fetchImpl = (input: string | URL, init?: RequestInit) =>
      new URL(input).pathname.includes("/documents/")
        ? Promise.reject(new TypeError("network unavailable"))
        : transport.fetch(input, init);

    await buildRunner(adapter, fetchImpl as typeof fetch).runOnce();

    expect(submissions).toBe(0);
    expect(transport.results()[0]?.body).toMatchObject({
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED",
      failureCode: "ARTIFACT_UNAVAILABLE",
      sheetsProduced: 0
    });
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
      describe: () => adapter.describe(),
      getHealth: () => adapter.getHealth(),
      getCapabilities: () => adapter.getCapabilities(),
      getOperationStatus: (id) => adapter.getOperationStatus(id),
      cancel: (id) => adapter.cancel(id),
      discardOutputsBefore: (cutoff) => adapter.discardOutputsBefore(cutoff),
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

  it("clears a spool an interrupted print left behind", async () => {
    // A kiosk that lost power mid-print. Nothing is left to delete the document
    // it had already fetched, so a later pass must.
    const abandoned = join(spoolDirectory, "operations", "01900000-0000-7000-8000-0000000009f1");
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, "leaked.pdf"), documentBytes);
    await age(abandoned);

    const transport = buildTransport([buildCommand()]);
    const adapter = new MockPrinterAdapter({ outputDirectory });

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    await expect(readdir(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    expect(transport.results()[0]?.body).toMatchObject({ state: "COMPLETED" });
  });

  it("never sweeps a spool another agent instance is still printing from", async () => {
    // The claim model lets a second agent instance serve the same kiosk, and
    // both may share this directory. Sweeping by age is what keeps a peer's
    // in-flight document safe: a live job cannot outlive the job timeout.
    const peer = join(spoolDirectory, "operations", "01900000-0000-7000-8000-0000000009f2");
    await mkdir(peer, { recursive: true });
    await writeFile(join(peer, "in-flight.pdf"), documentBytes);

    const transport = buildTransport([buildCommand()]);
    const adapter = new MockPrinterAdapter({ outputDirectory });

    await buildRunner(adapter, transport.fetch as typeof fetch).runOnce();

    expect(await readdir(peer)).toEqual(["in-flight.pdf"]);
  });

  it("discards a spooled document even when the operation never reaches the device", async () => {
    // A redelivery the device has already answered returns before submitting.
    // The document fetched by the attempt that died must still not survive.
    const stranded = join(spoolDirectory, "operations", operationId);
    const transport = buildTransport([buildCommand({ redelivered: true })]);
    const adapter = stubAdapter(completed, () => ({
      operationId,
      state: "COMPLETED",
      confidence: "UNCONFIRMED",
      failureCode: null,
      warningCode: null,
      sheetsProduced: null
    }));
    const runner = buildRunner(adapter, transport.fetch as typeof fetch);
    await runner.runOnce();

    // Re-create the leftover the way a crashed attempt would, then prove the
    // next pass over the same operation clears it rather than stepping past it.
    // It is deliberately left fresh: the age sweep must not be what saves this,
    // because a redelivery can arrive long before the job timeout.
    await mkdir(stranded, { recursive: true });
    await writeFile(join(stranded, "leaked.pdf"), documentBytes);
    const second = buildTransport([buildCommand({ redelivered: true })]);
    await buildRunner(adapter, second.fetch as typeof fetch).runOnce();

    await expect(readdir(stranded)).rejects.toMatchObject({ code: "ENOENT" });
    expect(second.results()[0]?.body).toMatchObject({ state: "COMPLETED" });
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

describe("PrintCommandRunner while the device holds the work", () => {
  it("renews the lease for as long as the device is printing", async () => {
    // A print slower than one lease used to be reclaimed mid-flight: the paper
    // came out, the agent's result was refused as stale, and a healthy job
    // settled into operator recovery.
    const transport = buildTransport([buildCommand()]);
    const adapter = stubAdapter(() => ({
      operationId,
      state: "COMPLETED",
      confidence: "CONFIRMED",
      failureCode: null,
      warningCode: null,
      sheetsProduced: 2
    }));
    const slowAdapter: PrinterAdapter = {
      ...adapter,
      submit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          operationId,
          state: "COMPLETED" as const,
          confidence: "CONFIRMED" as const,
          failureCode: null,
          warningCode: null,
          sheetsProduced: 2
        };
      }
    };

    await buildRunner(slowAdapter, transport.fetch as typeof fetch, {
      leaseRenewalMilliseconds: 20
    }).runOnce();

    const states = transport.progress().map((entry) => entry.body.state);
    expect(states.slice(0, 2)).toEqual(["PREPARING", "SUBMITTED"]);
    // The renewals are the point: without them the lease expires mid-print.
    expect(states.filter((state) => state === "PRINTING").length).toBeGreaterThan(0);
    expect(transport.results()[0]?.body).toMatchObject({
      state: "COMPLETED",
      confidence: "CONFIRMED"
    });
  });

  it("stops renewing once the control plane refuses, and still reports the outcome", async () => {
    // A lost lease cannot be regained with the old claim token, so retrying
    // would only produce a log line per interval. The print is deliberately
    // left running: stopping changes nothing at the printer.
    const transport = buildTransport([buildCommand()], undefined, "PRINTING");
    const slowAdapter = {
      ...stubAdapter(() => ({
        operationId,
        state: "COMPLETED" as const,
        confidence: "CONFIRMED" as const,
        failureCode: null,
        warningCode: null,
        sheetsProduced: 2
      })),
      submit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          operationId,
          state: "COMPLETED" as const,
          confidence: "CONFIRMED" as const,
          failureCode: null,
          warningCode: null,
          sheetsProduced: 2
        };
      }
    };

    await buildRunner(slowAdapter, transport.fetch as typeof fetch, {
      leaseRenewalMilliseconds: 20
    }).runOnce();

    const renewals = transport.progress().filter((entry) => entry.body.state === "PRINTING");
    expect(renewals).toHaveLength(1);
    expect(transport.results()).toHaveLength(1);
  });

  it("waits out a device that has not finished describing its work", async () => {
    // The host answers when its observation budget runs out, not when the
    // printer stops. Reporting `PRINTING` as a final result would settle a
    // healthy print into operator recovery.
    const transport = buildTransport([buildCommand()]);
    let statusCalls = 0;
    const adapter = stubAdapter(
      () => ({
        operationId,
        state: "PRINTING",
        confidence: "UNCONFIRMED",
        failureCode: null,
        warningCode: null,
        sheetsProduced: null
      }),
      () => {
        statusCalls += 1;
        return statusCalls < 2
          ? {
              operationId,
              state: "PRINTING",
              confidence: "UNCONFIRMED",
              failureCode: null,
              warningCode: null,
              sheetsProduced: null
            }
          : {
              operationId,
              state: "COMPLETED",
              confidence: "CONFIRMED",
              failureCode: null,
              warningCode: null,
              sheetsProduced: 2
            };
      }
    );

    await buildRunner(adapter, transport.fetch as typeof fetch, {
      devicePollIntervalMilliseconds: 10
    }).runOnce();

    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(transport.results()[0]?.body).toMatchObject({
      state: "COMPLETED",
      confidence: "CONFIRMED",
      sheetsProduced: 2
    });
  });

  it("reports work still open at the job deadline as unknown, never as done", async () => {
    // The deadline is already behind us, so the only exit from the wait is the
    // deadline branch. A device that never stops saying `PRINTING` must not be
    // waited on past the point where the control plane settles the job anyway.
    const transport = buildTransport([
      buildCommand({ deadlineAt: new Date(Date.now() - 1_000).toISOString() })
    ]);
    const stillPrinting = (): PrintOperationStatus => ({
      operationId,
      state: "PRINTING",
      confidence: "UNCONFIRMED",
      failureCode: null,
      warningCode: null,
      sheetsProduced: null
    });
    const adapter = stubAdapter(stillPrinting, stillPrinting);

    await buildRunner(adapter, transport.fetch as typeof fetch, {
      devicePollIntervalMilliseconds: 10
    }).runOnce();

    expect(transport.results()[0]?.body).toMatchObject({
      state: "UNKNOWN",
      confidence: "UNCONFIRMED",
      failureCode: "SUBMISSION_UNCONFIRMED",
      sheetsProduced: null
    });
  });
});

function stubAdapter(
  submit: () => PrintOperationStatus,
  status?: () => PrintOperationStatus
): PrinterAdapter {
  return {
    name: "STUB",
    describe: () =>
      Promise.resolve({
        adapter: "STUB",
        queueName: "Stub Queue",
        deviceId: null,
        makeAndModel: null,
        driverName: null,
        firmware: null
      }),
    getHealth: () => Promise.resolve({ state: "READY", warningCode: null }),
    getCapabilities: () =>
      Promise.resolve({
        version: 3,
        paperSizes: ["A4"],
        duplexModes: ["SIMPLEX"],
        colorModes: ["MONOCHROME"],
        orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
        scalingModes: ["FIT", "ACTUAL_SIZE"],
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
    cancel: () => Promise.resolve(completed()),
    discardOutputsBefore: () => Promise.resolve(0)
  };
}

/** Backdate a spool directory past any job timeout, as a crash would leave it. */
async function age(directory: string): Promise<void> {
  const longAgo = new Date(Date.now() - 86_400_000);
  await utimes(directory, longAgo, longAgo);
}

async function writeArtifact(directory: string): Promise<string> {
  const target = join(directory, "seed");
  await mkdir(target, { recursive: true });
  const path = join(target, "document.pdf");
  await writeFile(path, documentBytes);
  return path;
}
