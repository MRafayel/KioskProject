import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import { printCapabilitiesResponseSchema } from "../../packages/contracts/src/settings.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import {
  capabilitySnapshotHash,
  MockPrinterAdapter,
  WindowsPrinterAdapter,
  type DeviceHostTransport,
  type PrinterCapabilitiesSnapshot
} from "../../packages/printer-adapters/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import { DeviceRegistryReporter } from "../../services/kiosk-agent/src/device/reporter.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

const kioskId = "kiosk_phase10_integration_001";
const kioskCredentialId = "phase10-integration-kiosk-credential";
const kioskApiKey = "phase10-integration-kiosk-key-000001";
const foreignKioskId = "kiosk_phase10_integration_foreign";
const foreignCredentialId = "phase10-integration-foreign-credential";
const foreignApiKey = "phase10-integration-foreign-key-000001";
const approvedQueue = "Kiosk A4";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({
  ...process.env,
  NODE_ENV: "test",
  DEV_KIOSK_ID: kioskId,
  DEV_KIOSK_API_KEY: kioskApiKey,
  PRINTER_QUEUE_ALLOWLIST: approvedQueue,
  DOCUMENT_PROCESSOR_MEMORY_MIB: "3072",
  DOCUMENT_PROCESSOR_SCRATCH_BYTES: "2147483648"
});
assertSafeIntegrationEnvironment(environment);

const database = createDatabaseClient(environment.DATABASE_URL);
const authorization = `Bearer ${kioskApiKey}`;
const foreignAuthorization = `Bearer ${foreignApiKey}`;

const baseCapabilities: PrinterCapabilitiesSnapshot = {
  version: 3,
  paperSizes: ["A4"],
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  colorModes: ["MONOCHROME"],
  orientations: ["AUTO"],
  scalingModes: ["FIT"],
  maxCopies: 10
};

let app: Awaited<ReturnType<typeof buildApp>>;
let agentId: string;
let customerSessionId: string;

beforeAll(async () => {
  try {
    await database.$queryRaw`SELECT 1`;
  } catch (error) {
    throw new Error(
      `PHASE10_DATABASE_NOT_READY: run pnpm infra:up and pnpm db:migrate (${safeMessage(error)})`
    );
  }

  await cleanFixtures();
  await Promise.all([
    upsertKiosk(kioskId, "PHASE10-INTEGRATION", [approvedQueue]),
    upsertKiosk(foreignKioskId, "PHASE10-FOREIGN", [approvedQueue])
  ]);
  await Promise.all([
    upsertCredential(
      "01900000-0000-7000-8000-000000001001",
      kioskId,
      kioskCredentialId,
      kioskApiKey
    ),
    upsertCredential(
      "01900000-0000-7000-8000-000000001002",
      foreignKioskId,
      foreignCredentialId,
      foreignApiKey
    )
  ]);

  app = await buildApp({ environment, logger: false, startBackgroundJobs: false });
  await app.ready();
  customerSessionId = await createCustomerSession();
});

afterAll(async () => {
  await app?.close();
  await cleanFixtures();
  await database.$disconnect();
});

beforeEach(async () => {
  agentId = randomUUID();
  await database.printer.deleteMany({ where: { kioskId: { in: [kioskId, foreignKioskId] } } });
  await database.kioskAgent.deleteMany({ where: { kioskId: { in: [kioskId, foreignKioskId] } } });
  await resetKioskCapabilities();
});

