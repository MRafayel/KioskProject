import type { NonAdminEnvironment } from "@printing-kiosk/config";
import {
  agentHeartbeatResponseSchema,
  registerAgentResponseSchema,
  reportPrinterStateResponseSchema,
  type DiscoveredPrinterQueue,
  type PrinterApprovalState,
  type PrinterHealthStateValue
} from "@printing-kiosk/contracts";
import {
  capabilitySnapshotHash,
  parseQueueAllowlist,
  selectApprovedQueue,
  supportsQueueDiscovery,
  type PrinterAdapter,
  type PrinterCapabilitiesSnapshot,
  type PrinterQueueDescriptor
} from "@printing-kiosk/printer-adapters";

import { applyPrinterTelemetry, type PrinterTelemetrySource } from "./telemetry.js";

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 10_000;
/** The digest sent before a printer has said anything. */
const NO_CAPABILITY_HASH = "0".repeat(64);

export interface DeviceReporterLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface DeviceRegistryReporterOptions {
  environment: NonAdminEnvironment;
  adapter: PrinterAdapter;
  logger: DeviceReporterLogger;
  /** Stable per installation, so a restarted agent is the same agent. */
  agentId: string;
  agentVersion: string;
  platform: "win32" | "linux" | "darwin";
  platformRelease: string | null;
  /** How many print operations this agent is currently holding. */
  activeOperations?: () => number;
  fetch?: UpstreamFetch;
  intervalMilliseconds?: number;
  /**
   * The printer's own telemetry, when a deployment has configured it. Absent
   * leaves every reading exactly as the driver reported it.
   */
  telemetry?: PrinterTelemetrySource;
}

interface DeviceReading {
  queues: DiscoveredPrinterQueue[];
  approval: PrinterApprovalState;
  queueName: string | null;
  health: PrinterHealthStateValue;
  warningCode: "TONER_LOW" | "PAPER_LOW" | "OUTPUT_TRAY_FULL" | null;
  capabilities: PrinterCapabilitiesSnapshot | null;
  capabilityHash: string;
  /** When the telemetry behind `health` was read, or null with no link. */
  telemetryAt: string | null;
}

/**
 * The kiosk's side of the device plane.
 *
 * It exists so that two things stop being assumptions. The first is that the
 * capability row a customer's settings are validated against describes the
 * printer actually attached to this machine — so the agent re-reads the device
 * on every beat and reports the moment the answer changes, rather than at the
 * next paid print. The second is that a kiosk which has gone quiet can be told
 * apart from one that simply has nothing to print.
 *
 * It describes; it does not decide. Which queue may be printed to is an
 * operator's certification held in two places — this machine's configuration
 * and the kiosk's own record — and the control plane re-derives approval from
 * its copy whatever this reports. A queue the two do not agree on publishes
 * nothing, which is the intended outcome of a printer being swapped without
 * anybody certifying the replacement.
 *
 * Nothing here can stop the kiosk printing. Every failure is logged and the
 * next beat tries again: a control plane that cannot be reached is not a reason
 * to refuse work that is already paid for.
 */
