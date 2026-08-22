import { createHash } from "node:crypto";

import type { NonAdminEnvironment } from "@printing-kiosk/config";
import {
  agentCommandAckSchema,
  claimAgentCommandsResponseSchema,
  type AgentPrintCommand
} from "@printing-kiosk/contracts";
import {
  canonicalPrintManifestJson,
  PrinterAdapterError,
  type PrinterAdapter,
  type PrintOperationStatus
} from "@printing-kiosk/printer-adapters";

import type { MarkerCounter, PrinterTelemetrySnapshot } from "@printing-kiosk/printer-telemetry";

import { LocalPrintLedger } from "./ledger.js";
import {
  describeMarkerEvidence,
  observeMarkerCompletion,
  type MarkerEvidence
} from "./marker.js";
import { PrintSpool } from "./spool.js";

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** How often the device is asked about work it has not finished describing. */
const DEVICE_POLL_INTERVAL_MS = 5_000;
/** A renewal cadence below this would beat on the control plane for no gain. */
const MIN_LEASE_RENEWAL_MS = 5_000;
/**
 * How often the engine's counter is read while waiting for a job to finish
 * marking. The certified hardware takes about three seconds a page, so this
 * sees every page without asking twice for the same one.
 */
const MARKER_POLL_INTERVAL_MS = 3_000;
/**
 * Consecutive flat readings before the engine counts as stopped.
 *
 * More than one, because a printer pauses between sheets and a single unchanged
 * reading is a pause rather than a stall. Three at the interval above is about
 * nine seconds of a genuinely still engine — long enough that a slow page does
 * not look like a failure, short enough that a customer is not left waiting.
 */
const MARKER_STILL_READS_BEFORE_STOPPED = 3;
/**
 * The same allowance before the job's first impression lands.
 *
 * Ten readings is thirty seconds, which is generous on purpose: the print host
 * returns about a second after submission, and a printer waking from sleep can
 * take most of that half-minute to produce its first page. The cost of being
 * generous falls only on jobs that genuinely printed nothing — a case the
 * pre-payment readiness gate already makes rare — while the cost of being mean
 * falls on healthy jobs, which is the wrong way round.
 */
const MARKER_STARTUP_READS_BEFORE_STOPPED = 10;
/**
 * Reasons that mean no measurement was ever taken, as opposed to one that was
 * taken and came out inconclusive. The first kind is the normal state of a kiosk
 * without a telemetry link and is not worth recording; the second is a printer
 * behaving oddly and is exactly what an operator would want to see.
 */
const NOT_MEASURED: ReadonlySet<string> = new Set(["NO_BASELINE", "NOT_A_SUCCESS_CLAIM"]);
/** Device states that describe work whose outcome is still open. */
const OPEN_DEVICE_STATES: ReadonlySet<PrintOperationStatus["state"]> = new Set([
  "SUBMITTED",
  "PRINTING"
]);

export interface PrintRunnerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PrintCommandRunnerOptions {
  environment: NonAdminEnvironment;
  adapter: PrinterAdapter;
  logger: PrintRunnerLogger;
  fetch?: UpstreamFetch;
  ledger?: LocalPrintLedger;
  spool?: PrintSpool;
  pollIntervalMilliseconds?: number;
  /** How often the lease is renewed while the device holds the work. */
  leaseRenewalMilliseconds?: number;
  /** How often a device that has not finished describing its work is asked. */
  devicePollIntervalMilliseconds?: number;
  /**
   * The printer's own telemetry, when a deployment has one.
   *
   * Used here for a single purpose: reading the engine's page counter either
   * side of the job, so a result that claims success can be checked against how
   * many pages the machine actually marked. Absent leaves every result exactly
   * as the device host described it.
   */
  telemetry?: MarkerTelemetry;
  /** How often the counter is read while waiting for the engine to settle. */
  markerPollIntervalMilliseconds?: number;
}