describe("agent registration", () => {
  it("registers an installation and answers with the operator's certification", async () => {
    const response = await register({ queueName: approvedQueue });

    expect(response.statusCode).toBe(201);
    const registration = response.json().registration as Record<string, unknown>;
    expect(registration).toMatchObject({
      kioskId,
      agentId,
      approvedQueues: [approvedQueue],
      heartbeatIntervalSeconds: environment.AGENT_HEARTBEAT_SECONDS
    });

    const stored = await database.kioskAgent.findUnique({ where: { agentId } });
    expect(stored).toMatchObject({ kioskId, platform: "win32", queueName: approvedQueue });
  });

  it("treats a restart as the same installation", async () => {
    await register({ queueName: approvedQueue });
    await register({ queueName: approvedQueue, agentVersion: "0.0.1" });

    const rows = await database.kioskAgent.findMany({ where: { kioskId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentVersion).toBe("0.0.1");
  });

  /**
   * An installation identifier belongs to one machine. A second kiosk claiming
   * it would make the fleet's liveness view describe the wrong machine, and
   * would let one kiosk's credential move another kiosk's device history.
   */
  it("refuses an installation another kiosk already registered", async () => {
    await register({ queueName: approvedQueue });

    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/register",
      headers: { authorization: foreignAuthorization, "content-type": "application/json" },
      payload: registerBody({ queueName: approvedQueue })
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AGENT_ALREADY_REGISTERED");
    expect(await database.kioskAgent.findUnique({ where: { agentId } })).toMatchObject({ kioskId });
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/register",
      headers: { "content-type": "application/json" },
      payload: registerBody({ queueName: approvedQueue })
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("agent heartbeat", () => {
  it("records liveness and asks for a report the control plane does not have", async () => {
    await register({ queueName: approvedQueue });

    const response = await heartbeat({ capabilityHash: "a".repeat(64) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ capabilityReportRequired: true });
    const stored = await database.kioskAgent.findUnique({ where: { agentId } });
    expect(stored?.lastHeartbeatAt).not.toBeNull();
    expect(stored?.printerHealth).toBe("READY");
  });

  it("stops asking once the report matches what it holds", async () => {
    await register({ queueName: approvedQueue });
    const hash = capabilitySnapshotHash(baseCapabilities);
    await report({ capabilities: baseCapabilities, capabilityHash: hash });

    const response = await heartbeat({ capabilityHash: hash });

    expect(response.json()).toMatchObject({ capabilityReportRequired: false });
  });

  /**
   * A swapped or reconfigured printer is a different device, and the customer
   * settings derived from the old one are no longer true. One heartbeat is what
   * it takes to notice.
   */
  it("asks again the moment the printer's answer changes", async () => {
    await register({ queueName: approvedQueue });
    await report({
      capabilities: baseCapabilities,
      capabilityHash: capabilitySnapshotHash(baseCapabilities)
    });

    const simplexOnly = { ...baseCapabilities, duplexModes: ["SIMPLEX"] };
    const response = await heartbeat({ capabilityHash: capabilitySnapshotHash(simplexOnly) });

    expect(response.json()).toMatchObject({ capabilityReportRequired: true });
  });

  it("tells an unregistered agent to register rather than counting it alive", async () => {
    const response = await heartbeat({ capabilityHash: "a".repeat(64) });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AGENT_NOT_REGISTERED");
  });
});

describe("printer reporting", () => {
  it("publishes an approved printer's capabilities to the settings a customer sees", async () => {
    await register({ queueName: approvedQueue });
    const duplexCapable = {
      ...baseCapabilities,
      duplexModes: ["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"]
    };

    const response = await report({
      capabilities: duplexCapable,
      capabilityHash: capabilitySnapshotHash(duplexCapable)
    });

    expect(response.json()).toMatchObject({ capabilitiesUpdated: true, capabilityVersion: 3 });
    const capabilities = await readSessionCapabilities();
    // The certified product profile narrows broader driver support.
    expect(capabilities.duplexModes).toEqual(["SIMPLEX", "LONG_EDGE"]);
  });

  it("bumps the capability version only when the device actually changed", async () => {
    await register({ queueName: approvedQueue });
    const hash = capabilitySnapshotHash(baseCapabilities);
    await report({ capabilities: baseCapabilities, capabilityHash: hash });

    const repeated = await report({ capabilities: baseCapabilities, capabilityHash: hash });

    expect(repeated.json()).toMatchObject({ capabilitiesUpdated: false, capabilityVersion: 3 });
  });

  /**
   * Approval is the operator's certification and it is re-derived here. An
   * agent that labelled a queue approved cannot make it so, because that is
   * exactly what a swapped printer or a tampered kiosk would claim.
   */
  it("refuses capabilities for a queue the kiosk did not certify", async () => {
    await register({ queueName: "Microsoft Print to PDF" });

    const response = await report({
      queueName: "Microsoft Print to PDF",
      capabilities: baseCapabilities,
      capabilityHash: capabilitySnapshotHash(baseCapabilities)
    });

    expect(response.json()).toMatchObject({ capabilitiesUpdated: false });
    const stored = await database.printer.findMany({ where: { kioskId } });
    expect(stored.every((printer) => printer.approval !== "APPROVED")).toBe(true);
    // The kiosk keeps what it was already offering rather than losing its
    // settings because an uncertified printer was plugged in.
    expect((await readSessionCapabilities()).duplexModes).toEqual(["SIMPLEX", "LONG_EDGE"]);
  });

  it("keeps a row for every queue the machine offers", async () => {
    await register({ queueName: approvedQueue });

    await report({
      capabilities: baseCapabilities,
      capabilityHash: capabilitySnapshotHash(baseCapabilities),
      discovered: [
        queueDescriptor({ queueName: approvedQueue }),
        queueDescriptor({ queueName: "Microsoft Print to PDF", isDefault: false }),
        queueDescriptor({ queueName: "Marketing Colour", isDefault: false, shared: true })
      ]
    });

    const stored = await database.printer.findMany({
      where: { kioskId },
      orderBy: { queueName: "asc" }
    });
    expect(stored.map((printer) => [printer.queueName, printer.approval])).toEqual([
      ["Kiosk A4", "APPROVED"],
      ["Marketing Colour", "NOT_APPROVED"],
      ["Microsoft Print to PDF", "NOT_APPROVED"]
    ]);
    expect(stored.filter((printer) => printer.capabilities !== null)).toHaveLength(1);
  });

  it("withdraws approval when the agent can no longer bind a printer", async () => {
    await register({ queueName: approvedQueue });
    await report({
      capabilities: baseCapabilities,
      capabilityHash: capabilitySnapshotHash(baseCapabilities)
    });

    await report({
      queueName: null,
      approval: "NOT_APPROVED",
      capabilities: null,
      capabilityHash: "0".repeat(64),
      health: "OFFLINE"
    });

    const stored = await database.printer.findMany({ where: { kioskId, approval: "APPROVED" } });
    expect(stored).toHaveLength(0);
    // The settings a customer mid-session already chose stay valid: a printer
    // that was briefly unreachable is not a reason to change what they may pick.
    expect((await readSessionCapabilities()).duplexModes).toEqual(baseCapabilities.duplexModes);
  });

  it("refuses a report from an agent that never registered", async () => {
    const response = await report({
      capabilities: baseCapabilities,
      capabilityHash: capabilitySnapshotHash(baseCapabilities)
    });

    expect(response.statusCode).toBe(409);
  });
});

describe("the agent driving the device plane end to end", () => {
  let journalDirectory: string;
  let mockOutput: string;

  beforeEach(async () => {
    journalDirectory = await mkdtemp(join(tmpdir(), "phase10-journal-"));
    mockOutput = await mkdtemp(join(tmpdir(), "phase10-output-"));
  });

  afterAll(async () => {
    await rm(journalDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(mockOutput, { recursive: true, force: true }).catch(() => undefined);
  });

  /**
   * The whole point of the phase in one test: a real adapter discovers a queue,
   * the operator's allowlist decides whether it may be used, and what the
   * device says it can do becomes what a customer is offered — without anybody
   * editing a capability row by hand.
   */
  it("publishes a discovered printer's capabilities through to a customer session", async () => {
    const adapter = new WindowsPrinterAdapter({
      transport: hostAnswering({
        "list-queues": [
          {
            queueName: approvedQueue,
            deviceUri: "wsd://10.0.0.9",
            driverName: "Generic PCL6",
            portName: "IP_10.0.0.9",
            state: "READY",
            isDefault: true,
            shared: false
          }
        ],
        describe: {
          deviceId: "urn:uuid:phase10",
          makeAndModel: "Kiosk Laser 400",
          driverName: "Generic PCL6",
          firmware: "4.2.1"
        },
        health: { state: "READY" },
        capabilities: {
          mediaSizes: ["A4"],
          sides: ["OneSided", "TwoSidedLongEdge", "TwoSidedShortEdge"],
          colorModes: ["Monochrome"],
          maxCopies: 12
        }
      }),
      queueName: approvedQueue,
      approvedQueues: [approvedQueue],
      journalDirectory,
      maxCopies: environment.MAX_COPIES
    });

    const reporter = new DeviceRegistryReporter({
      environment,
      adapter,
      logger: { info: () => undefined, warn: () => undefined },
      agentId,
      agentVersion: "0.0.0",
      platform: "win32",
      platformRelease: "10.0.19045",
      fetch: injectFetch
    });

    await reporter.runOnce();

    const stored = await database.printer.findFirst({ where: { kioskId, approval: "APPROVED" } });
    expect(stored).toMatchObject({
      queueName: approvedQueue,
      adapter: "WINDOWS",
      makeAndModel: "Kiosk Laser 400",
      firmware: "4.2.1",
      health: "READY"
    });

    const capabilities = await readSessionCapabilities();
    expect(capabilities.duplexModes).toEqual(["SIMPLEX", "LONG_EDGE"]);
    // The deployment ceiling still wins over what the driver offers.
    expect(capabilities.maxCopies).toBe(10);
  });

  it("publishes nothing when the machine offers no certified queue", async () => {
    const adapter = new MockPrinterAdapter({ outputDirectory: mockOutput });
    const reporter = new DeviceRegistryReporter({
      environment,
      adapter,
      logger: { info: () => undefined, warn: () => undefined },
      agentId,
      agentVersion: "0.0.0",
      platform: "linux",
      platformRelease: null,
      fetch: injectFetch
    });

    // The simulated printer offers "Mock Kiosk Printer"; this kiosk certified
    // "Kiosk A4". Discovery has to refuse rather than print somewhere else.
    await reporter.runOnce();

    const approved = await database.printer.findMany({ where: { kioskId, approval: "APPROVED" } });
    const discovered = await database.printer.findMany({ where: { kioskId } });
    expect(approved).toHaveLength(0);
    expect(discovered.map((printer) => printer.queueName)).toEqual([MockPrinterAdapter.QUEUE_NAME]);
  });
});

/**
 * Windows integration against the real print subsystem.
 *
 * The production profile uses the Canon USB rendering host. The test runs only
 * where that host has actually been configured, and is skipped everywhere else
 * rather than passing vacuously.
 */
describe.skipIf(process.platform !== "win32" || !process.env.PRINTER_WINDOWS_HOST_PATH)(
  "windows device host",
  () => {
    it("enumerates the machine's real print queues", async () => {
      const { ChildProcessDeviceHost } =
        await import("../../packages/printer-adapters/src/windows/child-process-host.js");
      const { readQueueList } =
        await import("../../packages/printer-adapters/src/windows/protocol.js");
      const host = new ChildProcessDeviceHost({
        executablePath: process.env.PRINTER_WINDOWS_HOST_PATH!
      });

      const response = await host.request(
        { protocol: 1, op: "list-queues" },
        { timeoutMilliseconds: 30_000 }
      );
      const queues = readQueueList((response as { result: unknown }).result);

      expect(queues.length).toBeGreaterThan(0);
      expect(queues.every((queue) => queue.queueName.length > 0)).toBe(true);
    });
  }
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hostAnswering(answers: Record<string, unknown>): DeviceHostTransport {
  return {
    request: (request) => Promise.resolve({ ok: true, result: answers[request.op] ?? {} })
  };
}

/** Routes the reporter's outbound calls into the in-process API. */
const injectFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const response = await app.inject({
    method: (init?.method ?? "GET") as "POST" | "PUT",
    url: new URL(input).pathname,
    headers: { authorization, "content-type": "application/json" },
    payload: String(init?.body ?? "{}")
  });
  return new Response(response.body, {
    status: response.statusCode,
    headers: { "content-type": "application/json" }
  });
};

function registerBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agentId,
    agentVersion: "0.0.0",
    platform: "win32",
    platformRelease: "10.0.19045",
    adapter: "WINDOWS",
    queueName: approvedQueue,
    ...overrides
  });
}

function register(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/agent/register",
    headers: { authorization, "content-type": "application/json" },
    payload: registerBody(overrides)
  });
}

function heartbeat(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/agent/heartbeat",
    headers: { authorization, "content-type": "application/json" },
    payload: JSON.stringify({
      agentId,
      queueName: approvedQueue,
      printerHealth: "READY",
      capabilityHash: "a".repeat(64),
      activeOperations: 0,
      ...overrides
    })
  });
}

