import { z } from "zod";

import { SESSION_STATES } from "@printing-kiosk/domain";

/**
 * What the control plane may show about the printing system.
 *
 * Every operational response the admin panel receives is described here, and
 * the descriptions are deliberately closed: there is no passthrough field, no
 * `metadata: unknown`, and no schema that carries a filename, an object key, a
 * content digest, a document manifest, a token or a digest of one. A field that
 * does not exist in these shapes cannot be leaked by a query that selects too
 * much, because the response is parsed through them before it is sent.
 *
 * That is the second of three layers. The first is the reader role's grants,
 * which decide what the database will even return (see
 * `packages/database/scripts/admin-reader-matrix.mjs`). The third is the
 * capability check on each route. A leak needs all three to be wrong.
 *
 * The pure helpers here — liveness, pagination cursors, attention ranking — are
 * shared by the API that computes them and the UI that renders them, so the two
 * cannot disagree about when a kiosk counts as offline.
 */

const isoTimestamp = z.string().datetime();

/** A code produced by this system's own error vocabulary. Never free text. */
const operationalCode = z.string().max(100);

/** A state or status column. Short, closed-vocabulary, written only by us. */
const operationalState = z.string().max(48);

// ---------------------------------------------------------------------------
// Kiosk liveness
// ---------------------------------------------------------------------------

export const KIOSK_LIVENESS = ["ONLINE", "DEGRADED", "OFFLINE", "NEVER_SEEN"] as const;
export type KioskLiveness = (typeof KIOSK_LIVENESS)[number];

/**
 * A kiosk heartbeats on every authenticated call and at most once a minute, so
 * two missed minutes is the first point at which silence means something. Ten
 * minutes of silence during opening hours is a kiosk somebody has to walk to.
 */
export const KIOSK_ONLINE_WINDOW_MILLISECONDS = 150_000;
export const KIOSK_DEGRADED_WINDOW_MILLISECONDS = 600_000;

