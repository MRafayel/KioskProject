import type { NonAdminEnvironment } from "@printing-kiosk/config";
import type { PrinterHealthStateValue } from "@printing-kiosk/contracts";
import {
  createPrinterTelemetryClient,
  createSnmpTransport,
  type PaperPresence,
  type PrinterFault,
  type PrinterTelemetryClient,
  type PrinterTelemetrySnapshot,
  type TelemetryUnavailableReason
} from "@printing-kiosk/printer-telemetry";

export type PrinterWarningCode = "TONER_LOW" | "PAPER_LOW" | "OUTPUT_TRAY_FULL" | null;

/**
 * How many consecutive failed readings before telemetry counts as unavailable.
 *
 * The certified printer drops roughly one request in eight and sleeps between
 * jobs, so a single silent reading is routine. Reacting to one would mean a
 * kiosk whose reported state flapped with the weather on a UDP cable. Three
 * consecutive failures at the default poll interval is a minute and a half of
 * sustained silence, which is a real outage rather than a dropped packet.
 */
const FAILURES_BEFORE_UNAVAILABLE = 3;

/**
 * How many poll intervals a snapshot stays usable.
 *
 * A poller that has stalled would otherwise leave the last reading standing
 * forever, and the last reading is usually a healthy one — so the failure mode
 * of a broken poller would be a kiosk that looks fine indefinitely. Age turns
 * that into the same answer as silence.
 */
const STALE_AFTER_INTERVALS = 3;

/**
 * What the last telemetry reading said, as the reporter needs to see it.
 *
 * `UNAVAILABLE` is deliberately not a fault and deliberately not health: it is
 * the absence of information, and it is kept distinct all the way through so
 * that nothing downstream can mistake "the printer did not answer" for "the
 * printer is fine".
 */
export type TelemetryVerdict =
  | { readonly kind: "DISABLED" }
  | { readonly kind: "SNAPSHOT"; readonly snapshot: PrinterTelemetrySnapshot }
  | {
      readonly kind: "UNAVAILABLE";
      readonly reason: TelemetryUnavailableReason | "STALE";
      readonly consecutiveFailures: number;
    };

/**
 * Faults that mean a job submitted right now will not come out.
 *
 * These withdraw the printer's health, which is a forward-looking statement
 * about the next customer. None of them ever reaches a job that has already
 * been submitted: a printer that ran out of paper after somebody's pages were
 * delivered has not retroactively failed them.
 */
const BLOCKING_FAULTS: ReadonlySet<PrinterFault> = new Set([
  "NO_PAPER",
  "JAMMED",
  "DOOR_OPEN",
  "NO_TONER",
  "OFFLINE",
  "SERVICE_REQUESTED",
  "INPUT_TRAY_MISSING",
  "OUTPUT_TRAY_MISSING",
  "MARKER_SUPPLY_MISSING",
  "OUTPUT_FULL"
]);

/**
 * Standing conditions worth telling an operator about, and the code each maps
 * to. A kiosk keeps selling through all of them.
 *
 * `LOW_PAPER` is the one that matters in practice, and it does not mean the same
 * thing everywhere. The certified Canon has no level sensor — paper is present
 * or it is not — so there it asserts when the tray runs *empty*, including
 * mid-way through a job that went on to print perfectly. Whether that empties
 * the machine is decided by the tray levels rather than by this bit, so the
 * mapping here stays what the bit literally claims: a note for whoever restocks
 * the machine, never a verdict on a print.
 */
const ADVISORY_FAULTS: ReadonlyMap<PrinterFault, Exclude<PrinterWarningCode, null>> = new Map([
  ["LOW_PAPER", "PAPER_LOW"],
  ["INPUT_TRAY_EMPTY", "PAPER_LOW"],
  ["LOW_TONER", "TONER_LOW"],
  ["OUTPUT_NEAR_FULL", "OUTPUT_TRAY_FULL"]
]);

/** READY may become WARNING may become OFFLINE. Never the other way. */
const SEVERITY: Readonly<Record<PrinterHealthStateValue, number>> = {
  READY: 0,
  WARNING: 1,
  OFFLINE: 2
};

