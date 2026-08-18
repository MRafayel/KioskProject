import { beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, type Environment } from "@printing-kiosk/config";
import {
  capabilitySnapshotHash,
  type PrinterAdapter,
  type PrinterCapabilitiesSnapshot,
  type PrinterHealth,
  type PrinterQueueDescriptor
} from "@printing-kiosk/printer-adapters";

import { DeviceRegistryReporter } from "./reporter.js";

const agentId = "01900000-0000-7000-8000-000000000a01";

const capabilities: PrinterCapabilitiesSnapshot = {
  version: 3,
  paperSizes: ["A4"],
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  colorModes: ["MONOCHROME"],
  orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
  scalingModes: ["FIT", "ACTUAL_SIZE"],
  maxCopies: 20
};

function queue(overrides: Partial<PrinterQueueDescriptor> = {}): PrinterQueueDescriptor {
  return {
    queueName: "Kiosk A4",
    deviceUri: "ipp://printer.local/ipp/print",
    driverName: "Generic PCL6",
    portName: "IP_10.0.0.9",
    state: "READY",
    isDefault: true,
    shared: false,
    ...overrides
  };
}

/** A printer under the agent's hand, with every answer under test control. */
class StubAdapter implements PrinterAdapter {
  public readonly name = "WINDOWS";
  public queues: PrinterQueueDescriptor[] = [queue()];
  public health: PrinterHealth = { state: "READY", warningCode: null };
  public capabilities: PrinterCapabilitiesSnapshot | null = capabilities;
  public describeCalls = 0;

  public listQueues(): Promise<readonly PrinterQueueDescriptor[]> {
    return Promise.resolve(this.queues);
  }

  public describe() {
    this.describeCalls += 1;
    return Promise.resolve({
      adapter: this.name,
      queueName: "Kiosk A4",
      deviceId: "urn:uuid:1f2a",
      makeAndModel: "Kiosk Laser 400",
      driverName: "Generic PCL6",
      driverVersion: null,
      firmware: "4.2.1"
    });
  }

  public getHealth(): Promise<PrinterHealth> {
    return Promise.resolve(this.health);
  }

  public getCapabilities(): Promise<PrinterCapabilitiesSnapshot> {
    if (!this.capabilities) return Promise.reject(new Error("PRINTER_UNREACHABLE"));
    return Promise.resolve(this.capabilities);
  }

  public submit() {
    return Promise.reject(new Error("NOT_USED"));
  }

  public getOperationStatus() {
    return Promise.reject(new Error("NOT_USED"));
  }

  public cancel() {
    return Promise.reject(new Error("NOT_USED"));
  }