/** The slice of the telemetry source this runner needs. */
export interface MarkerTelemetry {
  readNow(): Promise<PrinterTelemetrySnapshot | null>;
}

/**
 * The kiosk side of printing.
 *
 * It leases one operation at a time from the control plane, fetches exactly the
 * documents the manifest names, hands them to a device adapter, and reports
 * what came back. Everything it does is arranged around one hazard: a printer
 * that has already been given work must never be given it again by accident.
 *
 * So the order is deliberate. The manifest hash is re-checked locally before
 * anything is fetched. The intent to submit is written to a local ledger before
 * the device is touched. And a redelivered operation — or one this kiosk
 * already recorded as submitted — is never resubmitted: the device is asked
 * what it did, and if it cannot say, that ambiguity is reported honestly rather
 * than resolved into a guess.
 */
export class PrintCommandRunner {
  private readonly fetch: UpstreamFetch;
  private readonly ledger: LocalPrintLedger;
  private readonly spool: PrintSpool;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running = false;
  private nextSweepAt = 0;
  private active = 0;

  public constructor(private readonly options: PrintCommandRunnerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.ledger = options.ledger ?? new LocalPrintLedger(options.environment.PRINTER_SPOOL_DIR);
    this.spool =
      options.spool ??
      new PrintSpool({
        directory: options.environment.PRINTER_SPOOL_DIR,
        apiOrigin: options.environment.API_ORIGIN,
        authorization: `Bearer ${options.environment.DEV_KIOSK_API_KEY}`,
        maxDocumentBytes: options.environment.MAX_NORMALIZED_FILE_BYTES,
        ...(options.fetch ? { fetch: options.fetch } : {})
      });
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

  /** Public so tests can drive one pass deterministically. */
  public async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      await this.sweepLocalArtifacts();
      const commands = await this.claim();
      for (const command of commands) {
        await this.execute(command);
      }
      return commands.length;
    } finally {
      this.running = false;
    }
  }

  /**
   * The kiosk's own retention watchdog: clear local copies of a customer's
   * document that no live print can still be using.
   *
   * There are two of them and they expire for different reasons. A spooled
   * document exists only between being fetched and being handed to the device,
   * so nothing should outlive the pass that wrote it — but a kiosk that loses
   * power mid-print leaves one behind with nothing left to delete it. Device
   * output has to outlive its print, because it is the evidence a redelivered
   * operation is resolved against instead of being printed twice; past the
   * job's own deadline no redelivery is possible and it is only a copy.
   *
   * Both sweep by age rather than wholesale: another agent instance may share
   * these directories, and its in-flight work is always newer than the cutoff
   * because a job is settled at its own deadline. This runs on the first pass
   * and then at most once per job-timeout window, and every failure is logged
   * rather than thrown so it can never stop the kiosk from printing.
   *
   * It is deliberately local and unconditional. A kiosk that cannot reach the
   * control plane still deletes what it is holding, which is exactly the case
   * where a cloud-issued delete command would never arrive.
   */
  private async sweepLocalArtifacts(): Promise<void> {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    const timeoutMilliseconds = this.options.environment.PRINT_JOB_TIMEOUT_SECONDS * 1_000;
    this.nextSweepAt = now + timeoutMilliseconds;

    try {
      const discarded = await this.spool.discardStale(new Date(now - timeoutMilliseconds));
      if (discarded > 0) {
        this.options.logger.warn(
          { discarded },
          "cleared print spool an interrupted print left behind"
        );
      }
    } catch (error) {
      this.options.logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "stale print spool could not be cleared"
      );
    }

    try {
      const retentionMilliseconds =
        this.options.environment.PRINTER_OUTPUT_RETENTION_SECONDS * 1_000;
      const discarded = await this.options.adapter.discardOutputsBefore(
        new Date(now - retentionMilliseconds)
      );
      if (discarded > 0) {
        this.options.logger.warn({ discarded }, "discarded expired device output");
      }
    } catch (error) {
      this.options.logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "expired device output could not be discarded"
      );
    }
  }

  private async claim(): Promise<AgentPrintCommand[]> {
    const response = await this.request("/v1/agent/commands/claim", { max: 1 });
    if (!response.ok) return [];
    return claimAgentCommandsResponseSchema.parse(await response.json()).commands;
  }

  /**
   * How many operations this agent is holding. It goes on the heartbeat so a
   * kiosk that is quiet because it is printing can be told apart from one that
   * is quiet because it is stuck.
   */
  public get activeOperations(): number {
    return this.active;
  }

  private async execute(command: AgentPrintCommand): Promise<void> {
    this.active += 1;
    try {
      await this.runOperation(command);
    } finally {
      this.active -= 1;
      // A backstop for every path that returns before the device is reached —
      // a redelivery the device already answered, a refused manifest, a throw.
      // The submission path discards as soon as the adapter is done rather than
      // waiting for this, so a customer's document is never held across the
      // report round-trip.
      await this.spool.discard(command.operationId).catch(() => undefined);
    }
  }

  private async runOperation(command: AgentPrintCommand): Promise<void> {
    await this.ledger.record(command.operationId, "CLAIMED");

    // The manifest travelled over the network. Re-deriving its hash locally is
    // what makes a modified job refuse to print rather than print something
    // nobody priced.
    const localHash = createHash("sha256")
      .update(canonicalPrintManifestJson(command.manifest), "utf8")
      .digest("hex");
    if (localHash !== command.manifestHash) {
      const accepted = await this.report(command, {
        operationId: command.operationId,
        state: "NOT_SUBMITTED",
        confidence: "CONFIRMED",
        failureCode: "ARTIFACT_UNAVAILABLE",
        warningCode: null,
        sheetsProduced: 0
      });
      if (accepted) await this.ledger.record(command.operationId, "RESULT_REPORTED");
      return;
    }

    // Either the control plane knows this was handed out before, or this kiosk
    // knows it already told a device about it. Both forbid a fresh submission.
    if (command.redelivered || (await this.ledger.hasSubmitted(command.operationId))) {
      const known = await this.askDevice(command);
      if (known.state !== "NOT_SUBMITTED") {
        const accepted = await this.report(command, known);
        if (accepted) await this.ledger.record(command.operationId, "RESULT_REPORTED");
        return;
      }
    }

    let documents;
    try {
      // Renewing while PREPARING keeps artifact retrieval alive without telling
      // the control plane that a device has seen the job.
      await this.progress(command, "PREPARING");
      documents = await this.spool.fetchDocuments(
        command.operationId,
        command.manifest.documents.map((document) => ({
          printJobId: command.printJobId,
          documentId: document.documentId,
          position: document.position,
          sha256: document.sha256,
          sizeBytes: document.sizeBytes,
          claimToken: command.claimToken
        }))
      );

      // The intent is durable before the submission authorization is requested.
      // A crash from here is resolved by asking the device, never by guessing.
      await this.ledger.record(command.operationId, "SUBMITTING");
      await this.progress(command, "SUBMITTED");
    } catch (error) {
      // Everything above happened before the device call. A timeout, an
      // integrity error, or a rejected lease therefore proves no output was
      // submitted; it must not strand a paid customer in operator recovery.
      await this.spool.discard(command.operationId).catch(() => undefined);
      const accepted = await this.report(command, notSubmitted(command, error));
      if (accepted) await this.ledger.record(command.operationId, "RESULT_REPORTED");
      return;
    }

    // The engine's counter as it stands before the device is given anything.
    //
    // Read here rather than earlier because everything above can still abort
    // without printing, and a baseline is only worth taking for work that is
    // actually about to be handed over. A reading that fails leaves this null,
    // which disables the whole comparison for this operation and changes
    // nothing: no baseline is a reason to stay quiet, never a reason to doubt.
    const markerBefore = await this.readMarker();

    let status: PrintOperationStatus;
    const startedAt = Date.now();
    // The device is about to be given the work, and it may hold it for longer
    // than one lease. Renewal starts before the handover rather than after it,
    // so no window exists in which the control plane could take the command
    // back while a printer is already acting on it.
    const stopLeaseRenewal = this.startLeaseRenewal(command);
    this.options.logger.info(
      {
        operationId: command.operationId,
        printJobId: command.printJobId,
        documents: documents.length,
        physicalSheets: command.manifest.physicalSheets,
        redelivered: command.redelivered
      },
      "handing print operation to the device"
    );
    try {
      status = await this.options.adapter.submit({
        operationId: command.operationId,
        manifest: { ...command.manifest, documents: command.manifest.documents },
        deviceScenario: command.simulatedOutcome,
        artifacts: documents.map((document) => ({
          documentId: document.documentId,
          position: document.position,
          path: document.path,
          sha256: document.sha256,
          sizeBytes: document.sizeBytes
        }))
      });
      status = await this.awaitDeviceOutcome(command, status);
    } catch (error) {
      status = await this.resolveAdapterFailure(command, error);
    } finally {
      stopLeaseRenewal();
      // The local copy of a customer's document lives no longer than the print.
      await this.spool.discard(command.operationId).catch(() => undefined);
    }

    // What the printer's own counter says about what just happened. This can
    // only ever take a success away — see `marker.ts` for why that asymmetry is
    // the entire safety property — and it runs after the lease renewal has
    // stopped, so a slow settle cannot hold a command open.
    const evidence = await this.confirmAgainstMarker(command, status, markerBefore);
    status = applyMarkerEvidence(status, evidence);

    this.options.logger.info(
      {
        operationId: command.operationId,
        printJobId: command.printJobId,
        state: status.state,
        confidence: status.confidence,
        failureCode: status.failureCode,
        warningCode: status.warningCode,
        sheetsProduced: status.sheetsProduced,
        marker: describeMarkerEvidence(evidence),
        elapsedMs: Date.now() - startedAt
      },
      "device finished with print operation"
    );

    const accepted = await this.report(command, status);
    if (accepted) await this.ledger.record(command.operationId, "RESULT_REPORTED");
  }

  /**
   * Hold the command lease for as long as the device has the work.
   *
   * `submit` blocks until the printer is done, and the control plane offers a
   * command to somebody else the moment its lease expires. Without this, any
   * print slower than one lease was reclaimed mid-flight: the paper came out,
   * the agent's result was refused as stale, and a healthy job settled into
   * operator recovery.
   *
   * It only ever renews — it never cancels, and a failure never propagates into
   * the print. Renewal stops at the first refusal because a released command
   * has a new claim token, so the old one can never be accepted again; retrying
   * would only produce a log line per interval for the rest of the job.
   */
  private startLeaseRenewal(command: AgentPrintCommand): () => void {
    const leaseMilliseconds = this.options.environment.PRINT_COMMAND_LEASE_SECONDS * 1_000;
    const interval =
      this.options.leaseRenewalMilliseconds ??
      Math.max(MIN_LEASE_RENEWAL_MS, Math.floor(leaseMilliseconds / 3));
    const timer = setInterval(() => {
      void this.progress(command, "PRINTING").catch((error: unknown) => {
        // The control plane has already taken this command back. The print is
        // deliberately left running: stopping now would change nothing at the
        // printer and would discard the only account of what it did.
        clearInterval(timer);
        this.options.logger.warn(
          {
            operationId: command.operationId,
            printJobId: command.printJobId,
            errorName: error instanceof Error ? error.message : "UnknownError"
          },
          "print command lease could not be renewed while the device held the work"
        );
      });
    }, interval);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Wait out an operation the device has not finished describing.
   *
   * The host answers when its own observation budget runs out, not when the
   * printer stops, so a long job can come back as `PRINTING`. That is not a
   * result: reporting it as one settles a perfectly healthy print into operator
   * recovery. Asking for status is read-only — it can never put a second sheet
   * in the tray — so the outcome is waited for rather than guessed at.
   *
   * The job's own deadline bounds the wait. Past it, the work is still open and
   * that is reported honestly as unknown.
   */
  private async awaitDeviceOutcome(
    command: AgentPrintCommand,
    submitted: PrintOperationStatus
  ): Promise<PrintOperationStatus> {
    let status = submitted;
    const pollInterval = this.options.devicePollIntervalMilliseconds ?? DEVICE_POLL_INTERVAL_MS;
    const deadline = Date.parse(command.deadlineAt);
    while (OPEN_DEVICE_STATES.has(status.state)) {
      if (!Number.isFinite(deadline) || Date.now() + pollInterval >= deadline) {
        this.options.logger.warn(
          {
            operationId: command.operationId,
            printJobId: command.printJobId,
            state: status.state
          },
          "device still printing at the job deadline"
        );
        return {
          operationId: command.operationId,
          state: "UNKNOWN",
          confidence: "UNCONFIRMED",
          failureCode: "SUBMISSION_UNCONFIRMED",
          warningCode: status.warningCode,
          sheetsProduced: null
        };
      }
      await delay(pollInterval);
      status = await this.askDevice(command);
    }
    return status;
  }

  /**
   * Turn an adapter failure into an honest status. A refusal that could not
   * have started printing is a confirmed failure; anything ambiguous means
   * asking the device what it actually holds.
   */
  private async resolveAdapterFailure(
    command: AgentPrintCommand,
    error: unknown
  ): Promise<PrintOperationStatus> {
    const adapterError = asPrinterAdapterError(error);
    const ambiguous = adapterError ? adapterError.submissionAmbiguous : true;
    if (ambiguous) {
      const known = await this.askDevice(command);
      if (known.state !== "NOT_SUBMITTED") return known;
      return {
        operationId: command.operationId,
        state: "UNKNOWN",
        confidence: "UNCONFIRMED",
        failureCode: "SUBMISSION_UNCONFIRMED",
        warningCode: null,
        sheetsProduced: null
      };
    }

    return {
      operationId: command.operationId,
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED",
      failureCode: adapterFailureCode(error),
      warningCode: null,
      sheetsProduced: 0,
      // Where the device refused. A definite failure still owes an operator an
      // explanation of which step produced it, and the failure code alone does
      // not distinguish a busy queue from a document that would not render.
      ...(adapterError?.deviceStage
        ? { deviceDiagnostics: { stage: adapterError.deviceStage } }
        : {})
    };
  }

  /** The engine's counter right now, or null if it could not be read. */
  private async readMarker(): Promise<MarkerCounter | null> {
    const snapshot = await this.options.telemetry?.readNow().catch(() => null);
    return snapshot?.marker ?? null;
  }

  /**
   * Check a claimed success against the pages the engine actually marked.
   *
   * Only runs on a result that claims one. A job already headed for recovery
   * cannot be made worse by this, and a job the device says it never submitted
   * has nothing to count — so neither is worth the wait or the requests. That
   * also keeps the cost proportionate: two readings and a short watch per
   * successful print, and nothing at all the rest of the time.
   */
  private async confirmAgainstMarker(
    command: AgentPrintCommand,
    status: PrintOperationStatus,
    before: MarkerCounter | null
  ): Promise<MarkerEvidence> {
    if (status.state !== "COMPLETED" || status.confidence !== "CONFIRMED") {
      return { kind: "UNKNOWN", reason: "NOT_A_SUCCESS_CLAIM" };
    }
    const telemetry = this.options.telemetry;
    if (!telemetry) return { kind: "UNKNOWN", reason: "NO_BASELINE" };

    const deadline = Date.parse(command.deadlineAt);
    return observeMarkerCompletion({
      before,
      job: {
        printedSides: command.manifest.printedSides,
        physicalSheets: command.manifest.physicalSheets
      },
      read: () => telemetry.readNow().catch(() => null),
      // Past the job's own deadline the work is no longer worth waiting for,
      // and the control plane may already have taken the command back.
      deadlineAt: Number.isFinite(deadline) ? deadline : Date.now(),
      now: () => Date.now(),
      delay,
      pollIntervalMs: this.options.markerPollIntervalMilliseconds ?? MARKER_POLL_INTERVAL_MS,
      stillReadsBeforeStopped: MARKER_STILL_READS_BEFORE_STOPPED,
      startupReadsBeforeStopped: MARKER_STARTUP_READS_BEFORE_STOPPED
    });
  }

  private async askDevice(command: AgentPrintCommand): Promise<PrintOperationStatus> {
    try {
      return await this.options.adapter.getOperationStatus(command.operationId);
    } catch {
      // A device that cannot even be asked leaves the result unknown. Reporting
      // that is the only safe answer; guessing either way is not.
      return {
        operationId: command.operationId,
        state: "UNKNOWN",
        confidence: "UNCONFIRMED",
        failureCode: "SUBMISSION_UNCONFIRMED",
        warningCode: null,
        sheetsProduced: null
      };
    }
  }

  private async progress(
    command: AgentPrintCommand,
    state: "PREPARING" | "SUBMITTED" | "PRINTING"
  ): Promise<void> {
    const response = await this.request(
      `/v1/agent/commands/${encodeURIComponent(command.operationId)}/progress`,
      { claimToken: command.claimToken, state }
    );
    if (!response.ok) throw new Error("PRINT_COMMAND_PROGRESS_REJECTED");
    const ack = agentCommandAckSchema.parse(await response.json());
    if (!ack.accepted) throw new Error("PRINT_COMMAND_LEASE_LOST");
  }

  private async report(command: AgentPrintCommand, status: PrintOperationStatus): Promise<boolean> {
    const response = await this.request(
      `/v1/agent/commands/${encodeURIComponent(command.operationId)}/result`,
      {
        claimToken: command.claimToken,
        state: status.state,
        confidence: status.confidence,
        failureCode: status.failureCode,
        warningCode: status.warningCode,
        sheetsProduced: status.sheetsProduced,
        // What the device saw, for the record the control plane keeps. It never
        // changes the outcome above; it is why an operator can explain one.
        ...(status.deviceDiagnostics ? { deviceDiagnostics: status.deviceDiagnostics } : {})
      }
    );
    if (!response.ok) {
      // The lease will expire and the control plane will settle the job. A
      // second attempt from here could only repeat what it already tried.
      this.options.logger.warn(
        { operationId: command.operationId, status: response.status },
        "print result could not be reported"
      );
      return false;
    }

    const ack = agentCommandAckSchema.parse(await response.json());
    this.options.logger.info(
      {
        operationId: command.operationId,
        printJobId: command.printJobId,
        state: status.state,
        confidence: status.confidence,
        accepted: ack.accepted,
        printJobStatus: ack.printJobStatus
      },
      "print operation reported"
    );
    return ack.accepted;
  }

  private async request(path: string, body: unknown): Promise<Response> {
    try {
      return await this.fetch(new URL(path, this.options.environment.API_ORIGIN), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.options.environment.DEV_KIOSK_API_KEY}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  }

  private schedule(delayMilliseconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMilliseconds);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const handled = await this.runOnce();
      this.schedule(handled > 0 ? 0 : this.pollInterval);
    } catch (error) {
      this.options.logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "print command poll failed"
      );
      this.schedule(this.pollInterval);
    }
  }

  private get pollInterval(): number {
    return this.options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MS;
  }
}