export function classifyKioskLiveness(lastSeenAt: Date | null, now: Date): KioskLiveness {
  if (!lastSeenAt) return "NEVER_SEEN";
  const silentFor = now.getTime() - lastSeenAt.getTime();
  if (silentFor <= KIOSK_ONLINE_WINDOW_MILLISECONDS) return "ONLINE";
  if (silentFor <= KIOSK_DEGRADED_WINDOW_MILLISECONDS) return "DEGRADED";
  return "OFFLINE";
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * One page. Small on purpose: an operator scanning a list is looking for one
 * thing, and an unbounded query against production is how a dashboard becomes
 * the reason printing slowed down.
 */
export const ADMIN_PAGE_SIZE = 50;

export interface AdminCursor {
  /** The ordering timestamp of the last row on the previous page. */
  at: Date;
  /** Its identifier, which breaks ties so a page boundary cannot skip a row. */
  id: string;
}

const CURSOR_PATTERN = /^(\d{1,15})\.([A-Za-z0-9_.:-]{1,80})$/u;

/**
 * Keyset pagination rather than `OFFSET`.
 *
 * Offset paging re-scans everything it skips, which gets slower exactly as the
 * table an operator most needs to page through gets bigger. It also drops rows
 * when the underlying data changes between pages, which for an incident list is
 * the worst possible time to lose one.
 *
 * The encoding is deliberately plain rather than base64: a cursor carries a
 * timestamp and an identifier the caller was already shown on the previous
 * page, so it is not a secret, and pretending otherwise by obscuring it would
 * only make a malformed one harder to diagnose.
 */
export function encodeAdminCursor(cursor: AdminCursor): string {
  return `${cursor.at.getTime()}.${cursor.id}`;
}

/**
 * Returns null for anything malformed rather than throwing.
 *
 * A cursor arrives in a query string, so it is attacker-controlled. Treating a
 * bad one as "start from the beginning" keeps it from becoming an injection
 * point or a way to probe for errors, and the pattern above is what stops an
 * identifier from being anything other than an identifier.
 */
export function decodeAdminCursor(value: string): AdminCursor | null {
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return null;
  const at = new Date(Number(match[1]));
  if (Number.isNaN(at.getTime())) return null;
  return { at, id: match[2] as string };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export const ADMIN_ATTENTION_SEVERITIES = ["CRITICAL", "WARNING", "INFO"] as const;
export type AdminAttentionSeverity = (typeof ADMIN_ATTENTION_SEVERITIES)[number];

/**
 * The things on the overview that mean a person has to do something.
 *
 * Each one names a state the system deliberately refuses to resolve on its own.
 * Severity is fixed here rather than configured, because these rankings are
 * statements about the product: an undeleted document past its retention
 * deadline is a privacy failure and outranks a kiosk being offline.
 */
export const ADMIN_ATTENTION_CODES = [
  "RETENTION_DEAD_LETTERED",
  "RETENTION_OVERDUE",
  "PRINT_RECOVERY_REQUIRED",
  "REFUND_UNSETTLED",
  "PRINT_OVERDUE",
  "DOCUMENT_PROCESSING_FAILED",
  "KIOSK_OFFLINE",
  "PAYMENT_EXPIRED_UNRESOLVED"
] as const;
export type AdminAttentionCode = (typeof ADMIN_ATTENTION_CODES)[number];

const ATTENTION_SEVERITY: Readonly<Record<AdminAttentionCode, AdminAttentionSeverity>> = {
  // Documents that should have been destroyed and were not. Nothing outranks it.
  RETENTION_DEAD_LETTERED: "CRITICAL",
  RETENTION_OVERDUE: "CRITICAL",
  // A customer paid and the system will not decide whether they got their paper.
  PRINT_RECOVERY_REQUIRED: "CRITICAL",
  // Money owed back and not yet returned.
  REFUND_UNSETTLED: "WARNING",
  PRINT_OVERDUE: "WARNING",
  DOCUMENT_PROCESSING_FAILED: "WARNING",
  KIOSK_OFFLINE: "WARNING",
  PAYMENT_EXPIRED_UNRESOLVED: "INFO"
};

export function severityOfAttention(code: AdminAttentionCode): AdminAttentionSeverity {
  return ATTENTION_SEVERITY[code];
}

export const adminAttentionItemSchema = z.object({
  code: z.enum(ADMIN_ATTENTION_CODES),
  severity: z.enum(ADMIN_ATTENTION_SEVERITIES),
  count: z.number().int().nonnegative()
});

/**
 * Turn the overview counts into an ordered worklist.
 *
 * Zero counts are dropped: a dashboard that always shows eight rows trains
 * people to ignore all eight. What remains is sorted by severity and then by
 * size, so the top of the list is the thing to do next.
 */
export function deriveAttention(
  counts: Readonly<Partial<Record<AdminAttentionCode, number>>>
): { code: AdminAttentionCode; severity: AdminAttentionSeverity; count: number }[] {
  const severityRank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
  return ADMIN_ATTENTION_CODES.map((code) => ({
    code,
    severity: severityOfAttention(code),
    count: counts[code] ?? 0
  }))
    .filter((item) => item.count > 0)
    .sort(
      (left, right) =>
        severityRank[left.severity] - severityRank[right.severity] || right.count - left.count
    );
}

export const adminOverviewResponseSchema = z.object({
  generatedAt: isoTimestamp,
  /**
   * How old this snapshot is. The overview is cached for a few seconds so that
   * a room full of open dashboards cannot turn into a query per person per
   * second against the database the print path depends on.
   */
  snapshotAgeMilliseconds: z.number().int().nonnegative(),
  /** True when the counts cover only the caller's assigned kiosks. */
  scoped: z.boolean(),
  attention: z.array(adminAttentionItemSchema),
  kiosks: z.object({
    total: z.number().int().nonnegative(),
    online: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    offline: z.number().int().nonnegative(),
    notActive: z.number().int().nonnegative()
  }),
  sessions: z.object({
    live: z.number().int().nonnegative(),
    awaitingPayment: z.number().int().nonnegative(),
    printing: z.number().int().nonnegative(),
    recoveryRequired: z.number().int().nonnegative()
  }),
  printing: z.object({
    /**
     * Print jobs waiting for a person, and how many of those nobody has
     * answered yet. The worklist counts the second one: an operator who
     * records what they saw should watch the number they are working through
     * go down, or they will stop believing it.
     */
    recoveryUnresolved: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    recoveryRequired: z.number().int().nonnegative(),
    failedRecently: z.number().int().nonnegative(),
    unconfirmedRecently: z.number().int().nonnegative()
  }),
  documents: z.object({
    processing: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    awaitingScan: z.number().int().nonnegative()
  }),
  retention: z.object({
    pending: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    deadLettered: z.number().int().nonnegative()
  }),
  money: z.object({
    openPayments: z.number().int().nonnegative(),
    expiredPayments: z.number().int().nonnegative(),
    unsettledRefunds: z.number().int().nonnegative()
  })
});

// ---------------------------------------------------------------------------
// Kiosks
// ---------------------------------------------------------------------------

export const adminKioskSchema = z.object({
  id: z.string().max(64),
  publicCode: z.string().max(64),
  name: z.string().max(160),
  status: operationalState,
  timezone: z.string().max(64),
  lastSeenAt: isoTimestamp.nullable(),
  liveness: z.enum(KIOSK_LIVENESS),
  agent: z
    .object({
      liveness: z.enum(KIOSK_LIVENESS),
      version: z.string().max(64),
      platform: z.string().max(16),
      platformRelease: z.string().max(120).nullable(),
      adapter: z.string().max(16),
      queueName: z.string().max(220).nullable(),
      printerHealth: operationalState,
      activeOperations: z.number().int().nonnegative(),
      lastHeartbeatAt: isoTimestamp.nullable()
    })
    .nullable(),
  printer: z
    .object({
      queueName: z.string().max(220),
      approval: operationalState,
      queueState: operationalState,
      health: operationalState,
      warningCode: operationalCode.nullable(),
      driverName: z.string().max(400).nullable(),
      portName: z.string().max(400).nullable(),
      shared: z.boolean(),
      lastSeenAt: isoTimestamp
    })
    .nullable(),
  liveSessions: z.number().int().nonnegative(),
  openPrintJobs: z.number().int().nonnegative(),
  recoveryRequiredJobs: z.number().int().nonnegative()
});

export const adminKiosksResponseSchema = z.object({
  items: z.array(adminKioskSchema),
  scoped: z.boolean()
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const adminSessionStateSchema = z.enum(SESSION_STATES);

export const adminSessionSummarySchema = z.object({
  id: z.string().uuid(),
  /**
   * The identifier the phone handoff URL is built from. It is not a credential
   * — the upload token in the same URL is — and it is what lets an operator
   * match a customer's phone screen to a row here.
   */
  publicId: z.string().max(80),
  kioskId: z.string().max(64),
  state: adminSessionStateSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  idleExpiresAt: isoTimestamp,
  hardExpiresAt: isoTimestamp,
  terminalReason: z.string().max(80).nullable(),
  cleanupStatus: operationalState,
  cleanupDueAt: isoTimestamp.nullable(),
  filesDeletedAt: isoTimestamp.nullable(),
  documentCount: z.number().int().nonnegative(),
  printJobStatus: operationalState.nullable(),
  paymentStatus: operationalState.nullable()
});

export const adminSessionsResponseSchema = z.object({
  items: z.array(adminSessionSummarySchema),
  nextCursor: z.string().nullable(),
  scoped: z.boolean()
});

/** The print configuration a session was priced and charged for. */
export const adminSessionSettingsSchema = z.object({
  revision: z.number().int().positive(),
  paperSize: operationalState,
  scaling: operationalState,
  collate: z.boolean(),
  colorMode: operationalState,
  selectedPages: z.number().int().nonnegative(),
  printedSides: z.number().int().nonnegative(),
  physicalSheets: z.number().int().nonnegative(),
  /** When the per-document digests behind these totals were destroyed. */
  selectionsRedactedAt: isoTimestamp.nullable()
});

export const adminSessionMoneySchema = z.object({
  currency: z.string().length(3),
  currencyExponent: z.number().int().nonnegative(),
  totalMinor: z.number().int(),
  quoteStatus: operationalState,
  paymentStatus: operationalState.nullable(),
  paymentAppliedToSession: z.boolean().nullable(),
  refundStatus: operationalState.nullable(),
  refundAmountMinor: z.number().int().nullable()
});

export const adminSessionDetailResponseSchema = z.object({
  session: adminSessionSummarySchema,
  settings: adminSessionSettingsSchema.nullable(),
  money: adminSessionMoneySchema.nullable(),
  documents: z.object({
    total: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative()
  }),
  printJob: z
    .object({
      id: z.string().uuid(),
      status: operationalState,
      resultConfidence: operationalState,
      failureCode: operationalCode.nullable(),
      warningCode: operationalCode.nullable()
    })
    .nullable()
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * The workflow, as an ordered list of what happened and when.
 *
 * The stored events carry a payload; this deliberately does not return it. The
 * questions a timeline answers — what order, how long between steps, where did
 * it stop — are answered by type and time alone, and a passthrough JSON column
 * is a field whose contents are decided by whatever writes it next rather than
 * by this contract. The typed panels beside it show the detail, chosen field by
 * field.
 */
export const adminTimelineEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.string().max(100),
  occurredAt: isoTimestamp,
  /** Time since the previous entry, so a stall is visible without arithmetic. */
  sincePreviousMilliseconds: z.number().int().nonnegative().nullable()
});

export const adminTimelineResponseSchema = z.object({
  sessionId: z.string().uuid(),
  items: z.array(adminTimelineEntrySchema),
  nextCursor: z.string().nullable()
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * A customer's uploaded file, described without describing its contents.
 *
 * There is no name here, no digest, no storage key, no preview, no page image
 * and no download. Size, type, page count, state and error codes are what an
 * operator needs to answer "did their upload work"; anything more is the
 * customer's business and nobody else's.
 */
export const adminDocumentSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().nonnegative(),
  status: operationalState,
  kind: z.string().max(12).nullable(),
  declaredMime: z.string().max(100).nullable(),
  detectedMime: z.string().max(100).nullable(),
  extension: z.string().max(10).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  malwareScanStatus: operationalState,
  rejectionCode: operationalCode.nullable(),
  processingErrorCode: operationalCode.nullable(),
  processingAttempts: z.number().int().nonnegative(),
  createdAt: isoTimestamp,
  readyAt: isoTimestamp.nullable(),
  deleteRequestedAt: isoTimestamp.nullable(),
  deletedAt: isoTimestamp.nullable(),
  cleanupDueAt: isoTimestamp.nullable(),
  cleanupErrorCode: operationalCode.nullable()
});

export const adminDocumentsResponseSchema = z.object({
  sessionId: z.string().uuid(),
  items: z.array(adminDocumentSchema),
  /** Set when this session's documents have been proven destroyed. */
  filesDeletedAt: isoTimestamp.nullable()
});

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export const adminPrintJobSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  kioskId: z.string().max(64),
  status: operationalState,
  /**
   * Acceptance by a queue is not proof that paper came out, and the system
   * never rounds `UNCONFIRMED` up to a success. Neither does this panel.
   */
  resultConfidence: operationalState,
  failureCode: operationalCode.nullable(),
  warningCode: operationalCode.nullable(),
  copies: z.number().int().positive(),
  printedSides: z.number().int().nonnegative(),
  physicalSheets: z.number().int().nonnegative(),
  sheetsProduced: z.number().int().nonnegative().nullable(),
  dispatchAttempts: z.number().int().nonnegative(),
  deadlineAt: isoTimestamp,
  createdAt: isoTimestamp,
  dispatchedAt: isoTimestamp.nullable(),
  startedAt: isoTimestamp.nullable(),
  completedAt: isoTimestamp.nullable(),
  failedAt: isoTimestamp.nullable(),
  /** When the per-document manifest was replaced by a count. */
  manifestRedactedAt: isoTimestamp.nullable(),
  overdue: z.boolean(),
  /**
   * Whether a person has already said what happened to this print.
   *
   * On the list rather than only on the detail, because the question an
   * operator is answering when they open this screen is "which of these still
   * needs me", and making them click into each one to find out is how a
   * worklist stops being used.
   */
  recoveryResolved: z.boolean()
});

export const adminPrintJobsResponseSchema = z.object({
  items: z.array(adminPrintJobSchema),
  nextCursor: z.string().nullable(),
  scoped: z.boolean()
});

/** The device ledger. Technical Admins only; still no raw event payloads. */
/**
 * What the device reported seeing, for the entry that settled a job.
 *
 * Operational facts only: identifiers the operating system assigned, the raw
 * status words it produced, counts and elapsed milliseconds. Nothing here names
 * a document, a customer or a path — the device side never receives any of
 * them. It explains an outcome; it never decided one.
 */
export const adminDeviceJobEvidenceSchema = z.object({
  position: z.number().int().nonnegative(),
  /** The print spooler's own job identifier, as seen in the operating system. */
  jobId: z.number().int().nonnegative(),
  present: z.boolean(),
  observed: z.boolean(),
  completed: z.boolean(),
  faulted: z.boolean(),
  status: z.string().max(120).nullable(),
  pagesPrinted: z.number().int().nonnegative(),
  expectedPages: z.number().int().nonnegative(),
  expectedSheets: z.number().int().nonnegative()
});

export const adminDeviceDetailSchema = z.object({
  queueName: z.string().max(220).nullable().optional(),
  /** Where the device refused, when it named a step. */
  stage: z.string().max(120).nullable().optional(),
  processStartMs: z.number().int().nonnegative().nullable().optional(),
  pollCount: z.number().int().nonnegative().nullable().optional(),
  phaseMs: z.record(z.string().max(64), z.number().int().nonnegative()).optional(),
  jobs: z.array(adminDeviceJobEvidenceSchema).max(16).optional()
});

export const adminPrintJobEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.string().max(32),
  status: operationalState,
  confidence: operationalState.nullable(),
  failureCode: operationalCode.nullable(),
  warningCode: operationalCode.nullable(),
  deviceDetail: adminDeviceDetailSchema.nullable().default(null),
  createdAt: isoTimestamp
});