export interface TelemetryFold {
  readonly health: PrinterHealthStateValue;
  readonly warningCode: PrinterWarningCode;
  /** Why telemetry changed the reading, for the local log. Empty when it did not. */
  readonly reason: string | null;
}

/**
 * Folds a telemetry reading into what the adapter already said.
 *
 * Strictly one-directional: this may make a printer's reported health worse and
 * may add a warning that was not there. It can never make health better, never
 * clear a warning the adapter raised, and never turn silence into either. The
 * severity ordering is what enforces it — every path takes the maximum, so a
 * healthy-looking telemetry reading cannot overrule a device that said it was
 * offline.
 *
 * Engine state is not consulted. See `describeEngine` for why.
 */
export function applyPrinterTelemetry(
  base: { readonly health: PrinterHealthStateValue; readonly warningCode: PrinterWarningCode },
  verdict: TelemetryVerdict,
  options: { readonly required: boolean }
): TelemetryFold {
  const unchanged: TelemetryFold = { health: base.health, warningCode: base.warningCode, reason: null };
  if (verdict.kind === "DISABLED") return unchanged;

  if (verdict.kind === "UNAVAILABLE") {
    // Not knowing is not a fault, so this never invents one. What it can do —
    // only when the deployment asked for telemetry to be a precondition, and
    // only after the silence has lasted — is stop claiming the printer is well.
    if (!options.required) return unchanged;
    if (verdict.consecutiveFailures < FAILURES_BEFORE_UNAVAILABLE) return unchanged;
    return {
      health: worst(base.health, "OFFLINE"),
      warningCode: base.warningCode,
      reason: `telemetry unavailable (${verdict.reason})`
    };
  }

  const faults = verdict.snapshot.faults;

  // Paper presence comes from the tray levels, not from the `lowPaper` bit.
  //
  // The bit is not comparable across devices: the certified Canon has no level
  // sensor at all, so `lowPaper` there means the tray is *empty*, while a
  // printer that can actually count sheets sets the same bit with paper still
  // in it. Reading the bit as "empty" would refuse sales on a healthy printer;
  // reading it as "low" would sell a job this one cannot print. The level
  // column answers the question directly on both, so it is what gets asked.
  if (paperPresence(verdict.snapshot.inputs) === "EMPTY") {
    return {
      health: worst(base.health, "OFFLINE"),
      warningCode: "PAPER_LOW",
      reason: "printer blocked (no paper in any tray)"
    };
  }

  if (faults === null) {
    // Identified, and said nothing about its faults. Treated exactly like
    // silence rather than like an all-clear.
    return unchanged;
  }

  const blocking = faults.filter((fault) => BLOCKING_FAULTS.has(fault));
  if (blocking.length > 0) {
    return {
      health: worst(base.health, "OFFLINE"),
      warningCode: advisoryCodeFor(faults) ?? base.warningCode,
      reason: `printer blocked (${blocking.join(", ")})`
    };
  }

  const advisory = advisoryCodeFor(faults);
  if (advisory !== null) {
    return {
      health: worst(base.health, "WARNING"),
      // Telemetry wins on the physical conditions, and this is the one place
      // the order matters. The driver's warning is a guess from a status string
      // — on the certified Canon it reads `Normal` with an empty tray — while
      // this comes from the printer's own supply and tray columns. Letting the
      // driver's answer stand in front of it was how an authoritative
      // `PAPER_LOW` could be hidden behind a stale `TONER_LOW`. The driver's
      // code still shows through when telemetry has nothing to say.
      warningCode: advisory ?? base.warningCode,
      reason: `printer warning (${faults.join(", ")})`
    };
  }

  return unchanged;
}

function worst(
  left: PrinterHealthStateValue,
  right: PrinterHealthStateValue
): PrinterHealthStateValue {
  return SEVERITY[left] >= SEVERITY[right] ? left : right;
}

/**
 * Whether this printer has paper anywhere it can pull from.
 *
 * `EMPTY` is only returned when every input the device reported is empty, so a
 * machine with a permanently empty manual-feed slot beside a loaded cassette
 * still sells — which is the certified Canon's normal state, reporting `0` for
 * the multi-purpose tray and `-3` for the cassette on every job it has printed.
 *
 * Anything less certain is `UNKNOWN`, and `UNKNOWN` gates nothing. One tray
 * that will not answer is not evidence the machine is out of paper.
 */