function report(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "PUT",
    url: "/v1/agent/printers",
    headers: { authorization, "content-type": "application/json" },
    payload: JSON.stringify({
      agentId,
      adapter: "WINDOWS",
      queueName: approvedQueue,
      approval: "APPROVED",
      deviceId: "urn:uuid:phase10",
      makeAndModel: "Kiosk Laser 400",
      driverName: "Generic PCL6",
      firmware: "4.2.1",
      health: "READY",
      warningCode: null,
      discovered: [queueDescriptor({ queueName: approvedQueue })],
      ...overrides
    })
  });
}

function queueDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    queueName: approvedQueue,
    deviceUri: "wsd://10.0.0.9",
    driverName: "Generic PCL6",
    portName: "IP_10.0.0.9",
    state: "READY",
    isDefault: true,
    shared: false,
    ...overrides
  };
}

/**
 * What a customer's session is actually offered, read through the API rather
 * than from the row this suite just wrote. One session serves the whole suite:
 * a kiosk holds one at a time, and what is under test is the capability answer,
 * not session creation.
 */
async function readSessionCapabilities() {
  const capabilities = await app.inject({
    method: "GET",
    url: `/v1/sessions/${customerSessionId}/print-capabilities`,
    headers: { authorization }
  });
  return printCapabilitiesResponseSchema.parse(capabilities.json());
}