export const adminAgentCommandSchema = z.object({
  type: z.string().max(32),
  status: operationalState,
  attempts: z.number().int().nonnegative(),
  claimedAt: isoTimestamp.nullable(),
  leaseExpiresAt: isoTimestamp.nullable(),
  expiresAt: isoTimestamp,
  resultCode: operationalCode.nullable(),
  completedAt: isoTimestamp.nullable()
});

/**
 * What a person can report having seen at the tray.
 *
 * `RECOVERY_REQUIRED` exists because the device could not prove whether paper
 * came out. These are the four honest answers to that question, and the fourth
 * matters as much as the others: an operator who cannot tell must be able to
 * say so, because the alternative is that they guess, and a recorded guess is
 * worse than a recorded uncertainty.
 *
 * Deliberately absent: anything that would mark the print a success. What the
 * device reported stays as reported — `print_jobs` triggers refuse to rewrite
 * it, and the role that writes an observation holds no UPDATE on that table.
 */
export const RECOVERY_OUTCOMES = [
  /** The customer has usable pages. Nothing is owed. */
  "DELIVERED",
  /** Some usable pages, not the whole job. An Admin decides what is owed. */
  "PARTIALLY_DELIVERED",
  /** Nothing usable came out. Money looks owed. */
  "NOT_DELIVERED",
  /** Nobody could establish what happened. Recorded as exactly that. */
  "UNRESOLVABLE"
] as const;

