import { readFile } from "node:fs/promises";

import {
  mapDeviceCapabilities,
  IPP_COLOR_MODE_BY_COLOR_MODE,
  IPP_MEDIA_BY_PAPER_SIZE,
  IPP_SIDES_BY_DUPLEX_MODE
} from "../capabilities.js";
import {
  DeviceOperationJournal,
  deviceJobName,
  parseDeviceJobName,
  type DeviceOperationRecord
} from "../operation-journal.js";
import { assertSubmittable, operationStatus, unknownStatus } from "../submission.js";
import {
  PrinterAdapterError,
  type PrintFailureCode,
  type PrinterAdapter,
  type PrinterBinding,
  type PrinterCapabilitiesSnapshot,
  type PrinterHealth,
  type PrintOperationStatus,
  type PrintSubmission,
  type PrintWarningCode
} from "../types.js";
import {
  decodeIppResponse,
  encodeIppRequest,
  enumAttribute,
  findAttribute,
  integerAttribute,
  IPP_DELIMITER,
  IPP_JOB_STATE,
  IPP_OPERATION,
  IPP_PRINTER_STATE,
  IPP_STATUS_CLIENT_ERROR,
  IppProtocolError,
  keywordAttribute,
  mimeTypeAttribute,
  nameAttribute,
  operationPreamble,
  readIntegerAttribute,
  readStringAttribute,
  readStringListAttribute,
  uriAttribute,
  type IppAttribute,
  type IppResponse
} from "./encoding.js";

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 240_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** An IPP response is attributes, never a document. Anything larger is wrong. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** How many queue entries a listing may return before it is refused. */
const GET_JOBS_LIMIT = 500;
/**
 * The user a job is submitted as. It is the kiosk, never the customer: IPP
 * puts this string on the device's display and in its job log.
 */
const REQUESTING_USER_NAME = "printing-kiosk-agent";

export interface IppPrinterAdapterOptions {
  /** `ipp://`, `ipps://`, `http://` or `https://`, pointing at one queue. */
  printerUri: string;
  /** The queue name an operator certified. Reported, never derived from the device. */
  queueName: string;
  /** Where the submission journal is kept. See DeviceOperationJournal. */
  journalDirectory: string;
  /** The deployment's copy ceiling. A device may never raise it. */
  maxCopies: number;
  fetch?: UpstreamFetch;
  requestTimeoutMilliseconds?: number;
  completionTimeoutMilliseconds?: number;
  pollIntervalMilliseconds?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * A printer reached over IPP.
 *
 * The whole design turns on one asymmetry: submitting is irreversible and
 * asking is not. So the order is always ask, record, submit, and never the
 * reverse. Before a single byte is sent the device is asked whether it is
 * accepting work and whether it takes PDF, because a refusal at that point
 * proves nothing was printed. The intent is then journalled locally, because a
 * queue that has purged its history answers a status query exactly the way a
 * queue that never saw the job does — and only the journal separates a job
 * that is safe to submit from a job that must never be submitted again.
 *
 * One operation becomes one device job per document. Copies and duplex belong
 * to a document in this product and to a job in IPP, so a single job could not
 * carry a manifest whose documents differ. Each is named after the operation,
 * its position, and the number of documents the operation has, which is what
 * makes a bare queue listing enough to tell a complete operation from a partial
 * one after any restart on either side.
 */
export class IppPrinterAdapter implements PrinterAdapter {
  public readonly name = "IPP";
  private readonly journal: DeviceOperationJournal;
  private readonly fetch: UpstreamFetch;
  private readonly endpoint: URL;
  private readonly printerUri: string;
  private requestId = 0;

  public constructor(private readonly options: IppPrinterAdapterOptions) {
    this.journal = new DeviceOperationJournal(options.journalDirectory);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.endpoint = httpEndpoint(options.printerUri);
    this.printerUri = options.printerUri;
  }

