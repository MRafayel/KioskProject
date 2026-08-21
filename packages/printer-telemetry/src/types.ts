/**
 * What the printer's own engine reports about itself, over SNMP.
 *
 * # The rule this package exists to hold
 *
 * **Nothing here may ever raise confidence that a customer's pages came out.**
 * A telemetry reading may remove a success claim, or refuse a job before the
 * customer pays. It may never grant one. That asymmetry is what makes a faulty
 * or spoofed telemetry source a denial of service rather than a false success or
 * a duplicate print.
 *
 * It is enforced by shape, not by discipline: there is no field on a snapshot
 * that says a job succeeded, and no reading can produce one. The only signal
 * capable of evidencing physical output is `marker`, a monotonic engine counter,
 * and the only honest use of it is a *shortfall* — fewer units marked than the
 * job required. A delta that meets expectations proves nothing on its own,
 * because it cannot distinguish this job's pages from somebody else's.
 *
 * # Silence is never good news
 *
 * Every field is `null` when the device did not report it, and `null` means
 * *unknown* — never "fine", never "no fault". A printer that has gone to sleep,
 * dropped a packet or been unplugged reads the same as one that is healthy and
 * quiet, so a caller gating on `faults` must treat `null` as a reason to refuse,
 * not a reason to proceed. `TelemetryReadResult` has exactly one shape that
 * carries data and one that does not, so there is no way to accidentally read a
 * failed request as an empty fault list.
 */

/** A decoded SNMP variable binding. The transport has already parsed BER. */
export interface SnmpVarbind {
  readonly oid: string;
  /**
   * Numeric payload, for INTEGER, Counter32, Gauge32 and TimeTicks. `null` for
   * anything else — including a value the device sent with the wrong type,
   * which is precisely the case a caller must not silently coerce.
   */
  readonly integer: number | null;
  /** Raw octets, for OCTET STRING. `null` for anything else. */
  readonly bytes: Uint8Array | null;
}

/**
 * Reads one column of an SNMP table. Kept this narrow deliberately: the client
 * above it is pure and testable, and the one file that speaks to the network
 * implements exactly this and nothing more.
 */
export interface SnmpTransport {
  /**
   * Walks `columnOid`, returning at most `maxRows` bindings. Must reject on
   * timeout rather than resolving empty — an empty column and an unanswered
   * request mean opposite things.
   */
  walkColumn(columnOid: string, maxRows: number): Promise<readonly SnmpVarbind[]>;
  close(): void;
}

/** hrPrinterStatus (RFC 2790). */
export type PrinterEngineState =
  /** printing(4). The engine is marking paper. */
  | "PRINTING"
  /** idle(3). */
  | "IDLE"
  /** warmup(5). */
  | "WARMUP"
  /**
   * other(1). On the certified Canon this is the *resting* state, which it also
   * reports when asleep — so it cannot be read as "finished", and leaving
   * PRINTING can never mean a job is done.
   */
  | "OTHER"
  /** unknown(2), or a value outside the enumeration. */
  | "UNKNOWN";

/**
 * hrPrinterDetectedErrorState bits (RFC 3805).
 *
 * `LOW_PAPER` and `NO_PAPER` are not two severities of one condition and must
 * not be treated as such. On the certified Canon, `NO_PAPER` asserts only while
 * a job is actually blocked and clears when it is cancelled, whereas `LOW_PAPER`
 * tracks the tray and persists. One is about the operation in front of you; the
 * other is a standing condition that must never fail somebody's finished job.
 */
export type PrinterFault =
  | "LOW_PAPER"
  | "NO_PAPER"
  | "LOW_TONER"
  | "NO_TONER"
  | "DOOR_OPEN"
  | "JAMMED"
  | "OFFLINE"
  | "SERVICE_REQUESTED"
  | "INPUT_TRAY_MISSING"
  | "OUTPUT_TRAY_MISSING"
  | "MARKER_SUPPLY_MISSING"
  | "OUTPUT_NEAR_FULL"
  | "OUTPUT_FULL"
  | "INPUT_TRAY_EMPTY"
  | "OVERDUE_PREVENTIVE_MAINTENANCE";