export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

/**
 * One operator's account of a print the system would not settle.
 *
 * Append-only and one per job, so this is the whole of what any person has
 * said about it. `refundSuggested` is a note for whoever holds
 * `refund.authorize`; nothing here has moved any money.
 */
export const adminRecoveryResolutionSchema = z.object({
  /**
   * The record's own identifier, not the job's. A correction has to name the
   * exact record it supersedes, so the chain needs something to point at.
   */
  id: z.string().uuid(),
  printJobId: z.string().uuid(),
  outcome: z.enum(RECOVERY_OUTCOMES),
  reason: z.string().max(280),
  refundSuggested: z.boolean(),
  observedSheets: z.number().int().nullable(),
  resolvedByAdminUserId: z.string().uuid(),
  resolvedByDisplayName: z.string().max(120).nullable(),
  resolvedByRole: z.string().max(24),
  resolvedAt: isoTimestamp
});

/**
 * A later, higher-authority account of the same print.
 *
 * A correction never replaces the row it supersedes — both stay readable, and
 * the chain of them is the record of how the account of one print changed and
 * who changed it. `supersedesId` names the exact record the corrector was
 * looking at, which is what makes two simultaneous corrections a conflict
 * rather than a race.
 */
export const adminRecoveryCorrectionSchema = z.object({
  id: z.string().uuid(),
  printJobId: z.string().uuid(),
  /** The resolution or earlier correction this one supersedes. */
  supersedesId: z.string().uuid(),
  outcome: z.enum(RECOVERY_OUTCOMES),
  reason: z.string().max(280),
  refundSuggested: z.boolean(),
  observedSheets: z.number().int().nullable(),
  correctedByAdminUserId: z.string().uuid(),
  correctedByDisplayName: z.string().max(120).nullable(),
  correctedByRole: z.string().max(24),
  correctedAt: isoTimestamp
});

