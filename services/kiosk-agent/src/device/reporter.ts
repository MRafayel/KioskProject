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
}

interface DeviceReading {
  queues: DiscoveredPrinterQueue[];
  approval: PrinterApprovalState;
  queueName: string | null;
  health: PrinterHealthStateValue;
  warningCode: "TONER_LOW" | "PAPER_LOW" | "OUTPUT_TRAY_FULL" | null;
  capabilities: PrinterCapabilitiesSnapshot | null;
  capabilityHash: string;
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

  public constructor(private readonly options: DeviceRegistryReporterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.allowlist = parseQueueAllowlist(options.environment.PRINTER_QUEUE_ALLOWLIST);
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
        capabilityHash: NO_CAPABILITY_HASH
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
        capabilityHash: NO_CAPABILITY_HASH
      };
    }

    return {
      queues: discovered,
      approval: "APPROVED",
      queueName: selection.queue.queueName,
      health: health.state,
      warningCode: health.warningCode,
      capabilities,
      capabilityHash: capabilitySnapshotHash(capabilities)
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
      activeOperations: this.options.activeOperations?.() ?? 0
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
    this.schedule(this.interval);
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