  public async describe(): Promise<PrinterBinding> {
    const response = await this.getPrinterAttributes([
      "printer-make-and-model",
      "printer-uuid",
      "printer-firmware-string-version",
      "printer-device-id",
      "printer-name"
    ]);
    return {
      adapter: this.name,
      queueName: this.options.queueName,
      deviceId:
        readStringAttribute(response, IPP_DELIMITER.PRINTER_ATTRIBUTES, "printer-uuid") ??
        readStringAttribute(response, IPP_DELIMITER.PRINTER_ATTRIBUTES, "printer-device-id"),
      makeAndModel: readStringAttribute(
        response,
        IPP_DELIMITER.PRINTER_ATTRIBUTES,
        "printer-make-and-model"
      ),
      driverName: null,
      firmware: readStringAttribute(
        response,
        IPP_DELIMITER.PRINTER_ATTRIBUTES,
        "printer-firmware-string-version"
      )
    };
  }

  public async getHealth(): Promise<PrinterHealth> {
    let response: IppResponse;
    try {
      response = await this.getPrinterAttributes(["printer-state", "printer-state-reasons"]);
    } catch {
      // A device that cannot be reached is offline as far as a customer is
      // concerned, and saying so is what stops a session from being offered
      // settings for a printer that is not there.
      return { state: "OFFLINE", warningCode: null };
    }
    return readHealth(response);
  }

  public async getCapabilities(): Promise<PrinterCapabilitiesSnapshot> {
    const response = await this.getPrinterAttributes([
      "media-ready",
      "media-supported",
      "sides-supported",
      "print-color-mode-supported",
      "copies-supported"
    ]);

    // What is loaded beats what is possible: a tray holding Letter cannot print
    // the A4 a customer just paid for, however capable the model is. A device
    // that does not report its trays at all is the only case where what the
    // model supports is the best answer available.
    const ready = readStringListAttribute(
      response,
      IPP_DELIMITER.PRINTER_ATTRIBUTES,
      "media-ready"
    );
    const supported = readStringListAttribute(
      response,
      IPP_DELIMITER.PRINTER_ATTRIBUTES,
      "media-supported"
    );

    return mapDeviceCapabilities(
      {
        mediaSizes: ready.length > 0 ? ready : supported,
        sides: readStringListAttribute(
          response,
          IPP_DELIMITER.PRINTER_ATTRIBUTES,
          "sides-supported"
        ),
        colorModes: readStringListAttribute(
          response,
          IPP_DELIMITER.PRINTER_ATTRIBUTES,
          "print-color-mode-supported"
        ),
        maxCopies: readIntegerAttribute(
          response,
          IPP_DELIMITER.PRINTER_ATTRIBUTES,
          "copies-supported"
        )
      },
      { maxCopies: this.options.maxCopies }
    );
  }