export const adminPrintJobDetailResponseSchema = z.object({
  job: adminPrintJobSchema,
  /** Present only for a caller holding `print.diagnostics.read`. */
  ledger: z.array(adminPrintJobEventSchema).nullable(),
  command: adminAgentCommandSchema.nullable(),
  /** What a person recorded seeing, if anybody has yet. */
  resolution: adminRecoveryResolutionSchema.nullable(),
  /**
   * Corrections to that observation, oldest first. Almost always empty: this
   * exists so a mistake can be put right without anybody editing evidence, not
   * because correcting is expected to be routine.
   */
  corrections: z.array(adminRecoveryCorrectionSchema)
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export const adminPaymentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  kioskId: z.string().max(64),
  provider: z.string().max(24),
  /**
   * The provider's own identifier for this intent. Reconciliation is
   * impossible without it, so it is gated behind `payment.reconcile.read`
   * rather than shown to everyone who can see that a payment exists.
   */
  providerIntentId: z.string().max(120).nullable(),
  status: operationalState,
  /** True only when this capture is what moved the session to PAID. */
  appliedToSession: z.boolean(),
  amountMinor: z.number().int(),
  currency: z.string().length(3),
  currencyExponent: z.number().int().nonnegative(),
  failureCode: operationalCode.nullable(),
  attempts: z.number().int().nonnegative(),
  expiresAt: isoTimestamp,
  createdAt: isoTimestamp,
  authorizedAt: isoTimestamp.nullable(),
  capturedAt: isoTimestamp.nullable(),
  failedAt: isoTimestamp.nullable()
});