function paperPresence(inputs: PrinterTelemetrySnapshot["inputs"]): PaperPresence {
  if (inputs === null || inputs.length === 0) return "UNKNOWN";
  if (inputs.some((tray) => tray.presence === "PRESENT")) return "PRESENT";
  return inputs.every((tray) => tray.presence === "EMPTY") ? "EMPTY" : "UNKNOWN";
}

function advisoryCodeFor(faults: readonly PrinterFault[]): PrinterWarningCode {
  for (const fault of faults) {
    const code = ADVISORY_FAULTS.get(fault);
    if (code) return code;
  }
  return null;
}

/**
 * The engine state, as a phrase for the local log and nothing more.
 *
 * It is not used to decide anything, and the evidence is why. Across every
 * recorded run on the certified Canon, `other(1)` appeared with no fault at all
 * — for fifty seconds after a successful print, and for half a minute before
 * one — and faults appeared while the engine read `idle(3)`. In the single run
 * where `other(1)` did coincide with a blocked job it was co-timed to the
 * sample with `noPaper`, so it added nothing that bit had not already said.
 *
 * It is therefore neither necessary nor sufficient for a fault, and treating it
 * as one would have marked two successful prints as faulted. `printing(4)` is
 * the only value carrying information the fault bits do not, and even that
 * cannot mean a job finished: leaving it would fire equally on a pause.
 */
export function describeEngine(snapshot: PrinterTelemetrySnapshot): string {
  return snapshot.engine;
}

export interface PrinterTelemetrySource {
  /** The latest verdict, aged against the clock. Never blocks. */
  current(): TelemetryVerdict;
  /**
   * When this source last actually heard from the printer, or `null` if it
   * never has.
   *
   * Deliberately the last *successful* reading rather than the last attempt, and
   * deliberately not cleared when an attempt fails. A link that has started
   * failing keeps an ageing timestamp, which is what lets the control plane
   * refuse a payment on stale telemetry; a kiosk with no link at all keeps
   * `null`, which is not staleness and must never be read as it.
   */
  observedAt(): Date | null;
  /**
   * Called when the folded health could have changed, so the caller can report
   * it now instead of at the next scheduled beat. The whole race this closes is
   * the minute between a tray emptying and a heartbeat carrying that fact.
   */
  onChange(listener: () => void): void;
  /**
   * One reading taken now, bypassing the cache. `null` when the printer could
   * not be reached, or when this kiosk has no telemetry link at all.
   *
   * The cache is the right answer for health, which describes a kiosk over
   * minutes. It is the wrong answer for a page counter around a job that lasted
   * seconds — a reading from before the job started would be compared against
   * itself. This is the only caller that needs the wire, and it needs it twice
   * per print rather than continuously.
   */
  readNow(): Promise<PrinterTelemetrySnapshot | null>;
  start(): void;
  close(): void;
}

export interface PrinterTelemetrySourceOptions {
  readonly environment: NonAdminEnvironment;
  readonly logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  /** Injected for tests; the real one is built from the environment. */
  readonly client?: PrinterTelemetryClient;
  readonly now?: () => Date;
}

/**
 * Polls the printer on its own schedule and caches what it heard.
 *
 * On its own schedule deliberately: the heartbeat is how the control plane
 * learns this kiosk is alive, and a printer that has stopped answering must
 * never be able to delay it. The reporter reads a cached verdict and never
 * waits for SNMP.
 */
