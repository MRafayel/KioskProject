import {
  mapDeviceCapabilities,
  IPP_COLOR_MODE_BY_COLOR_MODE,
  IPP_MEDIA_BY_PAPER_SIZE,
  IPP_SIDES_BY_DUPLEX_MODE
} from "../capabilities.js";
import {
  DeviceOperationJournal,
  deviceJobName,
  type DeviceOperationRecord
} from "../operation-journal.js";
import { isApprovedQueueName } from "../queues.js";
import {
  assertSubmittable,
  operationStatus,
  unknownStatus,
  withHonestConfidence
} from "../submission.js";
import {
  PrinterAdapterError,
  type PrinterAdapter,
  type PrinterBinding,
  type PrinterCapabilitiesSnapshot,
  type PrinterHealth,
  type PrinterQueueDescriptor,
  type PrinterQueueDiscovery,
  type PrintOperationStatus,
  type PrintSubmission
} from "../types.js";
import {
  DEVICE_HOST_PROTOCOL_VERSION,
  readCapabilityDeclaration,
  readDiscardCount,
  readFoundJobs,
  readHostBinding,
  readHostHealth,
  readHostResult,
  readOperationReport,
  readQueueList,
  type DeviceHostFoundJob,
  type DeviceHostOperationReport,
  type DeviceHostRequest,
  type DevicePrinterProfile
} from "./protocol.js";

/** How a request is carried to the device host. */
export interface DeviceHostTransport {
  request(request: DeviceHostRequest, options: { timeoutMilliseconds: number }): Promise<unknown>;
}

export interface WindowsPrinterAdapterOptions {
  transport: DeviceHostTransport;
  /** The queue this kiosk prints to. Checked against the allowlist on this side. */
  queueName: string;
  /** Queue names an operator certified for this kiosk. Empty approves none. */
  approvedQueues: readonly string[];
  /**
   * Printer/driver combinations an operator certified. Empty leaves the host on
   * its reference profile, which is what an unconfigured deployment expects.
   */
  approvedProfiles?: readonly DevicePrinterProfile[];
  journalDirectory: string;
  maxCopies: number;
  requestTimeoutMilliseconds?: number;
  /** How long a submission may take at the device before it is called unknown. */
  submitTimeoutMilliseconds?: number;
  now?: () => Date;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 300_000;

/**
 * The share of the submission budget the host may spend watching the queue.
 *
 * The rest pays for everything that happens before it can watch anything:
 * starting a PowerShell process, compiling the host's inline type, loading the
 * PDF renderer, rasterising the paid pages and drawing them through the driver.
 * The two numbers used to be independent constants that happened to be equal;
 * a deployment that shortened the job timeout silently started killing the host
 * mid-print and turning finished work into an unresolvable result.
 */
const HOST_OBSERVE_BUDGET_RATIO = 0.8;
const MIN_HOST_WAIT_SECONDS = 5;

export function hostWaitSeconds(submitTimeoutMilliseconds: number): number {
  return Math.max(
    MIN_HOST_WAIT_SECONDS,
    Math.floor((submitTimeoutMilliseconds * HOST_OBSERVE_BUDGET_RATIO) / 1_000)
  );
}

/**
 * A printer driven through the Windows print subsystem.
 *
 * The platform calls live in a separate host process (see `protocol.ts`); what
 * lives here is everything that must not depend on that process being correct.
 * The queue is checked against the operator's allowlist on this side, so a host
 * that offered a different printer could not be taken up on it. The intent to
 * submit is journalled here, so a host that lost its state file cannot make an
 * operation that already printed look like one that never started. And the
 * confidence the host reports is clamped against its own numbers, so a spooler
 * that considers a job finished the moment it left the queue cannot turn that
 * into a confirmed delivery.
 */
export class WindowsPrinterAdapter implements PrinterAdapter, PrinterQueueDiscovery {
  public readonly name = "WINDOWS";
  private readonly journal: DeviceOperationJournal;