export const adminPaymentsResponseSchema = z.object({
  items: z.array(adminPaymentSchema),
  nextCursor: z.string().nullable(),
  scoped: z.boolean()
});

/**
 * Money owed back.
 *
 * This is a read. Creating or settling an obligation is `refund.authorize`,
 * which is a different capability held by different people and arrives in a
 * later phase — seeing that a refund is owed must never be the same permission
 * as deciding to pay it.
 */
export const adminRefundSchema = z.object({
  id: z.string().uuid(),
  paymentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  provider: z.string().max(24),
  reason: operationalState,
  status: operationalState,
  amountMinor: z.number().int(),
  currency: z.string().length(3),
  currencyExponent: z.number().int().nonnegative(),
  createdAt: isoTimestamp,
  completedAt: isoTimestamp.nullable(),
  /** How long this obligation has been outstanding, in whole hours. */
  outstandingHours: z.number().int().nonnegative().nullable(),
  /**
   * The person who authorized this obligation from the panel, if one did.
   *
   * Null for a refund the payment path raised on its own — a late capture or an
   * amount mismatch, where the provider's own report is the justification. The
   * distinction is worth showing: "the system noticed" and "a named person
   * decided" are different kinds of claim on the same ledger.
   */
  authorizedByDisplayName: z.string().max(120).nullable(),
  authorizationReason: z.string().max(280).nullable()
});

export const adminRefundsResponseSchema = z.object({
  items: z.array(adminRefundSchema),
  nextCursor: z.string().nullable(),
  unsettledCount: z.number().int().nonnegative()
});

/**
 * Who decided that money was owed, on what evidence, and why.
 *
 * Kept beside the obligation rather than inside it: `refunds` is the ledger the
 * payment path also writes to, and a row there means the same thing whoever
 * raised it. This is the provenance of the ones a person raised — the print it
 * was about, the account of that print they were reading, and the words they
 * wrote down at the time.
 *
 * `status` is the refund's own, and it is `PENDING` here. Authorizing is not
 * settling: the money moves when an executor with a provider credential acts on
 * this obligation, and nothing in the control plane holds one.
 */
export const adminRefundAuthorizationSchema = z.object({
  refundId: z.string().uuid(),
  printJobId: z.string().uuid(),
  paymentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  currencyExponent: z.number().int().nonnegative(),
  reason: z.string().max(280),
  status: operationalState,
  /** The account of the print that justified it, as it read at that moment. */
  observedOutcome: z.enum(RECOVERY_OUTCOMES),
  authorizedByAdminUserId: z.string().uuid(),
  authorizedByDisplayName: z.string().max(120).nullable(),
  authorizedByRole: z.string().max(24),
  authorizedAt: isoTimestamp
});

export type AdminRefundAuthorization = z.infer<typeof adminRefundAuthorizationSchema>;

// ---------------------------------------------------------------------------
// The refund queue
// ---------------------------------------------------------------------------

/**
 * Why a print is waiting for somebody who can decide about money.
 *
 * Two different questions, deliberately not merged. `REFUND_SUGGESTED` is a
 * person saying pages are missing; the decision is how much. `UNRESOLVABLE` is
 * a person saying nobody could tell what happened, which suggests no refund and
 * used to drop off every list at that point — it is a judgement call that needs
 * more authority than the operator who could not make it, not a closed case.
 */