export function createPrinterTelemetrySource(
  options: PrinterTelemetrySourceOptions
): PrinterTelemetrySource {
  const environment = options.environment;
  const now = options.now ?? (() => new Date());
  const intervalMs = environment.PRINTER_TELEMETRY_POLL_SECONDS * 1_000;

  if (!environment.PRINTER_TELEMETRY_ENABLED) {
    // Said out loud, once, because the silent version of this cost a customer a
    // print. With telemetry off the fold is a no-op and the reported health is
    // whatever the driver claims — which on the certified Canon is `Normal`
    // with an empty tray. A kiosk in that state looks identical in every other
    // log line to one that can actually see its printer, so this is the only
    // place the difference is visible.
    return {
      current: () => ({ kind: "DISABLED" }),
      // Never observed, and never will be. Distinct from a link that has gone
      // quiet, which keeps an ageing timestamp instead.
      observedAt: () => null,
      onChange: () => undefined,
      readNow: () => Promise.resolve(null),
      start: () =>
        options.logger.warn(
          { telemetry: "disabled" },
          "printer telemetry is off; printer health is driver-reported only"
        ),
      close: () => undefined
    };
  }

  const client = options.client ?? buildClient(environment, now);
  let latest: TelemetryVerdict = { kind: "UNAVAILABLE", reason: "TIMEOUT", consecutiveFailures: 0 };
  let readAt: number | null = null;
  let lastSnapshotAt: Date | null = null;
  let failures = 0;
  let lastLogged = "";
  let lastSignature = healthSignature(latest);
  const listeners: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let running = false;

  const record = (verdict: TelemetryVerdict): void => {
    latest = verdict;
    readAt = now().getTime();
    if (verdict.kind === "SNAPSHOT") lastSnapshotAt = verdict.snapshot.readAt;

    const summary = describeVerdict(verdict);
    // Logged on change only. A kiosk polling every thirty seconds would
    // otherwise write the same line two thousand times a day, and the line that
    // matters is the one where something moved.
    if (summary !== lastLogged) {
      lastLogged = summary;
      options.logger.info({ telemetry: summary }, "printer telemetry changed");
    }

    // Wake the reporter only when this reading could change the *fold*, not
    // whenever any field moved. The marker counter advances on every page and
    // the engine flips throughout a job; neither decides health, and beating on
    // them would put a request per page on the control plane for nothing.
    const signature = healthSignature(verdict);
    if (signature === lastSignature) return;
    lastSignature = signature;
    for (const listener of listeners) listener();
  };

  const poll = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await client.read();
      if (result.outcome === "OK") {
        failures = 0;
        record({ kind: "SNAPSHOT", snapshot: result.snapshot });
      } else {
        failures += 1;
        record({ kind: "UNAVAILABLE", reason: result.reason, consecutiveFailures: failures });
      }
    } catch {
      // A throw from the client is the same class of event as a refused read:
      // we do not know. It must not become a fault.
      failures += 1;
      record({ kind: "UNAVAILABLE", reason: "TRANSPORT_ERROR", consecutiveFailures: failures });
    } finally {
      running = false;
    }
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void poll().finally(() => schedule(intervalMs));
    }, delay);
    timer.unref?.();
  };

  return {
    current(): TelemetryVerdict {
      if (latest.kind !== "SNAPSHOT" || readAt === null) return latest;
      const age = now().getTime() - readAt;
      if (age <= intervalMs * STALE_AFTER_INTERVALS) return latest;
      // Old enough that it describes a printer we have not actually heard from.
      return {
        kind: "UNAVAILABLE",
        reason: "STALE",
        consecutiveFailures: Math.max(failures, FAILURES_BEFORE_UNAVAILABLE)
      };
    },
    observedAt: () => lastSnapshotAt,
    onChange(listener: () => void): void {
      listeners.push(listener);
    },
    async readNow(): Promise<PrinterTelemetrySnapshot | null> {
      try {
        const result = await client.read();
        if (result.outcome !== "OK") return null;
        // Folded into the same cache the poller writes, through the same fold.
        //
        // These readings are taken every few seconds while a job is marking,
        // which makes them the freshest view of the printer anyone has — and the
        // job that empties the tray is precisely the one being watched here.
        // Letting them sit unread meant the next customer could start a session
        // on a machine that had run out half a minute earlier, purely because
        // the scheduled poll had not come round yet.
        //
        // It cannot affect the job in flight: health is only ever a statement
        // about the *next* customer, and this operation's outcome is decided by
        // the counter alone. What it does is trip the same beat-on-change the
        // poller uses, so an empty tray reaches the control plane in about a
        // second instead of at the next poll.
        //
        // Only successful readings. A failed one here would count towards the
        // sustained-silence threshold at this loop's cadence rather than the
        // poller's, turning a few dropped packets during one print into an
        // offline printer; the poller notices real silence on its own schedule.
        record({ kind: "SNAPSHOT", snapshot: result.snapshot });
        return result.snapshot;
      } catch {
        return null;
      }
    },
    start(): void {
      if (!stopped) return;
      stopped = false;
      // Device configuration only — never the user, the keys or the serial.
      // Enough to tell a working link from a misaddressed one without putting
      // anything on a public machine's disk that is worth stealing.
      options.logger.info(
        {
          telemetry: "enabled",
          host: environment.PRINTER_TELEMETRY_HOST,
          port: environment.PRINTER_TELEMETRY_PORT,
          pollSeconds: environment.PRINTER_TELEMETRY_POLL_SECONDS,
          required: environment.PRINTER_TELEMETRY_REQUIRED
        },
        "printer telemetry polling"
      );
      schedule(0);
    },
    close(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      client.close();
    }
  };
}