  public constructor(private readonly options: WindowsPrinterAdapterOptions) {
    this.journal = new DeviceOperationJournal(options.journalDirectory);
  }

  public async listQueues(): Promise<readonly PrinterQueueDescriptor[]> {
    return readQueueList(
      await this.call({ protocol: DEVICE_HOST_PROTOCOL_VERSION, op: "list-queues" })
    );
  }

  public async describe(): Promise<PrinterBinding> {
    const binding = readHostBinding(
      await this.call({
        protocol: DEVICE_HOST_PROTOCOL_VERSION,
        op: "describe",
        queue: this.approvedQueue()
      })
    );
    return { adapter: this.name, queueName: this.options.queueName, ...binding };
  }

  public async getHealth(): Promise<PrinterHealth> {
    try {
      return readHostHealth(
        await this.call({
          protocol: DEVICE_HOST_PROTOCOL_VERSION,
          op: "health",
          queue: this.approvedQueue()
        })
      );
    } catch {
      // A host that cannot answer is a printer a customer cannot use, and
      // reporting it as offline is what keeps a session from being offered one.
      return { state: "OFFLINE", warningCode: null };
    }
  }

  public async getCapabilities(): Promise<PrinterCapabilitiesSnapshot> {
    const declaration = readCapabilityDeclaration(
      await this.call({
        protocol: DEVICE_HOST_PROTOCOL_VERSION,
        op: "capabilities",
        queue: this.approvedQueue()
      })
    );
    return mapDeviceCapabilities(declaration, { maxCopies: this.options.maxCopies });
  }

  public async submit(submission: PrintSubmission): Promise<PrintOperationStatus> {
    assertSubmittable(submission);
    const queue = this.approvedQueue();

    const media = IPP_MEDIA_BY_PAPER_SIZE[submission.manifest.paperSize];
    const colorMode = IPP_COLOR_MODE_BY_COLOR_MODE[submission.manifest.colorMode];
    if (!media || !colorMode) throw new PrinterAdapterError("MANIFEST_INVALID");

    // Asking is free and submitting is not, so the printer is asked first. A
    // refusal at this point is one the caller can trust: nothing was sent.
    const health = await this.getHealth();
    if (health.state === "OFFLINE") throw new PrinterAdapterError("PRINTER_OFFLINE", false);

    const artifacts = [...submission.artifacts].sort(
      (left, right) => left.position - right.position
    );
    const documents = artifacts.map((artifact) => {
      const settings = submission.manifest.documents.find(
        (document) => document.documentId === artifact.documentId
      );
      // assertSubmittable already proved the pairing; this is the type guard.
      if (!settings) throw new PrinterAdapterError("MANIFEST_INVALID");
      const sides = IPP_SIDES_BY_DUPLEX_MODE[settings.duplex];
      if (!sides) throw new PrinterAdapterError("MANIFEST_INVALID");
      return {
        position: artifact.position,
        path: artifact.path,
        copies: settings.copies,
        pageRanges: settings.pageRanges.map((range) => [range[0]!, range[1]!] as const),
        sides,
        jobName: deviceJobName(submission.operationId, artifact.position, artifacts.length)
      };
    });

    const record: DeviceOperationRecord = {
      operationId: submission.operationId,
      queueName: queue,
      submittedAt: (this.options.now?.() ?? new Date()).toISOString(),
      documentCount: documents.length,
      documents: documents.map((document) => ({
        position: document.position,
        jobId: null,
        jobName: document.jobName
      }))
    };
    // Durable before the device is touched. A process killed on the next line
    // still leaves evidence that something may have reached a printer.
    await this.journal.open(record);

    const submitTimeout = this.options.submitTimeoutMilliseconds ?? DEFAULT_SUBMIT_TIMEOUT_MS;
    const report = readOperationReport(
      await this.call(
        {
          protocol: DEVICE_HOST_PROTOCOL_VERSION,
          op: "submit",
          queue,
          operationId: submission.operationId,
          media,
          colorMode,
          documents,
          waitSeconds: hostWaitSeconds(submitTimeout)
        },
        submitTimeout
      )
    );

    return withHonestConfidence(operationStatus(submission.operationId, withDiagnostics(report)));
  }