/**
 * What one unit of `prtMarkerLifeCount` means, from `prtMarkerCounterUnit`.
 *
 * Device-defined, and the difference is a factor of two on every duplex job: the
 * certified Canon counts `IMPRESSIONS`, so one two-sided sheet advances the
 * counter twice. Comparing a shortfall against the wrong total would fail jobs
 * that printed perfectly, so `UNKNOWN` must disable the comparison rather than
 * pick a default.
 */
export type MarkerCounterUnit = "IMPRESSIONS" | "SHEETS" | "UNKNOWN";

export interface MarkerCounter {
  /** Monotonic count of units marked over the life of the engine. */
  readonly lifeCount: number;
  readonly unit: MarkerCounterUnit;
}

/** Whether an input tray holds paper. */
export type PaperPresence = "PRESENT" | "EMPTY" | "UNKNOWN";

export interface PrinterInput {
  /** The row's index within prtInputTable, for operator diagnostics only. */
  readonly index: number;
  readonly presence: PaperPresence;
  /**
   * Sheets remaining, where the device counts them. `null` on the certified
   * Canon, which reports the `someRemaining(-3)` sentinel: presence only, never
   * a count. A kiosk therefore cannot know before payment whether there is
   * enough paper for a fifty-page job — only whether there is any at all.
   */
  readonly sheets: number | null;
}

export interface PrinterSupply {
  readonly index: number;
  /** 0–100 where the device gives a proportion, `null` where it does not. */
  readonly percentRemaining: number | null;
}

/**
 * One reading. Every field is independently `null`-able: a partial answer is
 * still worth having, and pretending otherwise would throw away a usable fault
 * bitmask because a tray row was malformed.
 */
export interface PrinterTelemetrySnapshot {
  readonly readAt: Date;
  /** Verified against the pinned serial before this snapshot was constructed. */
  readonly serialNumber: string;
  readonly engine: PrinterEngineState;
  /** `null` when the device did not report the bitmask. Not the same as `[]`. */
  readonly faults: readonly PrinterFault[] | null;
  readonly marker: MarkerCounter | null;
  readonly inputs: readonly PrinterInput[] | null;
  readonly supplies: readonly PrinterSupply[] | null;
}

/**
 * Why a reading produced nothing usable. Every one of these means *we do not
 * know*, and a caller must treat them alike: none is evidence of a healthy
 * printer, and none is evidence of a fault.
 */
export type TelemetryUnavailableReason =
  /** No answer within the budget. Asleep, busy, unplugged — indistinguishable. */
  | "TIMEOUT"
  /** The session itself failed: refused, unroutable, or a protocol error. */
  | "TRANSPORT_ERROR"
  /** The device would not report a serial number, so it could not be identified. */
  | "IDENTITY_UNREADABLE"
  /** It answered with a serial or MAC that is not the printer we are pinned to. */
  | "IDENTITY_MISMATCH"
  /** It answered, and identified itself, but nothing in the reply was usable. */
  | "NO_USABLE_VALUES";

export type TelemetryReadResult =
  | { readonly outcome: "OK"; readonly snapshot: PrinterTelemetrySnapshot }
  | { readonly outcome: "UNAVAILABLE"; readonly reason: TelemetryUnavailableReason };

/**
 * The printer this kiosk is allowed to believe.
 *
 * Both values are checked, but they are not equally strong and should not be
 * described as though they were. SNMPv3 authPriv is the control that resists an
 * active impostor, because it has neither key. Serial and MAC are reported by
 * the device *about itself* over that same session, so on their own they would
 * stop a misconfiguration — a cable moved to the wrong printer — rather than an
 * attacker willing to echo whatever we pinned.
 */
export interface PinnedIdentity {
  readonly serialNumber: string;
  /** Lower-case, colon-separated. Empty disables the MAC check. */
  readonly macAddress: string;
}