function buildClient(environment: NonAdminEnvironment, now: () => Date): PrinterTelemetryClient {
  return createPrinterTelemetryClient({
    transport: createSnmpTransport({
      host: environment.PRINTER_TELEMETRY_HOST,
      port: environment.PRINTER_TELEMETRY_PORT,
      user: environment.PRINTER_TELEMETRY_SNMP_USER,
      authProtocol: environment.PRINTER_TELEMETRY_SNMP_AUTH_PROTOCOL,
      authKey: environment.PRINTER_TELEMETRY_SNMP_AUTH_KEY,
      privProtocol: environment.PRINTER_TELEMETRY_SNMP_PRIV_PROTOCOL,
      privKey: environment.PRINTER_TELEMETRY_SNMP_PRIV_KEY,
      requestTimeoutMs: environment.PRINTER_TELEMETRY_TIMEOUT_MS,
      sourceAddress: environment.PRINTER_TELEMETRY_SOURCE_ADDRESS
    }),
    identity: {
      serialNumber: environment.PRINTER_TELEMETRY_SERIAL,
      macAddress: environment.PRINTER_TELEMETRY_MAC
    },
    clock: { now },
    budgetMs: environment.PRINTER_TELEMETRY_BUDGET_MS,
    attemptsPerColumn: environment.PRINTER_TELEMETRY_ATTEMPTS
  });
}

/**
 * Everything about a reading that can change what `applyPrinterTelemetry`
 * decides, and nothing that cannot.
 *
 * The marker counter and the engine state are excluded on purpose: both move
 * constantly during a job and neither is consulted by the fold, so including
 * them would wake the reporter once per page to report a health that had not
 * changed. Failure counts are bucketed at the threshold the fold actually uses,
 * for the same reason — the second consecutive timeout changes nothing, and the
 * third changes everything.
 */
export function healthSignature(verdict: TelemetryVerdict): string {
  if (verdict.kind === "DISABLED") return "disabled";
  if (verdict.kind === "UNAVAILABLE") {
    const sustained = verdict.consecutiveFailures >= FAILURES_BEFORE_UNAVAILABLE;
    return `unavailable:${sustained ? "sustained" : "transient"}`;
  }
  const faults = verdict.snapshot.faults;
  return [
    "snapshot",
    faults === null ? "unreported" : [...faults].sort().join("+") || "none",
    paperPresence(verdict.snapshot.inputs)
  ].join(":");
}

/**
 * A one-line summary for the local log. Device state only — no serial, no
 * addresses, nothing a customer ever touched.
 */
export function describeVerdict(verdict: TelemetryVerdict): string {
  if (verdict.kind === "DISABLED") return "disabled";
  if (verdict.kind === "UNAVAILABLE") {
    return `unavailable:${verdict.reason}:${String(verdict.consecutiveFailures)}`;
  }
  const { snapshot } = verdict;
  const faults = snapshot.faults === null ? "unreported" : snapshot.faults.join("+") || "none";
  const marker = snapshot.marker === null ? "?" : String(snapshot.marker.lifeCount);
  return `${describeEngine(snapshot)} faults=${faults} marker=${marker}`;
}