  public async submit(submission: PrintSubmission): Promise<PrintOperationStatus> {
    assertSubmittable(submission);

    const media = IPP_MEDIA_BY_PAPER_SIZE[submission.manifest.paperSize];
    const colorMode = IPP_COLOR_MODE_BY_COLOR_MODE[submission.manifest.colorMode];
    if (!media || !colorMode) throw new PrinterAdapterError("MANIFEST_INVALID");

    // Everything below this line happens before the device holds anything, so a
    // refusal here is a refusal the caller can trust: nothing was printed.
    await this.assertReadyForPdf();

    const documents = [...submission.artifacts].sort(
      (left, right) => left.position - right.position
    );
    const record: DeviceOperationRecord = {
      operationId: submission.operationId,
      queueName: this.options.queueName,
      submittedAt: this.now().toISOString(),
      documentCount: documents.length,
      documents: documents.map((artifact) => ({
        position: artifact.position,
        jobId: null,
        jobName: deviceJobName(submission.operationId, artifact.position, documents.length)
      }))
    };
    await this.journal.open(record);

    let submitted = 0;
    for (const artifact of documents) {
      const settings = submission.manifest.documents.find(
        (document) => document.documentId === artifact.documentId
      );
      // assertSubmittable already proved the pairing; this is the type guard.
      if (!settings) throw new PrinterAdapterError("MANIFEST_INVALID");

      let bytes: Uint8Array;
      try {
        bytes = await readFile(artifact.path);
      } catch {
        // A spooled file that vanished before the first document reached the
        // device leaves nothing printed; after that it is ambiguous.
        throw new PrinterAdapterError("ARTIFACT_UNAVAILABLE", submitted > 0);
      }
      if (bytes.byteLength !== artifact.sizeBytes) {
        throw new PrinterAdapterError("ARTIFACT_UNAVAILABLE", submitted > 0);
      }

      const sides = IPP_SIDES_BY_DUPLEX_MODE[settings.duplex];
      if (!sides) throw new PrinterAdapterError("MANIFEST_INVALID");

      const jobName = deviceJobName(submission.operationId, artifact.position, documents.length);
      let response: IppResponse;
      try {
        response = await this.call(
          IPP_OPERATION.PRINT_JOB,
          [
            {
              tag: IPP_DELIMITER.OPERATION_ATTRIBUTES,
              attributes: [
                ...operationPreamble(),
                uriAttribute("printer-uri", this.printerUri),
                nameAttribute("requesting-user-name", REQUESTING_USER_NAME),
                nameAttribute("job-name", jobName),
                mimeTypeAttribute("document-format", "application/pdf")
              ]
            },
            {
              tag: IPP_DELIMITER.JOB_ATTRIBUTES,
              attributes: [
                integerAttribute("copies", settings.copies),
                keywordAttribute("sides", sides),
                keywordAttribute("media", media),
                keywordAttribute("print-color-mode", colorMode),
                // The normalized PDF is already the exact page geometry the
                // customer paid for. A device left to its own scaling default
                // would quietly add margins to it.
                keywordAttribute("print-scaling", "none"),
                enumAttribute("orientation-requested", ORIENTATION_PORTRAIT)
              ]
            }
          ],
          bytes
        );
      } catch (error) {
        // The first document is the only one whose refusal is unambiguous, and
        // only when the device answered rather than went quiet.
        const ambiguous = submitted > 0 || !(error instanceof IppStatusError);
        throw new PrinterAdapterError(submissionFailureCode(error), ambiguous);
      }

      const jobId = readIntegerAttribute(response, IPP_DELIMITER.JOB_ATTRIBUTES, "job-id");
      if (jobId !== null) {
        await this.journal.recordJobId(submission.operationId, artifact.position, String(jobId));
      }
      submitted += 1;
    }

    return this.awaitCompletion(submission.operationId, documents.length);
  }

  public async getOperationStatus(operationId: string): Promise<PrintOperationStatus> {
    const record = await this.journal.read(operationId);
    let jobs: DeviceJob[];
    try {
      jobs = await this.listOperationJobs(operationId);
    } catch {
      // A device that cannot be asked leaves the outcome open. If this machine
      // never recorded an intent there is still nothing to be ambiguous about.
      return record
        ? unknownStatus(operationId)
        : operationStatus(operationId, {
            state: "NOT_SUBMITTED",
            confidence: "CONFIRMED",
            failureCode: null,
            sheetsProduced: 0
          });
    }

    if (jobs.length === 0) {
      if (!record) {
        return operationStatus(operationId, {
          state: "NOT_SUBMITTED",
          confidence: "CONFIRMED",
          failureCode: null,
          sheetsProduced: 0
        });
      }
      // This machine started a submission and the queue has no memory of it.
      // That is exactly the shape a purged job history takes, and calling it
      // "never submitted" is what would print a paid job a second time.
      return unknownStatus(operationId);
    }

    const expected = Math.max(record?.documentCount ?? 0, jobs[0]!.documentCount);
    return aggregateJobs(operationId, expected, jobs, null);
  }

  public async cancel(operationId: string): Promise<PrintOperationStatus> {
    const record = await this.journal.read(operationId);
    const jobs = await this.listOperationJobs(operationId).catch(() => [] as DeviceJob[]);

    if (!record && jobs.length === 0) {
      return operationStatus(operationId, {
        state: "CANCELED",
        confidence: "CONFIRMED",
        failureCode: "CANCELED_BEFORE_SUBMIT",
        sheetsProduced: 0
      });
    }

    for (const job of jobs) {
      if (isTerminalJobState(job.state)) continue;
      // A job that finished between the listing and the cancel answers with a
      // refusal, and that is not an error worth failing the whole cancellation
      // over — the next status read reports what actually happened.
      await this.cancelJob(job.jobId).catch(() => undefined);
    }

    const after = await this.listOperationJobs(operationId).catch(() => jobs);
    if (after.length === 0) return unknownStatus(operationId);

    const expected = Math.max(record?.documentCount ?? 0, after[0]!.documentCount);
    const aggregated = aggregateJobs(operationId, expected, after, null);
    if (aggregated.state === "COMPLETED" || aggregated.state === "CANCELED") return aggregated;

    // Work already at the device may have put ink on paper before the stop took
    // effect, so cancellation cannot claim otherwise.
    return operationStatus(operationId, {
      state: "CANCELED",
      confidence: "UNCONFIRMED",
      failureCode: "CANCELED_AT_DEVICE",
      sheetsProduced: aggregated.sheetsProduced
    });
  }