  public async getOperationStatus(operationId: string): Promise<PrintOperationStatus> {
    const record = await this.journal.read(operationId);

    let report;
    try {
      report = readOperationReport(
        await this.call({
          protocol: DEVICE_HOST_PROTOCOL_VERSION,
          op: "status",
          queue: this.approvedQueue(),
          operationId
        })
      );
    } catch {
      // A host that cannot be asked leaves the outcome open — unless this
      // machine never recorded an intent, in which case there is nothing open.
      return record ? unknownStatus(operationId) : notSubmitted(operationId);
    }

    // The host says the spooler has no record. If this machine wrote one, the
    // job history was purged or the host lost its state, and neither of those
    // is evidence that nothing printed.
    //
    // Before settling for that, ask the queue directly. Every job is named for
    // its operation, so the queue can answer where the host's own notes cannot.
    if (report.state === "NOT_SUBMITTED" && record) {
      const found = await this.findQueuedJobs(operationId);
      // Still in the queue and not in trouble: the work is open, not lost. That
      // keeps the caller waiting instead of sending a healthy print to a person.
      if (found.length > 0 && !found.some((job) => job.faulted)) {
        return operationStatus(operationId, {
          state: "PRINTING",
          confidence: "UNCONFIRMED",
          failureCode: null,
          sheetsProduced: null,
          deviceDiagnostics: {
            queueName: this.options.queueName,
            pollCount: null,
            processStartMs: null,
            phaseMs: {},
            jobs: found.map((job) => ({
              position: job.position,
              jobId: job.jobId,
              present: true,
              observed: true,
              completed: false,
              faulted: job.faulted,
              status: job.status,
              pagesPrinted: 0,
              expectedPages: 0,
              expectedSheets: 0
            })),
            stage: "status.found-by-job-name"
          }
        });
      }
      // Nothing there, or something faulted. Neither can be read as "nothing
      // printed": Windows deletes a job the moment it retires, so an empty queue
      // looks identical whether the paper came out or the job never existed.
      return unknownStatus(operationId);
    }

    return withHonestConfidence(operationStatus(operationId, withDiagnostics(report)));
  }

  /**
   * Ask the queue which entries still carry this operation's name.
   *
   * Read-only and best-effort. It never reconstructs the host's lost state file
   * — doing that would mean inventing how many sheets were expected, and a
   * guess there is exactly what turns an ambiguous outcome into a wrong one.
   */
  private async findQueuedJobs(operationId: string): Promise<DeviceHostFoundJob[]> {
    try {
      return readFoundJobs(
        await this.call({
          protocol: DEVICE_HOST_PROTOCOL_VERSION,
          op: "find",
          queue: this.approvedQueue(),
          operationId
        })
      );
    } catch {
      // An older host does not know this operation, and a broken one is why we
      // are here. Either way the caller falls back to the ambiguous answer.
      return [];
    }
  }