export const REFUND_QUEUE_REASONS = ["REFUND_SUGGESTED", "UNRESOLVABLE"] as const;
export type RefundQueueReason = (typeof REFUND_QUEUE_REASONS)[number];

/**
 * One print awaiting a money decision.
 *
 * The money on it is stated in full — what was captured, what has already been
 * returned, and therefore the most that may still be authorized — because the
 * alternative is an Admin doing that arithmetic from three screens.
 */
export const adminRefundQueueEntrySchema = z.object({
  printJobId: z.string().uuid(),
  sessionId: z.string().uuid(),
  kioskId: z.string().max(64),
  queueReason: z.enum(REFUND_QUEUE_REASONS),
  /** The effective account of the print: the newest correction, or the original. */
  outcome: z.enum(RECOVERY_OUTCOMES),
  reason: z.string().max(280),
  observedSheets: z.number().int().nullable(),
  /** What the device itself reported, kept beside the human account. */
  sheetsProduced: z.number().int().nullable(),
  physicalSheets: z.number().int().nonnegative(),
  observedByDisplayName: z.string().max(120).nullable(),
  observedAt: isoTimestamp,
  /** True when the effective account above is a correction, not the original. */
  corrected: z.boolean(),
  paymentId: z.string().uuid(),
  capturedAmountMinor: z.number().int().nonnegative(),
  /** Already owed or returned on this payment, from every reason combined. */
  refundedAmountMinor: z.number().int().nonnegative(),
  /** Captured minus refunded: the ceiling the server will enforce. */
  authorizableAmountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  currencyExponent: z.number().int().nonnegative()
});

export const adminRefundQueueResponseSchema = z.object({
  items: z.array(adminRefundQueueEntrySchema),
  nextCursor: z.string().nullable(),
  totals: z.object({
    suggested: z.number().int().nonnegative(),
    unresolvable: z.number().int().nonnegative()
  })
});

/**
 * What the observation implies is owed, as a starting point for a person.
 *
 * A suggestion and nothing more. The server bounds what may be authorized but
 * does not compute it, because the arithmetic below cannot know that the
 * customer reprinted two of the ruined sheets themselves — and an amount the
 * system insisted on would be an amount nobody took responsibility for.
 *
 * Nothing came out means everything still authorizable is owed. Some of it came
 * out means the sheets that did not, pro rata. Nobody could tell means there is
 * no arithmetic to do, which is exactly why that case needs a person.
 */