  /**
   * A device job is deleted by the queue itself; what this prunes is the local
   * record of what was handed over. Past the job's own deadline no redelivery
   * can arrive to be resolved against it, so it is only a note about a
   * customer's session that no longer needs to exist.
   */
  public discardOutputsBefore(cutoff: Date): Promise<number> {
    return this.journal.discardBefore(cutoff);
  }

  /** Whether the device is accepting work at all, and whether it takes PDF. */
  private async assertReadyForPdf(): Promise<void> {
    let response: IppResponse;
    try {
      response = await this.getPrinterAttributes([
        "printer-state",
        "printer-state-reasons",
        "printer-is-accepting-jobs",
        "document-format-supported"
      ]);
    } catch (error) {
      // Nothing has been sent, so an unreachable device is a clean refusal.
      throw new PrinterAdapterError(
        error instanceof IppStatusError ? "DEVICE_ERROR" : "DEVICE_UNREACHABLE",
        false
      );
    }

    const health = readHealth(response);
    const accepting = findAttribute(
      response,
      IPP_DELIMITER.PRINTER_ATTRIBUTES,
      "printer-is-accepting-jobs"
    )?.values[0];
    if (health.state === "OFFLINE" || accepting === false) {
      throw new PrinterAdapterError("PRINTER_OFFLINE", false);
    }

    const formats = readStringListAttribute(
      response,
      IPP_DELIMITER.PRINTER_ATTRIBUTES,
      "document-format-supported"
    ).map((format) => format.toLowerCase());
    // A queue that cannot take PDF would silently print the file as text. It is
    // a certification failure, not a runtime condition, and it is refused
    // before anything is sent rather than discovered on paper.
    if (formats.length > 0 && !formats.includes("application/pdf")) {
      throw new PrinterAdapterError("DEVICE_ERROR", false);
    }
  }

  /** Poll until every job of the operation is terminal or the budget is spent. */
  private async awaitCompletion(
    operationId: string,
    documentCount: number
  ): Promise<PrintOperationStatus> {
    const deadline =
      this.now().getTime() +
      (this.options.completionTimeoutMilliseconds ?? DEFAULT_COMPLETION_TIMEOUT_MS);
    const interval = this.options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MS;

    while (true) {
      let jobs: DeviceJob[];
      try {
        jobs = await this.listOperationJobs(operationId);
      } catch {
        // The work is at the device and the device stopped answering. Both are
        // true at once, and only reporting the ambiguity is honest.
        return unknownStatus(operationId);
      }

      const settled =
        jobs.length >= documentCount && jobs.every((job) => isTerminalJobState(job.state));
      if (settled) {
        const warning = await this.readWarning();
        return aggregateJobs(operationId, documentCount, jobs, warning);
      }

      if (this.now().getTime() >= deadline) {
        return operationStatus(operationId, {
          state: "UNKNOWN",
          confidence: "UNCONFIRMED",
          failureCode: "DEVICE_TIMEOUT",
          sheetsProduced: null
        });
      }
      await this.sleep(interval);
    }
  }

  private async readWarning(): Promise<PrintWarningCode | null> {
    try {
      const response = await this.getPrinterAttributes(["printer-state", "printer-state-reasons"]);
      return readHealth(response).warningCode;
    } catch {
      return null;
    }
  }