async function createCustomerSession(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/kiosks/${kioskId}/sessions`,
    headers: {
      authorization,
      "content-type": "application/json",
      "idempotency-key": `phase10-${randomUUID()}`
    },
    payload: JSON.stringify({ locale: "hy" })
  });
  return createSessionResponseSchema.parse(response.json()).session.id;
}

const fixtureCapabilities = {
  service: "PRINT_ONLY",
  outputMode: "MONOCHROME",
  colorModes: ["MONOCHROME"],
  paperSizes: ["A4"],
  duplex: true,
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  orientations: ["AUTO"],
  scalingModes: ["FIT"],
  maxCopies: 10,
  approvedQueues: [approvedQueue],
  scanningEnabled: false,
  photocopyEnabled: false
};

async function upsertKiosk(id: string, publicCode: string, queues: string[]): Promise<void> {
  const capabilities = { ...fixtureCapabilities, approvedQueues: queues };
  await database.kiosk.upsert({
    where: { id },
    create: {
      id,
      publicCode,
      name: "Phase 10 kiosk",
      status: "ACTIVE",
      timezone: "Asia/Yerevan",
      capabilities,
      capabilitiesVersion: 2
    },
    update: { status: "ACTIVE", capabilities, capabilitiesVersion: 2 }
  });
}

async function resetKioskCapabilities(): Promise<void> {
  await database.kiosk.update({
    where: { id: kioskId },
    data: { capabilities: fixtureCapabilities, capabilitiesVersion: 2 }
  });
}

async function upsertCredential(
  id: string,
  kiosk: string,
  credentialId: string,
  rawCredential: string
): Promise<void> {
  const secretDigest = createHash("sha256").update(rawCredential, "utf8").digest("hex");
  const scopes = ["sessions:create", "sessions:read", "settings:write", "print-jobs:agent"];
  await database.kioskCredential.upsert({
    where: { credentialId },
    create: { id, kioskId: kiosk, credentialId, secretDigest, scopes },
    update: { kioskId: kiosk, secretDigest, scopes, revokedAt: null, expiresAt: null }
  });
}

async function cleanFixtures(): Promise<void> {
  const kiosks = [kioskId, foreignKioskId];
  await database.printer.deleteMany({ where: { kioskId: { in: kiosks } } });
  await database.kioskAgent.deleteMany({ where: { kioskId: { in: kiosks } } });
  await database.sessionEvent.deleteMany({ where: { kioskId: { in: kiosks } } });
  // Audit events are append-only and deliberately outlive the device rows
  // they describe, matching every other integration suite's cleanup policy.
  await database.printSession.deleteMany({ where: { kioskId: { in: kiosks } } });
  await database.kioskCredential.deleteMany({
    where: { credentialId: { in: [kioskCredentialId, foreignCredentialId] } }
  });
  await database.kiosk.deleteMany({ where: { id: { in: kiosks } } });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