  public async cancel(operationId: string): Promise<PrintOperationStatus> {
    const record = await this.journal.read(operationId);

    let report;
    try {
      report = readOperationReport(
        await this.call({
          protocol: DEVICE_HOST_PROTOCOL_VERSION,
          op: "cancel",
          queue: this.approvedQueue(),
          operationId
        })
      );
    } catch {
      if (!record) {
        return operationStatus(operationId, {
          state: "CANCELED",
          confidence: "CONFIRMED",
          failureCode: "CANCELED_BEFORE_SUBMIT",
          sheetsProduced: 0
        });
      }
      return unknownStatus(operationId);
    }

    if (report.state === "NOT_SUBMITTED" && !record) {
      return operationStatus(operationId, {
        state: "CANCELED",
        confidence: "CONFIRMED",
        failureCode: "CANCELED_BEFORE_SUBMIT",
        sheetsProduced: 0
      });
    }
    if (report.state === "COMPLETED") {
      return withHonestConfidence(operationStatus(operationId, withDiagnostics(report)));
    }

    // Work already at the device may have put ink on paper before the stop took
    // effect, so cancellation cannot claim otherwise.
    return withHonestConfidence(
      operationStatus(operationId, {
        state: "CANCELED",
        confidence: report.confidence,
        failureCode: report.failureCode ?? "CANCELED_AT_DEVICE",
        warningCode: report.warningCode,
        sheetsProduced: report.sheetsProduced
      })
    );
  }

  /**
   * Both sides hold a copy of what was printed: the host's spooler state and
   * this machine's journal. Sweeping one without the other would leave the
   * other answering for a customer's document past its retention window.
   */
  public async discardOutputsBefore(cutoff: Date): Promise<number> {
    const hostDiscarded = readDiscardCount(
      await this.call({
        protocol: DEVICE_HOST_PROTOCOL_VERSION,
        op: "discard",
        before: cutoff.toISOString()
      })
    );
    const journalDiscarded = await this.journal.discardBefore(cutoff);
    // The two count the same operations from different sides; the larger is the
    // number of operations that still had something to remove anywhere.
    return Math.max(hostDiscarded, journalDiscarded);
  }

  /**
   * The queue name is re-checked against the allowlist on every call rather
   * than once at construction. Approval is operator policy, and a policy that
   * was only ever enforced at startup is one a configuration reload can drop.
   */
  private approvedQueue(): string {
    if (!isApprovedQueueName(this.options.queueName, this.options.approvedQueues)) {
      throw new PrinterAdapterError("QUEUE_NOT_APPROVED");
    }
    return this.options.queueName;
  }

  private async call(request: DeviceHostRequest, timeoutMilliseconds?: number): Promise<unknown> {
    let response: unknown;
    // Attached here rather than at each call site: every operation that reaches
    // a queue goes through this method, so this is the one place that can be
    // wrong about which printers a deployment certified.
    const profiles = this.options.approvedProfiles;
    const outbound: DeviceHostRequest =
      profiles && profiles.length > 0 ? { ...request, profiles } : request;
    try {
      response = await this.options.transport.request(outbound, {
        timeoutMilliseconds:
          timeoutMilliseconds ??
          this.options.requestTimeoutMilliseconds ??
          DEFAULT_REQUEST_TIMEOUT_MS
      });
    } catch (error) {
      if (error instanceof PrinterAdapterError) throw error;
      // The host went away mid-call. Whether it had already reached the spooler
      // is exactly what nobody can say, so the ambiguity is preserved.
      throw new PrinterAdapterError("DEVICE_UNREACHABLE", request.op === "submit");
    }
    return readHostResult(response);
  }
}

/**
 * Carry the device's own account of an operation onto the status.
 *
 * It is evidence, never a decision: the state, the confidence and the sheet
 * count are settled before this is attached, and nothing downstream reads it to
 * decide anything. It exists so an operator can see which spooler job an
 * outcome refers to, and where the time went, without opening the kiosk.
 */
function withDiagnostics(
  report: DeviceHostOperationReport
): Omit<PrintOperationStatus, "operationId"> {
  return {
    state: report.state,
    confidence: report.confidence,
    failureCode: report.failureCode,
    warningCode: report.warningCode,
    sheetsProduced: report.sheetsProduced,
    ...(report.diagnostics ? { deviceDiagnostics: report.diagnostics } : {})
  };
}

function notSubmitted(operationId: string): PrintOperationStatus {
  return operationStatus(operationId, {
    state: "NOT_SUBMITTED",
    confidence: "CONFIRMED",
    failureCode: null,
    sheetsProduced: 0
  });
}