  public discardOutputsBefore(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface RecordedCall {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

/** The control plane, recording what the agent said and answering as told. */
class ControlPlane {
  public readonly calls: RecordedCall[] = [];
  public capabilityReportRequired = false;
  public registerStatus = 201;
  public heartbeatStatus = 200;
  public reportStatus = 200;

  public readonly fetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname;
    this.calls.push({
      path,
      method: init?.method ?? "GET",
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
    });

    if (path === "/v1/agent/register") {
      return Promise.resolve(
        this.registerStatus === 201
          ? json(201, {
              registration: {
                kioskId: "kiosk_dev_001",
                agentId,
                heartbeatIntervalSeconds: 30,
                approvedQueues: ["Kiosk A4"],
                capabilityVersion: 2,
                registeredAt: "2026-08-10T10:00:00.000Z"
              }
            })
          : json(this.registerStatus, { error: { code: "KIOSK_NOT_FOUND" } })
      );
    }
    if (path === "/v1/agent/heartbeat") {
      return Promise.resolve(
        this.heartbeatStatus === 200
          ? json(200, {
              acknowledgedAt: "2026-08-10T10:00:00.000Z",
              capabilityReportRequired: this.capabilityReportRequired,
              approvedQueues: ["Kiosk A4"],
              capabilityVersion: 2
            })
          : json(this.heartbeatStatus, { error: { code: "AGENT_NOT_REGISTERED" } })
      );
    }
    return Promise.resolve(
      this.reportStatus === 200
        ? json(200, {
            capabilitiesUpdated: true,
            capabilityVersion: 3,
            acceptedAt: "2026-08-10T10:00:00.000Z"
          })
        : json(this.reportStatus, { error: { code: "AGENT_NOT_REGISTERED" } })
    );
  };

  public pathsCalled(): string[] {
    return this.calls.map((call) => call.path);
  }

  public lastBody(path: string): Record<string, unknown> | undefined {
    return this.calls.filter((call) => call.path === path).at(-1)?.body;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let environment: Environment;

beforeEach(() => {
  environment = loadEnvironment({
    NODE_ENV: "test",
    PRINTER_QUEUE_ALLOWLIST: "Kiosk A4",
    API_ORIGIN: "http://127.0.0.1:3000"
  });
});

function buildReporter(
  adapter: PrinterAdapter,
  controlPlane: ControlPlane,
  overrides: Partial<ConstructorParameters<typeof DeviceRegistryReporter>[0]> = {}
) {
  return new DeviceRegistryReporter({
    environment,
    adapter,
    logger: { info: () => undefined, warn: () => undefined },
    agentId,
    agentVersion: "0.0.0",
    platform: "win32",
    platformRelease: "10.0.19045",
    fetch: controlPlane.fetch,
    ...overrides
  });
}

describe("DeviceRegistryReporter", () => {
  it("registers, beats and publishes what the printer can do", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();

    await buildReporter(adapter, controlPlane).runOnce();

    expect(controlPlane.pathsCalled()).toEqual([
      "/v1/agent/register",
      "/v1/agent/heartbeat",
      "/v1/agent/printers"
    ]);
    expect(controlPlane.lastBody("/v1/agent/printers")).toMatchObject({
      adapter: "WINDOWS",
      queueName: "Kiosk A4",
      approval: "APPROVED",
      health: "READY",
      makeAndModel: "Kiosk Laser 400",
      firmware: "4.2.1",
      capabilities,
      capabilityHash: capabilitySnapshotHash(capabilities)
    });
  });

  /**
   * A report is what changes the settings a customer is offered, so it goes out
   * when the printer's answer changes and not on a timer. A device that is
   * still the same device is not republished every beat.
   */
  it("does not republish an unchanged printer", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();
    const reporter = buildReporter(adapter, controlPlane);

    await reporter.runOnce();
    await reporter.runOnce();

    expect(controlPlane.pathsCalled().filter((path) => path === "/v1/agent/printers")).toHaveLength(
      1
    );
    expect(
      controlPlane.pathsCalled().filter((path) => path === "/v1/agent/heartbeat")
    ).toHaveLength(2);
  });

  it("republishes within one beat when the printer changes", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();
    const reporter = buildReporter(adapter, controlPlane);
    await reporter.runOnce();

    adapter.capabilities = { ...capabilities, duplexModes: ["SIMPLEX"] };
    await reporter.runOnce();

    expect(controlPlane.pathsCalled().filter((path) => path === "/v1/agent/printers")).toHaveLength(
      2
    );
    expect(controlPlane.lastBody("/v1/agent/printers")).toMatchObject({
      capabilities: { duplexModes: ["SIMPLEX"] }
    });
  });

  it("reports again when the control plane says its record disagrees", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();
    const reporter = buildReporter(adapter, controlPlane);
    await reporter.runOnce();
    controlPlane.capabilityReportRequired = true;

    await reporter.runOnce();

    expect(controlPlane.pathsCalled().filter((path) => path === "/v1/agent/printers")).toHaveLength(
      2
    );
  });

  /**
   * A printer nobody certified publishes nothing. Reporting it as approved
   * would let a queue a driver installer left behind become the one a paid job
   * is sent to.
   */
  it("publishes no capabilities for a queue nobody certified", async () => {
    const adapter = new StubAdapter();
    adapter.queues = [queue({ queueName: "Microsoft Print to PDF" })];
    const controlPlane = new ControlPlane();

    await buildReporter(adapter, controlPlane).runOnce();

    expect(controlPlane.lastBody("/v1/agent/printers")).toMatchObject({
      approval: "NOT_APPROVED",
      queueName: null,
      capabilities: null,
      health: "OFFLINE"
    });
    // The operator still needs to see what is installed on the machine.
    expect(controlPlane.lastBody("/v1/agent/printers")?.discovered).toHaveLength(1);
  });

  it("refuses to guess between two certified queues", async () => {
    environment = loadEnvironment({
      NODE_ENV: "test",
      PRINTER_QUEUE_ALLOWLIST: "Kiosk A4, Kiosk A4 Spare"
    });
    const adapter = new StubAdapter();
    adapter.queues = [queue(), queue({ queueName: "Kiosk A4 Spare", isDefault: false })];
    const controlPlane = new ControlPlane();

    await buildReporter(adapter, controlPlane).runOnce();

    expect(controlPlane.lastBody("/v1/agent/printers")).toMatchObject({
      approval: "AMBIGUOUS",
      capabilities: null
    });
  });

  /**
   * A printer that will not answer cannot certify itself. Leaving the previous
   * answer standing would keep selling settings for a device nobody can reach.
   */
  it("withdraws approval when the printer stops answering", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();
    const reporter = buildReporter(adapter, controlPlane);
    await reporter.runOnce();

    adapter.capabilities = null;
    await reporter.runOnce();

    expect(controlPlane.lastBody("/v1/agent/printers")).toMatchObject({
      approval: "NOT_APPROVED",
      capabilities: null,
      health: "OFFLINE"
    });
  });

  it("carries printer health and the operations it is holding on the beat", async () => {
    const adapter = new StubAdapter();
    adapter.health = { state: "WARNING", warningCode: "TONER_LOW" };
    const controlPlane = new ControlPlane();

    await buildReporter(adapter, controlPlane, { activeOperations: () => 2 }).runOnce();

    expect(controlPlane.lastBody("/v1/agent/heartbeat")).toMatchObject({
      printerHealth: "WARNING",
      activeOperations: 2,
      queueName: "Kiosk A4"
    });
  });

  /**
   * A rebuilt control plane has no record of this installation. Registering
   * again is the only way back, and it must happen without an operator
   * restarting the kiosk.
   */
  it("registers again when the control plane has forgotten it", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();
    const reporter = buildReporter(adapter, controlPlane);
    await reporter.runOnce();

    controlPlane.heartbeatStatus = 409;
    await reporter.runOnce();
    controlPlane.heartbeatStatus = 200;
    await reporter.runOnce();

    expect(controlPlane.pathsCalled().filter((path) => path === "/v1/agent/register")).toHaveLength(
      2
    );
  });

  it("keeps trying after a control plane it cannot reach", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();
    const reporter = buildReporter(adapter, controlPlane, {
      fetch: () => Promise.reject(new Error("ECONNREFUSED"))
    });

    await expect(reporter.runOnce()).resolves.toBeUndefined();

    await buildReporter(adapter, controlPlane).runOnce();
    expect(controlPlane.pathsCalled()).toContain("/v1/agent/register");
  });

  it("asks the device for its identity only when a report is going out", async () => {
    const adapter = new StubAdapter();
    const controlPlane = new ControlPlane();
    const reporter = buildReporter(adapter, controlPlane);

    await reporter.runOnce();
    await reporter.runOnce();
    await reporter.runOnce();

    expect(adapter.describeCalls).toBe(1);
  });
});