export class DeviceRegistryReporter {
  private readonly fetch: UpstreamFetch;
  private readonly allowlist: string[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running = false;
  private registered = false;
  private reportedHash: string | null = null;
  private reportedTelemetryReason: string | null = null;

  private pendingNudge = false;

  public constructor(private readonly options: DeviceRegistryReporterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.allowlist = parseQueueAllowlist(options.environment.PRINTER_QUEUE_ALLOWLIST);
    // A tray that empties between two scheduled beats would otherwise wait out
    // the rest of the interval before the control plane heard about it, and a
    // customer reaching payment inside that window would be sold a print the
    // machine could not produce. Telemetry says when something moved; this turns
    // that into a beat now rather than a beat later.
    this.options.telemetry?.onChange(() => this.nudge());
  }

  /**
   * Bring the next beat forward.
   *
   * Coalescing rather than beating per change: several readings can move at
   * once when a job ends, and the control plane wants the settled answer, not
   * three of them. A change arriving mid-beat sets the flag instead, because
   * that beat may already have read its telemetry before the change landed.
   */
  private nudge(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingNudge = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  /** When telemetry last actually heard from the printer. */
  private telemetryAt(): string | null {
    return this.options.telemetry?.observedAt()?.toISOString() ?? null;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  public close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Public so tests can drive one beat deterministically. */
  public async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const reading = await this.readDevice();
      if (!this.registered) await this.register(reading);
      if (!this.registered) return;

      const reportRequired = await this.heartbeat(reading);
      if (reportRequired || this.reportedHash !== reading.capabilityHash) {
        await this.report(reading);
      }
    } catch (error) {
      this.options.logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "device report failed"
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * One look at the machine.
   *
   * Discovery, health and capabilities are read together so the report they
   * produce describes one moment rather than three. A device that fails any of
   * them is reported as offline with no capabilities, which withdraws its
   * approval rather than leaving a stale answer standing.
   */
  private async readDevice(): Promise<DeviceReading> {
    const queues = await this.discover();
    const selection = selectApprovedQueue(queues, {
      allowlist: this.allowlist,
      preferred: this.options.environment.PRINTER_QUEUE_NAME || null,
      allowShared: this.options.environment.PRINTER_ALLOW_SHARED_QUEUE
    });

    const discovered = queues.map(toContractQueue);
    if (!selection.approved) {
      return {
        queues: discovered,
        approval:
          selection.reason === "SHARED"
            ? "SHARED"
            : selection.reason === "AMBIGUOUS"
              ? "AMBIGUOUS"
              : "NOT_APPROVED",
        queueName: null,
        health: "OFFLINE",
        warningCode: null,
        capabilities: null,
        capabilityHash: NO_CAPABILITY_HASH,
        telemetryAt: this.telemetryAt()
      };
    }

    const health = await this.options.adapter.getHealth().catch(() => null);
    const capabilities = await this.options.adapter.getCapabilities().catch(() => null);
    if (!health || !capabilities) {
      // A printer that will not answer cannot certify itself. Its approval is
      // withdrawn rather than left standing on a stale reading.
      return {
        queues: discovered,
        approval: "NOT_APPROVED",
        queueName: null,
        health: "OFFLINE",
        warningCode: null,
        capabilities: null,
        capabilityHash: NO_CAPABILITY_HASH,
        telemetryAt: this.telemetryAt()
      };
    }

    // What the printer says about itself over its own telemetry link, folded
    // into what the driver said. Read from a cache rather than the wire: the
    // heartbeat is how the control plane knows this machine is alive, and a
    // printer that has stopped answering must not be able to delay it.
    //
    // This is the only place physical device state enters the report, and it
    // only ever makes the report worse. It is also strictly forward-looking —
    // it changes what the *next* customer is told about this kiosk and what an
    // operator sees. Nothing here reaches a job that has already been submitted.
    const telemetry = applyPrinterTelemetry(
      { health: health.state, warningCode: health.warningCode },
      this.options.telemetry?.current() ?? { kind: "DISABLED" },
      { required: this.options.environment.PRINTER_TELEMETRY_REQUIRED }
    );
    if (telemetry.reason !== null && telemetry.reason !== this.reportedTelemetryReason) {
      this.options.logger.warn(
        { queueName: selection.queue.queueName, telemetry: telemetry.reason },
        "printer telemetry changed the reported health"
      );
    }
    this.reportedTelemetryReason = telemetry.reason;

    return {
      queues: discovered,
      approval: "APPROVED",
      queueName: selection.queue.queueName,
      health: telemetry.health,
      warningCode: telemetry.warningCode,
      capabilities,
      capabilityHash: capabilitySnapshotHash(capabilities),
      telemetryAt: this.telemetryAt()
    };
  }

  /**
   * An adapter bound to one endpoint — a network printer reached over IPP — has
   * no queues to enumerate. Its own binding is the single queue it offers.
   */
  private async discover(): Promise<PrinterQueueDescriptor[]> {
    if (supportsQueueDiscovery(this.options.adapter)) {
      return [...(await this.options.adapter.listQueues())];
    }
    const binding = await this.options.adapter.describe().catch(() => null);
    if (!binding?.queueName) return [];
    return [
      {
        queueName: binding.queueName,
        deviceUri: null,
        driverName: binding.driverName,
        portName: null,
        state: "READY",
        isDefault: true,
        shared: false
      }
    ];
  }

  private async register(reading: DeviceReading): Promise<void> {
    const response = await this.request("POST", "/v1/agent/register", {
      agentId: this.options.agentId,
      agentVersion: this.options.agentVersion,
      platform: this.options.platform,
      platformRelease: this.options.platformRelease,
      adapter: adapterKind(this.options.adapter.name),
      queueName: reading.queueName
    });
    if (!response?.ok) {
      this.options.logger.warn(
        { status: response?.status ?? 0 },
        "kiosk agent could not register with the control plane"
      );
      return;
    }

    const registration = registerAgentResponseSchema.parse(await response.json()).registration;
    this.registered = true;
    // A fresh registration has published nothing yet, so the next beat always
    // reports rather than trusting a digest from before a restart.
    this.reportedHash = null;
    this.options.logger.info(
      {
        kioskId: registration.kioskId,
        adapter: this.options.adapter.name,
        queueName: reading.queueName,
        approval: reading.approval,
        capabilityVersion: registration.capabilityVersion
      },
      "kiosk agent registered"
    );
  }

  /** Returns whether the control plane asked for a fresh capability report. */
  private async heartbeat(reading: DeviceReading): Promise<boolean> {
    const response = await this.request("POST", "/v1/agent/heartbeat", {
      agentId: this.options.agentId,
      queueName: reading.queueName,
      printerHealth: reading.health,
      capabilityHash: reading.capabilityHash,
      activeOperations: this.options.activeOperations?.() ?? 0,
      telemetryAt: reading.telemetryAt
    });

    if (response?.status === 409) {
      // The control plane has no record of this installation — a rebuilt
      // database, or a kiosk whose agent row was removed. Registering again is
      // the only way back, and it happens on the next beat.
      this.registered = false;
      this.reportedHash = null;
      return false;
    }
    if (!response?.ok) {
      this.options.logger.warn({ status: response?.status ?? 0 }, "kiosk agent heartbeat failed");
      return false;
    }

    return agentHeartbeatResponseSchema.parse(await response.json()).capabilityReportRequired;
  }

  private async report(reading: DeviceReading): Promise<void> {
    // The device identity is only read when a report is actually going out, so
    // an unchanged printer is not interrogated about its firmware every beat.
    const binding = reading.capabilities
      ? await this.options.adapter.describe().catch(() => null)
      : null;

    const response = await this.request("PUT", "/v1/agent/printers", {
      agentId: this.options.agentId,
      adapter: adapterKind(this.options.adapter.name),
      queueName: reading.queueName,
      approval: reading.approval,
      deviceId: binding?.deviceId ?? null,
      makeAndModel: binding?.makeAndModel ?? null,
      driverName: binding?.driverName ?? null,
      driverVersion: binding?.driverVersion ?? null,
      firmware: binding?.firmware ?? null,
      health: reading.health,
      warningCode: reading.warningCode,
      capabilities: reading.capabilities,
      capabilityHash: reading.capabilityHash,
      discovered: reading.queues
    });

    if (response?.status === 409) {
      this.registered = false;
      this.reportedHash = null;
      return;
    }
    if (!response?.ok) {
      this.options.logger.warn(
        { status: response?.status ?? 0 },
        "kiosk agent could not report its printer"
      );
      return;
    }

    const result = reportPrinterStateResponseSchema.parse(await response.json());
    this.reportedHash = reading.capabilityHash;
    if (result.capabilitiesUpdated) {
      this.options.logger.info(
        {
          queueName: reading.queueName,
          approval: reading.approval,
          capabilityVersion: result.capabilityVersion
        },
        "printer capabilities published"
      );
    }
  }

  private async request(
    method: "POST" | "PUT",
    path: string,
    body: unknown
  ): Promise<Response | null> {
    try {
      return await this.fetch(new URL(path, this.options.environment.API_ORIGIN), {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.options.environment.DEV_KIOSK_API_KEY}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      return null;
    }
  }

  private schedule(delayMilliseconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMilliseconds);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    await this.runOnce();
    // A change that landed while the beat was in flight gets its own beat
    // straight away; that beat may have read its telemetry before the change.
    const soon = this.pendingNudge;
    this.pendingNudge = false;
    this.schedule(soon ? 0 : this.interval);
  }

  private get interval(): number {
    return (
      this.options.intervalMilliseconds ?? this.options.environment.AGENT_HEARTBEAT_SECONDS * 1_000
    );
  }
}

function toContractQueue(queue: PrinterQueueDescriptor): DiscoveredPrinterQueue {
  return {
    queueName: queue.queueName,
    deviceUri: queue.deviceUri,
    driverName: queue.driverName,
    portName: queue.portName,
    state: queue.state,
    isDefault: queue.isDefault,
    shared: queue.shared
  };
}

function adapterKind(name: string): "MOCK" | "IPP" | "WINDOWS" {
  if (name === "IPP") return "IPP";
  if (name === "WINDOWS") return "WINDOWS";
  return "MOCK";
}