  private async listOperationJobs(operationId: string): Promise<DeviceJob[]> {
    const response = await this.call(IPP_OPERATION.GET_JOBS, [
      {
        tag: IPP_DELIMITER.OPERATION_ATTRIBUTES,
        attributes: [
          ...operationPreamble(),
          uriAttribute("printer-uri", this.printerUri),
          nameAttribute("requesting-user-name", REQUESTING_USER_NAME),
          // Completed jobs are the ones that answer "did this already print?",
          // so the listing has to include them rather than only what is queued.
          keywordAttribute("which-jobs", "all"),
          integerAttribute("limit", GET_JOBS_LIMIT),
          keywordAttribute("requested-attributes", [
            "job-id",
            "job-name",
            "job-state",
            "job-state-reasons",
            "job-media-sheets-completed"
          ])
        ]
      }
    ]);

    const jobs: DeviceJob[] = [];
    const wanted = operationId.toLowerCase();
    for (const group of response.groups) {
      if (group.tag !== IPP_DELIMITER.JOB_ATTRIBUTES) continue;
      const job = readDeviceJob(group.attributes);
      if (job && job.operationId === wanted) jobs.push(job);
    }
    // One position, one job. A device that reports the same job twice — or a
    // retry that somehow produced two — must not have its sheets counted twice.
    const byPosition = new Map<number, DeviceJob>();
    for (const job of jobs) {
      const existing = byPosition.get(job.position);
      if (!existing || rankJobState(job.state) > rankJobState(existing.state)) {
        byPosition.set(job.position, job);
      }
    }
    return [...byPosition.values()].sort((left, right) => left.position - right.position);
  }

  private async cancelJob(jobId: string): Promise<void> {
    await this.call(IPP_OPERATION.CANCEL_JOB, [
      {
        tag: IPP_DELIMITER.OPERATION_ATTRIBUTES,
        attributes: [
          ...operationPreamble(),
          uriAttribute("printer-uri", this.printerUri),
          integerAttribute("job-id", Number(jobId)),
          nameAttribute("requesting-user-name", REQUESTING_USER_NAME)
        ]
      }
    ]);
  }

  private getPrinterAttributes(requested: readonly string[]): Promise<IppResponse> {
    return this.call(IPP_OPERATION.GET_PRINTER_ATTRIBUTES, [
      {
        tag: IPP_DELIMITER.OPERATION_ATTRIBUTES,
        attributes: [
          ...operationPreamble(),
          uriAttribute("printer-uri", this.printerUri),
          nameAttribute("requesting-user-name", REQUESTING_USER_NAME),
          keywordAttribute("requested-attributes", [...requested])
        ]
      }
    ]);
  }

  private async call(
    operation: number,
    groups: readonly { tag: number; attributes: IppAttribute[] }[],
    data?: Uint8Array
  ): Promise<IppResponse> {
    this.requestId = (this.requestId % 0x7fffffff) + 1;
    const requestId = this.requestId;
    const body = encodeIppRequest({ operation, requestId, groups, ...(data ? { data } : {}) });

    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/ipp", accept: "application/ipp" },
        body,
        signal: AbortSignal.timeout(
          this.options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MS
        )
      });
    } catch {
      throw new IppTransportError();
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new IppTransportError();
    }

    const bytes = await readBounded(response.body, MAX_RESPONSE_BYTES).catch(() => {
      throw new IppTransportError();
    });

    let decoded: IppResponse;
    try {
      decoded = decodeIppResponse(bytes);
    } catch (error) {
      throw error instanceof IppProtocolError ? new IppTransportError() : error;
    }
    // A reply carrying somebody else's request identifier is not this call's
    // answer, and treating it as one would attribute another job's state here.
    if (decoded.requestId !== requestId) throw new IppTransportError();
    if (decoded.statusCode >= IPP_STATUS_CLIENT_ERROR) {
      throw new IppStatusError(decoded.statusCode);
    }
    return decoded;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private sleep(milliseconds: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(milliseconds);
    return new Promise((resolveSleep) => {
      const timer = setTimeout(resolveSleep, milliseconds);
      timer.unref?.();
    });
  }
}

/** IPP orientation-requested: 3 is portrait. The PDF already carries rotation. */
const ORIENTATION_PORTRAIT = 3;

/** The device answered and refused. Nothing was accepted. */
export class IppStatusError extends Error {
  public constructor(public readonly statusCode: number) {
    super(`IPP_STATUS_${statusCode.toString(16)}`);
    this.name = "IppStatusError";
  }
}

/** The device did not answer, or answered with something that is not IPP. */
export class IppTransportError extends Error {
  public constructor() {
    super("IPP_TRANSPORT_FAILED");
    this.name = "IppTransportError";
  }
}

interface DeviceJob {
  jobId: string;
  operationId: string;
  position: number;
  documentCount: number;
  state: number;
  reasons: string[];
  sheetsCompleted: number | null;
}