/**
 * An adapter failure. The name is checked as well as the class: an adapter
 * loaded through a second module instance — a test harness importing the
 * package source while the agent imports its build — must not turn a refusal
 * the device is certain about into an ambiguous result nobody can settle.
 */
function asPrinterAdapterError(error: unknown): PrinterAdapterError | null {
  if (error instanceof PrinterAdapterError) return error;
  if (
    error instanceof Error &&
    error.name === "PrinterAdapterError" &&
    typeof Reflect.get(error, "submissionAmbiguous") === "boolean" &&
    typeof Reflect.get(error, "code") === "string" &&
    PRINTER_ADAPTER_ERROR_CODES.has(Reflect.get(error, "code") as string)
  ) {
    return error as PrinterAdapterError;
  }
  return null;
}

const PRINTER_ADAPTER_ERROR_CODES = new Set([
  "PRINTER_OFFLINE",
  "OPERATION_ID_INVALID",
  "MANIFEST_INVALID",
  "ARTIFACT_UNAVAILABLE",
  "OUTPUT_WRITE_FAILED",
  "SUBMISSION_UNCONFIRMED",
  "DEVICE_ERROR"
]);

/**
 * Fold the counter's verdict into a result. One direction only.
 *
 * A shortfall removes the success claim and says so; everything else leaves the
 * result untouched and merely records what was seen. There is deliberately no
 * branch here that raises confidence, sets `COMPLETED`, or fills in a sheet
 * count — a printer that reports a healthy counter has not thereby proved a
 * customer's pages came out, and the moment this function could say otherwise
 * a compromised or simply optimistic device could manufacture a success.
 */