export function suggestedRefundMinor(entry: {
  outcome: RecoveryOutcome;
  observedSheets: number | null;
  physicalSheets: number;
  authorizableAmountMinor: number;
}): number | null {
  if (entry.authorizableAmountMinor <= 0) return null;

  switch (entry.outcome) {
    case "NOT_DELIVERED":
      return entry.authorizableAmountMinor;
    case "PARTIALLY_DELIVERED": {
      if (entry.observedSheets === null || entry.physicalSheets <= 0) return null;
      const missing = Math.max(entry.physicalSheets - entry.observedSheets, 0);
      if (missing === 0) return null;
      const owed = Math.round((entry.authorizableAmountMinor * missing) / entry.physicalSheets);
      return Math.min(Math.max(owed, 1), entry.authorizableAmountMinor);
    }
    case "DELIVERED":
    case "UNRESOLVABLE":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export const adminRetentionRunSchema = z.object({
  sessionId: z.string().uuid(),
  kioskId: z.string().max(64),
  sessionState: adminSessionStateSchema,
  reason: operationalState,
  status: operationalState,
  checkpoint: operationalState,
  attempts: z.number().int().nonnegative(),
  lastErrorCode: operationalCode.nullable(),
  objectsDeleted: z.number().int().nonnegative(),
  orphanObjectsDeleted: z.number().int().nonnegative(),
  availableAt: isoTimestamp,
  dueAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  completedAt: isoTimestamp.nullable(),
  deadLetteredAt: isoTimestamp.nullable(),
  /** Past its deadline with documents still present. A privacy alarm. */
  overdue: z.boolean()
});

export const adminRetentionResponseSchema = z.object({
  items: z.array(adminRetentionRunSchema),
  nextCursor: z.string().nullable(),
  totals: z.object({
    pending: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    deadLettered: z.number().int().nonnegative()
  }),
  scoped: z.boolean()
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ADMIN_ERROR_SUBSYSTEMS = [
  "UPLOAD",
  "DOCUMENT_PROCESSING",
  "PAYMENT",
  "PRINTING",
  "KIOSK_AGENT",
  "RETENTION",
  "EVENT_PUBLISHING"
] as const;
export type AdminErrorSubsystem = (typeof ADMIN_ERROR_SUBSYSTEMS)[number];

/**
 * Failures grouped by what broke rather than listed one by one.
 *
 * Thirty rows of the same code from one kiosk is one problem, and a list makes
 * it look like thirty. The grouping is also what keeps this query bounded.
 */
export const adminErrorGroupSchema = z.object({
  subsystem: z.enum(ADMIN_ERROR_SUBSYSTEMS),
  code: operationalCode,
  kioskId: z.string().max(64).nullable(),
  count: z.number().int().positive(),
  lastSeenAt: isoTimestamp,
  /**
   * Who most recently said they were looking at this, if anybody.
   *
   * Deliberately not a resolution: acknowledging changes nothing and clears
   * nothing. It exists so two operators do not both walk to the same kiosk, and
   * it ages out with the window it was made in.
   */
  acknowledgedAt: isoTimestamp.nullable(),
  acknowledgedBy: z.string().max(120).nullable(),
  /**
   * True when the failure has happened again since it was acknowledged, which
   * is the case where "somebody is on it" stops being reassuring.
   */
  recurredSinceAcknowledgement: z.boolean()
});

export const adminErrorsResponseSchema = z.object({
  windowHours: z.number().int().positive(),
  groups: z.array(adminErrorGroupSchema),
  /** True when the group list hit its ceiling and more codes exist. */
  truncated: z.boolean(),
  scoped: z.boolean()
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const adminAuditEntrySchema = z.object({
  id: z.string().uuid(),
  occurredAt: isoTimestamp,
  actorType: z.string().max(32),
  actorId: z.string().max(100),
  /** Resolved for admin actors so a log reads as people, not identifiers. */
  actorDisplayName: z.string().max(120).nullable(),
  kioskId: z.string().max(64).nullable(),
  sessionId: z.string().uuid().nullable(),
  action: z.string().max(100),
  outcome: z.string().max(32),
  requestId: z.string().max(100).nullable(),
  /**
   * Passed through an allow-list rather than returned as stored. The write path
   * already restricts what admin actions may record, but rows written by the
   * kiosk, mobile and worker paths predate that restriction, and a log viewer
   * is the wrong place to discover what an older caller decided to include.
   */
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** Keys dropped by that allow-list, so nothing is hidden silently. */
  redactedKeys: z.array(z.string().max(60))
});

export const adminAuditResponseSchema = z.object({
  items: z.array(adminAuditEntrySchema),
  nextCursor: z.string().nullable(),
  /** SELF when the caller may only see their own actions. */
  scope: z.enum(["ALL", "SELF"])
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
export type AdminKiosksResponse = z.infer<typeof adminKiosksResponseSchema>;
export type AdminKiosk = z.infer<typeof adminKioskSchema>;
export type AdminSessionsResponse = z.infer<typeof adminSessionsResponseSchema>;
export type AdminSessionSummary = z.infer<typeof adminSessionSummarySchema>;
export type AdminSessionDetailResponse = z.infer<typeof adminSessionDetailResponseSchema>;
export type AdminTimelineResponse = z.infer<typeof adminTimelineResponseSchema>;
export type AdminDocumentsResponse = z.infer<typeof adminDocumentsResponseSchema>;
export type AdminPrintJobsResponse = z.infer<typeof adminPrintJobsResponseSchema>;
export type AdminPrintJobDetailResponse = z.infer<typeof adminPrintJobDetailResponseSchema>;
export type AdminDeviceDetail = z.infer<typeof adminDeviceDetailSchema>;
export type AdminRecoveryResolution = z.infer<typeof adminRecoveryResolutionSchema>;
export type AdminRecoveryCorrection = z.infer<typeof adminRecoveryCorrectionSchema>;
export type AdminPaymentsResponse = z.infer<typeof adminPaymentsResponseSchema>;
export type AdminRefundsResponse = z.infer<typeof adminRefundsResponseSchema>;
export type AdminRefundQueueEntry = z.infer<typeof adminRefundQueueEntrySchema>;
export type AdminRefundQueueResponse = z.infer<typeof adminRefundQueueResponseSchema>;
export type AdminRetentionResponse = z.infer<typeof adminRetentionResponseSchema>;
export type AdminErrorsResponse = z.infer<typeof adminErrorsResponseSchema>;
export type AdminAuditResponse = z.infer<typeof adminAuditResponseSchema>;
