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
  copies: z.number().int().positive(),
  duplex: operationalState,
  paperSize: operationalState,
  orientation: operationalState,
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
  overdue: z.boolean()
});

export const adminPrintJobsResponseSchema = z.object({
  items: z.array(adminPrintJobSchema),
  nextCursor: z.string().nullable(),
  scoped: z.boolean()
});

/** The device ledger. Technical Admins only; still no raw event payloads. */
export const adminPrintJobEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.string().max(32),
  status: operationalState,
  confidence: operationalState.nullable(),
  failureCode: operationalCode.nullable(),
  warningCode: operationalCode.nullable(),
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

export const adminPrintJobDetailResponseSchema = z.object({
  job: adminPrintJobSchema,
  /** Present only for a caller holding `print.diagnostics.read`. */
  ledger: z.array(adminPrintJobEventSchema).nullable(),
  command: adminAgentCommandSchema.nullable()
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
  outstandingHours: z.number().int().nonnegative().nullable()
});

export const adminRefundsResponseSchema = z.object({
  items: z.array(adminRefundSchema),
  nextCursor: z.string().nullable(),
  unsettledCount: z.number().int().nonnegative()
});

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
  lastSeenAt: isoTimestamp
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
export type AdminPaymentsResponse = z.infer<typeof adminPaymentsResponseSchema>;
export type AdminRefundsResponse = z.infer<typeof adminRefundsResponseSchema>;
export type AdminRetentionResponse = z.infer<typeof adminRetentionResponseSchema>;
export type AdminErrorsResponse = z.infer<typeof adminErrorsResponseSchema>;
export type AdminAuditResponse = z.infer<typeof adminAuditResponseSchema>;