function readDeviceJob(attributes: readonly IppAttribute[]): DeviceJob | null {
  const byName = new Map(attributes.map((attribute) => [attribute.name, attribute] as const));
  const jobId = byName.get("job-id")?.values[0];
  const jobName = byName.get("job-name")?.values[0];
  const state = byName.get("job-state")?.values[0];
  if (typeof jobId !== "number" || typeof jobName !== "string" || typeof state !== "number") {
    return null;
  }
  const parsed = parseDeviceJobName(jobName);
  if (!parsed) return null;

  const sheets = byName.get("job-media-sheets-completed")?.values[0];
  return {
    jobId: String(jobId),
    operationId: parsed.operationId,
    position: parsed.position,
    documentCount: parsed.documentCount,
    state,
    reasons: (byName.get("job-state-reasons")?.values ?? []).filter(
      (value): value is string => typeof value === "string"
    ),
    sheetsCompleted:
      typeof sheets === "number" && Number.isSafeInteger(sheets) && sheets >= 0 ? sheets : null
  };
}

function isTerminalJobState(state: number): boolean {
  return (
    state === IPP_JOB_STATE.CANCELED ||
    state === IPP_JOB_STATE.ABORTED ||
    state === IPP_JOB_STATE.COMPLETED
  );
}

/** Which of two reports for one position is the later word on it. */
function rankJobState(state: number): number {
  return isTerminalJobState(state) ? 2 : 1;
}

/**
 * One answer for the whole operation.
 *
 * Every rule here refuses to round up. A document the queue cannot account for
 * makes the operation unknown rather than complete; a sheet count missing from
 * any one job makes the total unknown rather than a sum of what did report; and
 * a terminal failure is only a confirmed failure when every job proved that no
 * sheet was produced.
 */
function aggregateJobs(
  operationId: string,
  expected: number,
  jobs: readonly DeviceJob[],
  warningCode: PrintWarningCode | null
): PrintOperationStatus {
  if (jobs.length < expected) {
    return operationStatus(operationId, {
      state: "UNKNOWN",
      confidence: "UNCONFIRMED",
      failureCode: "SUBMISSION_UNCONFIRMED",
      warningCode,
      sheetsProduced: null
    });
  }

  if (jobs.some((job) => !isTerminalJobState(job.state))) {
    return operationStatus(operationId, {
      state: "PRINTING",
      confidence: "UNCONFIRMED",
      failureCode: null,
      warningCode,
      sheetsProduced: null
    });
  }

  const sheets = jobs.every((job) => job.sheetsCompleted !== null)
    ? jobs.reduce((total, job) => total + (job.sheetsCompleted ?? 0), 0)
    : null;
  const failureCode = jobs.map((job) => failureFromReasons(job.reasons)).find(Boolean) ?? null;

  if (jobs.some((job) => job.state === IPP_JOB_STATE.ABORTED)) {
    return operationStatus(operationId, {
      state: "FAILED",
      confidence: sheets === 0 ? "CONFIRMED" : "UNCONFIRMED",
      failureCode: failureCode ?? "DEVICE_ERROR",
      warningCode,
      sheetsProduced: sheets
    });
  }

  if (jobs.some((job) => job.state === IPP_JOB_STATE.CANCELED)) {
    return operationStatus(operationId, {
      state: "CANCELED",
      confidence: sheets === 0 ? "CONFIRMED" : "UNCONFIRMED",
      failureCode: failureCode ?? "CANCELED_AT_DEVICE",
      warningCode,
      sheetsProduced: sheets
    });
  }

  // Every job completed. The device's own sheet count is the only thing that
  // makes this a confirmed success rather than a queue that stopped complaining.
  if (sheets !== null && sheets > 0) {
    return operationStatus(operationId, {
      state: "COMPLETED",
      confidence: "CONFIRMED",
      failureCode: null,
      warningCode,
      sheetsProduced: sheets
    });
  }
  return operationStatus(operationId, {
    state: "COMPLETED",
    confidence: "UNCONFIRMED",
    failureCode: null,
    warningCode,
    sheetsProduced: sheets
  });
}