export function applyMarkerEvidence(
  status: PrintOperationStatus,
  evidence: MarkerEvidence
): PrintOperationStatus {
  // Nothing was measured, so there is nothing to record. A kiosk with no
  // telemetry link would otherwise attach the same empty finding to every job it
  // ever prints, which buries the readings that do mean something.
  if (evidence.kind === "UNKNOWN" && NOT_MEASURED.has(evidence.reason)) return status;

  const diagnostics: PrintOperationStatus["deviceDiagnostics"] = {
    ...status.deviceDiagnostics,
    marker:
      evidence.kind === "UNKNOWN"
        ? { outcome: "UNKNOWN", reason: evidence.reason }
        : {
            outcome: evidence.kind,
            expected: evidence.expected,
            observed: evidence.observed,
            ...(evidence.kind === "SHORTFALL" ? { unit: evidence.unit } : {})
          }
  };

  if (evidence.kind !== "SHORTFALL") return { ...status, deviceDiagnostics: diagnostics };

  return {
    ...status,
    // `COMPLETED` with an unconfirmed result is the existing route to
    // RECOVERY_REQUIRED with no refund owed: the pages may well be sitting in
    // the tray, and a person has to look. The state is left alone on purpose —
    // rewriting it to FAILED would claim knowledge nobody has.
    confidence: "UNCONFIRMED",
    // The device's own count described a job the engine did not finish. Keeping
    // it would put a number on a page count we have just refused to vouch for.
    sheetsProduced: null,
    deviceDiagnostics: diagnostics
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function notSubmitted(command: AgentPrintCommand, error: unknown): PrintOperationStatus {
  return {
    operationId: command.operationId,
    state: "NOT_SUBMITTED",
    confidence: "CONFIRMED",
    failureCode:
      error instanceof Error && error.message.startsWith("PRINT_COMMAND_")
        ? "CANCELED_BEFORE_SUBMIT"
        : "ARTIFACT_UNAVAILABLE",
    warningCode: null,
    sheetsProduced: 0
  };
}

function adapterFailureCode(error: unknown): PrintOperationStatus["failureCode"] {
  const adapterError = asPrinterAdapterError(error);
  if (adapterError) {
    if (adapterError.code === "PRINTER_OFFLINE") return "PRINTER_OFFLINE";
    if (adapterError.code === "ARTIFACT_UNAVAILABLE") return "ARTIFACT_UNAVAILABLE";
    if (adapterError.code === "OUTPUT_WRITE_FAILED") return "OUTPUT_WRITE_FAILED";
    return "DEVICE_ERROR";
  }
  return "ARTIFACT_UNAVAILABLE";
}