const JOB_FAILURE_REASONS: Readonly<Record<string, PrintFailureCode>> = {
  "job-canceled-by-user": "CANCELED_AT_DEVICE",
  "job-canceled-by-operator": "CANCELED_AT_DEVICE",
  "job-canceled-at-device": "CANCELED_AT_DEVICE",
  "media-jam": "PAPER_JAM",
  jam: "PAPER_JAM",
  "media-empty": "OUT_OF_PAPER",
  "media-needed": "OUT_OF_PAPER",
  "input-media-supply-empty": "OUT_OF_PAPER",
  "door-open": "COVER_OPEN",
  "cover-open": "COVER_OPEN",
  "printer-stopped": "PRINTER_OFFLINE",
  "printer-stopped-partly": "PRINTER_OFFLINE",
  "job-restartable": "DEVICE_ERROR",
  "aborted-by-system": "DEVICE_ERROR",
  "unsupported-document-format": "DEVICE_ERROR",
  "document-format-error": "DEVICE_ERROR"
};

function failureFromReasons(reasons: readonly string[]): PrintFailureCode | null {
  for (const reason of reasons) {
    const known = JOB_FAILURE_REASONS[reason.trim().toLowerCase()];
    if (known) return known;
  }
  return null;
}

const OFFLINE_PRINTER_REASONS = new Set([
  "media-jam",
  "jam",
  "media-empty",
  "media-needed",
  "input-media-supply-empty",
  "door-open",
  "cover-open",
  "shutdown",
  "paused",
  "moving-to-paused",
  "offline",
  "spool-area-full",
  "output-area-full",
  "toner-empty",
  "marker-supply-empty"
]);

const WARNING_PRINTER_REASONS: Readonly<Record<string, PrintWarningCode>> = {
  "toner-low": "TONER_LOW",
  "marker-supply-low": "TONER_LOW",
  "media-low": "PAPER_LOW",
  "input-media-supply-low": "PAPER_LOW",
  "output-area-almost-full": "OUTPUT_TRAY_FULL"
};

function readHealth(response: IppResponse): PrinterHealth {
  const state = readIntegerAttribute(response, IPP_DELIMITER.PRINTER_ATTRIBUTES, "printer-state");
  const reasons = readStringListAttribute(
    response,
    IPP_DELIMITER.PRINTER_ATTRIBUTES,
    "printer-state-reasons"
    // A reason may carry a severity suffix — `toner-low-warning`. The severity
    // is the device's opinion of how bad it is; the condition is what matters.
  ).map((reason) =>
    reason
      .trim()
      .toLowerCase()
      .replace(/-(report|warning|error)$/u, "")
  );

  let warningCode: PrintWarningCode | null = null;
  for (const reason of reasons) {
    if (OFFLINE_PRINTER_REASONS.has(reason)) return { state: "OFFLINE", warningCode: null };
    warningCode ??= WARNING_PRINTER_REASONS[reason] ?? null;
  }

  if (state === IPP_PRINTER_STATE.STOPPED) return { state: "OFFLINE", warningCode: null };
  if (state === null) return { state: "OFFLINE", warningCode: null };
  return warningCode ? { state: "WARNING", warningCode } : { state: "READY", warningCode: null };
}

function submissionFailureCode(
  error: unknown
): "PRINTER_OFFLINE" | "DEVICE_ERROR" | "DEVICE_UNREACHABLE" {
  if (error instanceof IppTransportError) return "DEVICE_UNREACHABLE";
  if (error instanceof IppStatusError) {
    // 0x0501 is server-error-not-accepting-jobs; 0x0507 is service-unavailable.
    return error.statusCode === 0x0501 || error.statusCode === 0x0507
      ? "PRINTER_OFFLINE"
      : "DEVICE_ERROR";
  }
  return "DEVICE_ERROR";
}

/**
 * `ipp://` and `ipps://` are HTTP and HTTPS with a default port of 631. A
 * printer URI is configuration, so a scheme this does not understand is a
 * startup failure rather than something to coerce.
 */
export function httpEndpoint(printerUri: string): URL {
  const url = new URL(printerUri);
  if (url.protocol === "ipp:") {
    url.protocol = "http:";
    if (!url.port) url.port = "631";
  } else if (url.protocol === "ipps:") {
    url.protocol = "https:";
    if (!url.port) url.port = "631";
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PrinterAdapterError("DEVICE_ERROR");
  }
  return url;
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) throw new IppTransportError();
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
