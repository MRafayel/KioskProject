import {
  ADMIN_PAGE_SIZE,
  CAPTURED_PAYMENT_STATUSES,
  PAPER_ESTIMATE_MAX_SHEETS,
  PAPER_GETTING_LOW_THRESHOLD_SHEETS,
  PAPER_REFILL_SOON_THRESHOLD_SHEETS,
  UNFINISHED_PAYMENT_STATUSES,
  adminDeviceDetailSchema,
  classifyKioskLiveness,
  classifyPaperEstimate,
  decodeAdminCursor,
  deriveAttention,
  encodeAdminCursor,
  incidentKey,
  isAdminRole,
  isAdminUserStatus,
  minimumAuthenticators,
  type AdminAttentionCode,
  type AdminDeviceDetail,
  type AdminAuditResponse,
  type AdminDocumentsResponse,
  type AdminErrorsResponse,
  type AdminKiosksResponse,
  type AdminKioskPaperResponse,
  type AdminKioskPaperSummary,
  type AdminMoneySummaryResponse,
  type AdminOverviewResponse,
  type AdminPaymentsResponse,
  type AdminPeopleResponse,
  type AdminRole,
  type AdminUserStatus,
  type AdminPrintJobDetailResponse,
  type AdminPrintJobsResponse,
  type AdminRecoveryCorrection,
  type AdminRecoveryResolution,
  type AdminRefundQueueEntry,
  type AdminRefundQueueResponse,
  type AdminRefundsResponse,
  type AdminRetentionResponse,
  type AdminSessionDetailResponse,
  type AdminSessionsResponse,
  type AdminTimelineResponse,
  type MoneyWindow
} from "@printing-kiosk/admin-access";
import { isTerminalSessionState, SESSION_STATES, type SessionState } from "@printing-kiosk/domain";

import type { Clock } from "../sessions/crypto.js";
import { ADMIN_ACTOR_TYPE, projectAuditMetadata } from "./audit.js";
import type { AdminReadDatabase } from "./read-database.js";

/**
 * Everything the control plane can see about the printing system.
 *
 * Three rules run through every method here.
 *
 * It only reads. The database handle is typed so that no write method exists
 * (`read-database.ts`), the pool it comes from is opened read-only, and in
 * production it connects as a role that holds no write grant. Phase 2's gate is
 * "no mutations exist" and it is asserted three ways rather than promised once.
 *
 * It never returns document content. Not the customer's filename, not a content
 * digest, not an object key, not a print manifest, not a rendered page. Those
 * columns are not granted to the reader role and not present in the response
 * schemas, so a query written in a hurry cannot produce one.
 *
 * It never outruns the print path. Every list is keyset-paged with a fixed
 * ceiling, every aggregate is bounded by an index this schema already has, the
 * overview is cached for a few seconds so a wall of open dashboards costs one
 * query rather than one per person, and the connection cancels anything slow.
 * A dashboard being a few seconds stale is not a problem; a dashboard competing
 * with a paid print job for a connection is.
 */

export interface AdminObservabilityOptions {
  database: AdminReadDatabase;
  clock: Clock;
  /**
   * How long an overview snapshot is reused. Short enough that an operator
   * refreshing after an incident sees the change, long enough that a dozen
   * dashboards do not multiply into a dozen times the query load.
   */
  overviewCacheMilliseconds?: number;
}

/**
 * Which kiosks the caller may see.
 *
 * `null` means unrestricted. An Operator is restricted to their assigned
 * kiosks, and an Operator with no assignment sees nothing — the safe default
 * for a newly created account, and the reason this is a list rather than a
 * flag.
 */
export interface AdminReadScope {
  kioskIds: readonly string[] | null;
}

export function scopeForAdmin(admin: {
  role: string;
  kioskScopes: readonly string[];
}): AdminReadScope {
  return admin.role === "OPERATOR" ? { kioskIds: admin.kioskScopes } : { kioskIds: null };
}

/** A stuck cleanup, distinguished from one the worker simply has not reached. */
const RETENTION_OVERDUE_GRACE_MILLISECONDS = 900_000;
/** The window "recently" means on the overview and in the error centre. */
const DEFAULT_ERROR_WINDOW_HOURS = 24;
/** Enough distinct failures to see a pattern; not enough to be a data dump. */
const MAX_ERROR_GROUPS = 60;
/**
 * A ceiling on the acknowledgements read back to annotate those groups. Well
 * above the number of distinct groups, so the newest acknowledgement of every
 * group that can be displayed is always among them.
 */
const MAX_ACKNOWLEDGEMENTS = 400;
/** Distinct operator scopes are few; this only stops the map growing forever. */
const MAX_CACHED_OVERVIEWS = 32;

/**
 * How many payment rows the trend read will take before giving up on drawing.
 *
 * The totals beside it are counted by the database and are unaffected by this;
 * the only thing the ceiling protects is a `findMany` over a month of a
 * business far larger than this one. Above it the panel draws no chart rather
 * than a chart of the first twenty thousand payments labelled as the month.
 */
const MAX_TREND_ROWS = 20_000;

/** How wide each window is, and how finely it is cut. */
const MONEY_WINDOW_SHAPE: Readonly<
  Record<MoneyWindow, { interval: "HOUR" | "DAY"; bars: number; barMilliseconds: number }>
> = {
  DAY: { interval: "HOUR", bars: 24, barMilliseconds: 3_600_000 },
  WEEK: { interval: "DAY", bars: 7, barMilliseconds: 86_400_000 },
  MONTH: { interval: "DAY", bars: 30, barMilliseconds: 86_400_000 }
};

const LIVE_SESSION_STATES = SESSION_STATES.filter((state) => !isTerminalSessionState(state));
const OPEN_PRINT_STATUSES = ["QUEUED", "DISPATCHED", "PRINTING"] as const;
/** Shared with the panel, so "unfinished" is one definition rather than two. */
const OPEN_PAYMENT_STATUSES = UNFINISHED_PAYMENT_STATUSES;
const ACTIVE_CLEANUP_STATUSES = ["PENDING", "IN_PROGRESS", "DEAD_LETTER"] as const;
/** Agent command states that mean something went wrong, rather than finished. */
const FAILED_COMMAND_STATUSES = ["FAILED", "EXPIRED"] as const;

interface CachedOverview {
  computedAt: number;
  value: Omit<AdminOverviewResponse, "snapshotAgeMilliseconds">;
}

export class AdminObservabilityService {
  private readonly overviewCache = new Map<string, CachedOverview>();

  public constructor(private readonly options: AdminObservabilityOptions) {}

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  public async overview(scope: AdminReadScope): Promise<AdminOverviewResponse> {
    const now = this.options.clock.now();
    const key = scopeKey(scope);
    const ttl = this.options.overviewCacheMilliseconds ?? 5_000;
    const cached = this.overviewCache.get(key);

    if (cached && now.getTime() - cached.computedAt < ttl) {
      return { ...cached.value, snapshotAgeMilliseconds: now.getTime() - cached.computedAt };
    }

    const value = await this.computeOverview(scope, now);
    if (this.overviewCache.size >= MAX_CACHED_OVERVIEWS) {
      const oldest = this.overviewCache.keys().next();
      if (!oldest.done) this.overviewCache.delete(oldest.value);
    }
    this.overviewCache.set(key, { computedAt: now.getTime(), value });
    return { ...value, snapshotAgeMilliseconds: 0 };
  }

  private async computeOverview(
    scope: AdminReadScope,
    now: Date
  ): Promise<Omit<AdminOverviewResponse, "snapshotAgeMilliseconds">> {
    const since = new Date(now.getTime() - DEFAULT_ERROR_WINDOW_HOURS * 3_600_000);
    const retentionCutoff = new Date(now.getTime() - RETENTION_OVERDUE_GRACE_MILLISECONDS);
    const kioskWhere = scopedKioskIdFilter(scope);
    const kioskScope = scopedKioskFilter(scope);
    const viaSession = scopedViaSessionFilter(scope);

    const [
      kiosks,
      sessionStates,
      printStatuses,
      overduePrints,
      failedPrints,
      unconfirmedPrints,
      documentStatuses,
      failedDocuments,
      awaitingScan,
      cleanupStatuses,
      overdueRetention,
      paymentStatuses,
      expiredPayments,
      unsettledRefunds,
      recoveryJobs,
      unresolvedRecoveryJobs
    ] = await Promise.all([
      // Few rows and every field is needed to classify liveness, so this is one
      // query rather than five counts.
      this.options.database.kiosk.findMany({
        where: kioskWhere,
        select: { status: true, lastSeenAt: true }
      }),
      this.options.database.printSession.groupBy({
        by: ["state"],
        where: { ...kioskScope, state: { in: [...LIVE_SESSION_STATES, "RECOVERY_REQUIRED"] } },
        _count: true
      }),
      this.options.database.printJob.groupBy({
        by: ["status"],
        where: { ...kioskScope, status: { in: [...OPEN_PRINT_STATUSES] } },
        _count: true
      }),
      this.options.database.printJob.count({
        where: {
          ...kioskScope,
          status: { in: [...OPEN_PRINT_STATUSES] },
          deadlineAt: { lt: now }
        }
      }),
      this.options.database.printJob.count({
        where: {
          ...kioskScope,
          status: "FAILED",
          createdAt: { gte: since }
        }
      }),
      this.options.database.printJob.count({
        where: {
          ...kioskScope,
          resultConfidence: "UNCONFIRMED",
          createdAt: { gte: since }
        }
      }),
      this.options.database.uploadedFile.groupBy({
        by: ["status"],
        where: { ...viaSession, deletedAt: null },
        _count: true
      }),
      // A processing failure has no status of its own — the row stays
      // QUARANTINED and grows an error code — so it is counted by the code
      // rather than inferred from a state that never appears.
      this.options.database.uploadedFile.count({
        where: { ...viaSession, processingErrorCode: { not: null }, deletedAt: null }
      }),
      this.options.database.uploadedFile.count({
        where: {
          ...viaSession,
          malwareScanStatus: { in: ["PENDING", "SCANNING"] },
          deletedAt: null
        }
      }),
      this.options.database.printSession.groupBy({
        by: ["cleanupStatus"],
        where: { ...kioskScope, cleanupStatus: { in: [...ACTIVE_CLEANUP_STATUSES] } },
        _count: true
      }),
      // The privacy alarm: past its deadline and not proven destroyed.
      this.options.database.printSession.count({
        where: {
          ...kioskScope,
          cleanupStatus: { in: [...ACTIVE_CLEANUP_STATUSES] },
          cleanupDueAt: { lt: retentionCutoff },
          filesDeletedAt: null
        }
      }),
      this.options.database.payment.groupBy({
        by: ["status"],
        where: {
          ...viaSession,
          status: { in: [...OPEN_PAYMENT_STATUSES] }
        },
        _count: true
      }),
      this.options.database.payment.count({
        where: {
          ...viaSession,
          status: { in: [...OPEN_PAYMENT_STATUSES] },
          expiresAt: { lt: now }
        }
      }),
      this.options.database.refund.count({
        where: {
          ...viaSession,
          completedAt: null
        }
      }),
      this.options.database.printJob.count({
        where: { ...kioskScope, status: "RECOVERY_REQUIRED" }
      }),
      // The worklist counts this one rather than the total. An operator who
      // records what they saw has to watch the number they are working through
      // go down, or they stop believing it — and a queue that never shrinks is
      // one people learn to scroll past.
      this.options.database.printJob.count({
        where: { ...kioskScope, status: "RECOVERY_REQUIRED", recoveryResolution: { is: null } }
      })
    ]);

    const liveness = { online: 0, degraded: 0, offline: 0, notActive: 0 };
    for (const kiosk of kiosks) {
      if (kiosk.status !== "ACTIVE") {
        liveness.notActive += 1;
        continue;
      }
      const state = classifyKioskLiveness(kiosk.lastSeenAt, now);
      if (state === "ONLINE") liveness.online += 1;
      else if (state === "DEGRADED") liveness.degraded += 1;
      else liveness.offline += 1;
    }

    const sessionCounts = countsByKey(sessionStates, "state");
    const cleanupCounts = countsByKey(cleanupStatuses, "cleanupStatus");
    const documentCounts = countsByKey(documentStatuses, "status");

    const live = LIVE_SESSION_STATES.reduce(
      (total, state) => total + (sessionCounts[state] ?? 0),
      0
    );
    const recoveryRequired = sessionCounts.RECOVERY_REQUIRED ?? 0;
    const openPrints = sumValues(countsByKey(printStatuses, "status"));
    const pendingRetention = (cleanupCounts.PENDING ?? 0) + (cleanupCounts.IN_PROGRESS ?? 0);
    const deadLettered = cleanupCounts.DEAD_LETTER ?? 0;
    const openPayments = sumValues(countsByKey(paymentStatuses, "status"));
    const processingDocuments =
      (documentCounts.QUARANTINED ?? 0) +
      (documentCounts.VALIDATING ?? 0) +
      (documentCounts.UPLOADING ?? 0);

    const attention: Partial<Record<AdminAttentionCode, number>> = {
      RETENTION_DEAD_LETTERED: deadLettered,
      RETENTION_OVERDUE: overdueRetention,
      PRINT_RECOVERY_REQUIRED: unresolvedRecoveryJobs,
      REFUND_UNSETTLED: unsettledRefunds,
      PRINT_OVERDUE: overduePrints,
      DOCUMENT_PROCESSING_FAILED: failedDocuments,
      KIOSK_OFFLINE: liveness.offline,
      PAYMENT_EXPIRED_UNRESOLVED: expiredPayments
    };

    return {
      generatedAt: now.toISOString(),
      scoped: scope.kioskIds !== null,
      attention: deriveAttention(attention),
      kiosks: { total: kiosks.length, ...liveness },
      sessions: {
        live,
        awaitingPayment: sessionCounts.AWAITING_PAYMENT ?? 0,
        printing: sessionCounts.PRINTING ?? 0,
        recoveryRequired
      },
      printing: {
        open: openPrints,
        overdue: overduePrints,
        // Print jobs, not sessions. A session reaches RECOVERY_REQUIRED because
        // its job did, but it is the job a person acts on.
        recoveryRequired: recoveryJobs,
        recoveryUnresolved: unresolvedRecoveryJobs,
        failedRecently: failedPrints,
        unconfirmedRecently: unconfirmedPrints
      },
      documents: {
        processing: processingDocuments,
        failed: failedDocuments,
        awaitingScan
      },
      retention: { pending: pendingRetention, overdue: overdueRetention, deadLettered },
      money: { openPayments, expiredPayments, unsettledRefunds }
    };
  }

  // -------------------------------------------------------------------------
  // Kiosks
  // -------------------------------------------------------------------------

  public async kiosks(scope: AdminReadScope): Promise<AdminKiosksResponse> {
    const now = this.options.clock.now();
    const where = scopedKioskIdFilter(scope);

    // A deployment has tens of kiosks, not thousands. Reading them all and
    // counting alongside is cheaper and simpler than paging, and the ceiling
    // keeps that assumption from silently becoming false.
    const kiosks = await this.options.database.kiosk.findMany({
      where,
      orderBy: { name: "asc" },
      take: 200,
      select: {
        id: true,
        publicCode: true,
        name: true,
        status: true,
        timezone: true,
        lastSeenAt: true,
        paperInventory: {
          select: {
            estimatedSheets: true,
            lastRefillSheets: true,
            lastRefillNote: true,
            lastRefillById: true,
            lastRefillAt: true,
            lastRefillBy: { select: { displayName: true } }
          }
        }
      }
    });

    const kioskIds = kiosks.map((kiosk) => kiosk.id);
    const [liveSessions, openJobs, recoveryJobs, agents, printers] = await Promise.all([
      this.options.database.printSession.groupBy({
        by: ["kioskId"],
        where: { kioskId: { in: kioskIds }, state: { in: [...LIVE_SESSION_STATES] } },
        _count: true
      }),
      this.options.database.printJob.groupBy({
        by: ["kioskId"],
        where: { kioskId: { in: kioskIds }, status: { in: [...OPEN_PRINT_STATUSES] } },
        _count: true
      }),
      this.options.database.printJob.groupBy({
        by: ["kioskId"],
        where: { kioskId: { in: kioskIds }, status: "RECOVERY_REQUIRED" },
        _count: true
      }),
      this.options.database.kioskAgent.findMany({
        where: { kioskId: { in: kioskIds } },
        orderBy: [{ lastHeartbeatAt: "desc" }, { updatedAt: "desc" }],
        take: 400,
        select: {
          kioskId: true,
          agentVersion: true,
          platform: true,
          platformRelease: true,
          adapter: true,
          queueName: true,
          printerHealth: true,
          activeOperations: true,
          lastHeartbeatAt: true
        }
      }),
      this.options.database.printer.findMany({
        where: { kioskId: { in: kioskIds }, approval: "APPROVED" },
        orderBy: { updatedAt: "desc" },
        take: 200,
        select: {
          kioskId: true,
          queueName: true,
          approval: true,
          queueState: true,
          health: true,
          warningCode: true,
          driverName: true,
          portName: true,
          shared: true,
          lastSeenAt: true
        }
      })
    ]);

    const live = countsByKey(liveSessions, "kioskId");
    const open = countsByKey(openJobs, "kioskId");
    const recovery = countsByKey(recoveryJobs, "kioskId");
    const agentByKiosk = new Map<string, (typeof agents)[number]>();
    for (const agent of agents) {
      if (!agentByKiosk.has(agent.kioskId)) agentByKiosk.set(agent.kioskId, agent);
    }
    const printerByKiosk = new Map(printers.map((printer) => [printer.kioskId, printer]));

    return {
      scoped: scope.kioskIds !== null,
      items: kiosks.map((kiosk) => {
        const agent = agentByKiosk.get(kiosk.id);
        const printer = printerByKiosk.get(kiosk.id);
        return {
          id: kiosk.id,
          publicCode: kiosk.publicCode,
          name: kiosk.name,
          status: kiosk.status,
          timezone: kiosk.timezone,
          lastSeenAt: kiosk.lastSeenAt?.toISOString() ?? null,
          liveness: classifyKioskLiveness(kiosk.lastSeenAt, now),
          agent: agent
            ? {
                liveness: classifyKioskLiveness(agent.lastHeartbeatAt, now),
                version: agent.agentVersion,
                platform: agent.platform,
                platformRelease: agent.platformRelease,
                adapter: agent.adapter,
                queueName: agent.queueName,
                printerHealth: agent.printerHealth,
                activeOperations: agent.activeOperations,
                lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null
              }
            : null,
          printer: printer
            ? {
                queueName: printer.queueName,
                approval: printer.approval,
                queueState: printer.queueState,
                health: printer.health,
                warningCode: printer.warningCode,
                driverName: printer.driverName,
                portName: printer.portName,
                shared: printer.shared,
                lastSeenAt: printer.lastSeenAt.toISOString()
              }
            : null,
          liveSessions: live[kiosk.id] ?? 0,
          openPrintJobs: open[kiosk.id] ?? 0,
          recoveryRequiredJobs: recovery[kiosk.id] ?? 0,
          // No row is a kiosk nobody has started tracking, which is not the
          // same as an empty tray.
          paper: paperSummary(kiosk.paperInventory)
        };
      })
    };
  }

  /**
   * One kiosk's current paper estimate.
   *
   * It used to page an event history beside this. There is no history to page:
   * the estimate is a single count that refills, corrections and confirmed
   * prints write directly, and who changed it and why is in the admin audit
   * log with every other admin action.
   */
  public async kioskPaper(
    scope: AdminReadScope,
    kioskId: string
  ): Promise<AdminKioskPaperResponse | null> {
    const kiosk = await this.options.database.kiosk.findFirst({
      where: scopedKioskIdFilter(scope, kioskId),
      select: {
        id: true,
        paperInventory: {
          select: {
            estimatedSheets: true,
            lastRefillSheets: true,
            lastRefillNote: true,
            lastRefillById: true,
            lastRefillAt: true,
            lastRefillBy: { select: { displayName: true } }
          }
        }
      }
    });
    if (!kiosk) return null;

    return { kioskId, paper: paperSummary(kiosk.paperInventory) };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  public async sessions(
    scope: AdminReadScope,
    filters: {
      kioskId?: string | undefined;
      state?: SessionState | undefined;
      cursor?: string | undefined;
    }
  ): Promise<AdminSessionsResponse> {
    const cursor = filters.cursor ? decodeAdminCursor(filters.cursor) : null;

    const rows = await this.options.database.printSession.findMany({
      where: {
        ...scopedKioskFilter(scope, filters.kioskId),
        ...(filters.state ? { state: filters.state } : {}),
        ...keysetWhere("createdAt", cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_PAGE_SIZE + 1,
      select: {
        id: true,
        publicId: true,
        kioskId: true,
        state: true,
        createdAt: true,
        updatedAt: true,
        idleExpiresAt: true,
        hardExpiresAt: true,
        terminalReason: true,
        cleanupStatus: true,
        cleanupDueAt: true,
        filesDeletedAt: true,
        _count: { select: { uploadedFiles: true } },
        printJobs: { select: { status: true }, take: 1 },
        payments: { select: { status: true }, orderBy: { createdAt: "desc" }, take: 1 }
      }
    });

    const page = rows.slice(0, ADMIN_PAGE_SIZE);
    return {
      scoped: scope.kioskIds !== null,
      nextCursor: nextCursorFrom(rows, page, (row) => ({ at: row.createdAt, id: row.id })),
      items: page.map((row) => ({
        id: row.id,
        publicId: row.publicId,
        kioskId: row.kioskId,
        state: row.state as SessionState,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        idleExpiresAt: row.idleExpiresAt.toISOString(),
        hardExpiresAt: row.hardExpiresAt.toISOString(),
        terminalReason: row.terminalReason,
        cleanupStatus: row.cleanupStatus,
        cleanupDueAt: row.cleanupDueAt?.toISOString() ?? null,
        filesDeletedAt: row.filesDeletedAt?.toISOString() ?? null,
        documentCount: row._count.uploadedFiles,
        printJobStatus: row.printJobs[0]?.status ?? null,
        paymentStatus: row.payments[0]?.status ?? null
      }))
    };
  }

  /**
   * One session in full.
   *
   * Returns null rather than throwing when the session is outside the caller's
   * kiosks, so the route can answer 404. A 403 would confirm the identifier
   * names something real, which is the whole of an enumeration attack.
   */
  public async session(
    scope: AdminReadScope,
    sessionId: string
  ): Promise<AdminSessionDetailResponse | null> {
    const session = await this.options.database.printSession.findFirst({
      where: { id: sessionId, ...scopedKioskFilter(scope) },
      select: {
        id: true,
        publicId: true,
        kioskId: true,
        state: true,
        createdAt: true,
        updatedAt: true,
        idleExpiresAt: true,
        hardExpiresAt: true,
        terminalReason: true,
        cleanupStatus: true,
        cleanupDueAt: true,
        filesDeletedAt: true,
        currentSettingsRevision: true,
        activeQuoteId: true
      }
    });
    if (!session) return null;

    const [documents, settings, quote, payment, refund, printJob] = await Promise.all([
      this.options.database.uploadedFile.findMany({
        where: { sessionId },
        select: { status: true, sizeBytes: true, pageCount: true, deletedAt: true }
      }),
      session.currentSettingsRevision === null
        ? null
        : this.options.database.printSettingRevision.findFirst({
            where: { sessionId, revision: session.currentSettingsRevision },
            select: {
              revision: true,
              paperSize: true,
              scaling: true,
              collate: true,
              colorMode: true,
              selectedPages: true,
              printedSides: true,
              physicalSheets: true,
              selectionsRedactedAt: true
            }
          }),
      this.options.database.priceQuote.findFirst({
        where: session.activeQuoteId ? { id: session.activeQuoteId } : { sessionId },
        orderBy: { createdAt: "desc" },
        select: {
          status: true,
          currency: true,
          currencyExponent: true,
          totalMinor: true
        }
      }),
      this.options.database.payment.findFirst({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
        select: { status: true, appliedToSession: true }
      }),
      this.options.database.refund.findFirst({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
        select: { status: true, amountMinor: true }
      }),
      this.options.database.printJob.findFirst({
        where: { sessionId },
        select: {
          id: true,
          status: true,
          resultConfidence: true,
          failureCode: true,
          warningCode: true
        }
      })
    ]);

    const documentTotals = documents.reduce(
      (totals, file) => ({
        total: totals.total + 1,
        ready: totals.ready + (file.status === "READY" ? 1 : 0),
        rejected: totals.rejected + (file.status === "REJECTED" ? 1 : 0),
        deleted: totals.deleted + (file.deletedAt ? 1 : 0),
        totalBytes: totals.totalBytes + (file.sizeBytes ?? 0),
        totalPages: totals.totalPages + (file.pageCount ?? 0)
      }),
      { total: 0, ready: 0, rejected: 0, deleted: 0, totalBytes: 0, totalPages: 0 }
    );

    return {
      session: {
        id: session.id,
        publicId: session.publicId,
        kioskId: session.kioskId,
        state: session.state as SessionState,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        idleExpiresAt: session.idleExpiresAt.toISOString(),
        hardExpiresAt: session.hardExpiresAt.toISOString(),
        terminalReason: session.terminalReason,
        cleanupStatus: session.cleanupStatus,
        cleanupDueAt: session.cleanupDueAt?.toISOString() ?? null,
        filesDeletedAt: session.filesDeletedAt?.toISOString() ?? null,
        documentCount: documentTotals.total,
        printJobStatus: printJob?.status ?? null,
        paymentStatus: payment?.status ?? null
      },
      settings: settings
        ? {
            revision: settings.revision,
            paperSize: settings.paperSize,
            scaling: settings.scaling,
            collate: settings.collate,
            colorMode: settings.colorMode,
            selectedPages: settings.selectedPages,
            printedSides: settings.printedSides,
            physicalSheets: settings.physicalSheets,
            selectionsRedactedAt: settings.selectionsRedactedAt?.toISOString() ?? null
          }
        : null,
      money: quote
        ? {
            currency: quote.currency,
            currencyExponent: quote.currencyExponent,
            totalMinor: quote.totalMinor,
            quoteStatus: quote.status,
            paymentStatus: payment?.status ?? null,
            paymentAppliedToSession: payment?.appliedToSession ?? null,
            refundStatus: refund?.status ?? null,
            refundAmountMinor: refund?.amountMinor ?? null
          }
        : null,
      documents: documentTotals,
      printJob: printJob
        ? {
            id: printJob.id,
            status: printJob.status,
            resultConfidence: printJob.resultConfidence,
            failureCode: printJob.failureCode,
            warningCode: printJob.warningCode
          }
        : null
    };
  }

  /**
   * The workflow as an ordered list.
   *
   * Type and timing only. The stored payload is not selected, not granted to
   * the reader role, and has no field in the response schema — see the contract
   * for why a passthrough JSON column has no place in a viewer.
   */
  public async timeline(
    scope: AdminReadScope,
    sessionId: string,
    cursor: string | undefined
  ): Promise<AdminTimelineResponse | null> {
    const session = await this.options.database.printSession.findFirst({
      where: { id: sessionId, ...scopedKioskFilter(scope) },
      select: { id: true }
    });
    if (!session) return null;

    const after = cursor ? decodeAdminCursor(cursor) : null;
    const rows = await this.options.database.sessionEvent.findMany({
      where: {
        sessionId,
        ...(after ? { sequence: { gt: Number(after.id) } } : {})
      },
      orderBy: { sequence: "asc" },
      take: ADMIN_PAGE_SIZE + 1,
      select: { sequence: true, type: true, occurredAt: true }
    });

    const page = rows.slice(0, ADMIN_PAGE_SIZE);
    let previous: Date | null = null;
    const items = page.map((row) => {
      const since = previous ? row.occurredAt.getTime() - previous.getTime() : null;
      previous = row.occurredAt;
      return {
        sequence: row.sequence,
        type: row.type,
        occurredAt: row.occurredAt.toISOString(),
        // Clamped at zero: two events can share a timestamp, and a negative
        // gap would read as time running backwards rather than as "instant".
        sincePreviousMilliseconds: since === null ? null : Math.max(0, since)
      };
    });

    const last = page.at(-1);
    return {
      sessionId,
      items,
      nextCursor:
        rows.length > ADMIN_PAGE_SIZE && last
          ? encodeAdminCursor({ at: last.occurredAt, id: String(last.sequence) })
          : null
    };
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  public async documents(
    scope: AdminReadScope,
    sessionId: string
  ): Promise<AdminDocumentsResponse | null> {
    const session = await this.options.database.printSession.findFirst({
      where: { id: sessionId, ...scopedKioskFilter(scope) },
      select: { id: true, filesDeletedAt: true }
    });
    if (!session) return null;

    const files = await this.options.database.uploadedFile.findMany({
      where: { sessionId },
      orderBy: { ordinal: "asc" },
      take: ADMIN_PAGE_SIZE,
      // Every field named here is a fact about the upload, not about its
      // contents. `display_name`, `content_sha256` and `quarantine_object_key`
      // are absent here and ungranted at the database.
      select: {
        id: true,
        ordinal: true,
        status: true,
        kind: true,
        declaredMime: true,
        detectedMime: true,
        extension: true,
        sizeBytes: true,
        pageCount: true,
        malwareScanStatus: true,
        rejectionCode: true,
        processingErrorCode: true,
        processingAttempts: true,
        createdAt: true,
        readyAt: true,
        deleteRequestedAt: true,
        deletedAt: true,
        cleanupDueAt: true,
        cleanupErrorCode: true
      }
    });

    return {
      sessionId,
      filesDeletedAt: session.filesDeletedAt?.toISOString() ?? null,
      items: files.map((file) => ({
        id: file.id,
        ordinal: file.ordinal,
        status: file.status,
        kind: file.kind,
        declaredMime: file.declaredMime,
        detectedMime: file.detectedMime,
        extension: file.extension,
        sizeBytes: file.sizeBytes,
        pageCount: file.pageCount,
        malwareScanStatus: file.malwareScanStatus,
        rejectionCode: file.rejectionCode,
        processingErrorCode: file.processingErrorCode,
        processingAttempts: file.processingAttempts,
        createdAt: file.createdAt.toISOString(),
        readyAt: file.readyAt?.toISOString() ?? null,
        deleteRequestedAt: file.deleteRequestedAt?.toISOString() ?? null,
        deletedAt: file.deletedAt?.toISOString() ?? null,
        cleanupDueAt: file.cleanupDueAt?.toISOString() ?? null,
        cleanupErrorCode: file.cleanupErrorCode
      }))
    };
  }

  // -------------------------------------------------------------------------
  // Printing
  // -------------------------------------------------------------------------

  public async printJobs(
    scope: AdminReadScope,
    filters: {
      kioskId?: string | undefined;
      status?: string | undefined;
      recoveryResolved?: "true" | "false" | undefined;
      cursor?: string | undefined;
    }
  ): Promise<AdminPrintJobsResponse> {
    const now = this.options.clock.now();
    const cursor = filters.cursor ? decodeAdminCursor(filters.cursor) : null;

    const rows = await this.options.database.printJob.findMany({
      where: {
        ...scopedKioskFilter(scope, filters.kioskId),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.recoveryResolved === undefined
          ? {}
          : {
              recoveryResolution:
                filters.recoveryResolved === "true" ? { isNot: null } : { is: null }
            }),
        ...keysetWhere("createdAt", cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_PAGE_SIZE + 1,
      select: PRINT_JOB_SELECT
    });

    const page = rows.slice(0, ADMIN_PAGE_SIZE);
    return {
      scoped: scope.kioskIds !== null,
      nextCursor: nextCursorFrom(rows, page, (row) => ({ at: row.createdAt, id: row.id })),
      items: page.map((row) => toPrintJob(row, now))
    };
  }

  public async printJob(
    scope: AdminReadScope,
    printJobId: string,
    includeDiagnostics: boolean
  ): Promise<AdminPrintJobDetailResponse | null> {
    const now = this.options.clock.now();
    const job = await this.options.database.printJob.findFirst({
      where: { id: printJobId, ...scopedKioskFilter(scope) },
      select: PRINT_JOB_SELECT
    });
    if (!job) return null;

    const [ledger, command, resolution, corrections] = await Promise.all([
      includeDiagnostics
        ? this.options.database.printJobEvent.findMany({
            where: { printJobId },
            orderBy: { sequence: "asc" },
            take: ADMIN_PAGE_SIZE,
            // `detail` is deliberately absent: it is free-form JSON and the
            // reader role holds no grant on it.
            select: {
              sequence: true,
              type: true,
              status: true,
              confidence: true,
              failureCode: true,
              warningCode: true,
              // The device's own account of the operation. Bounded by the agent
              // contract on the way in, and granted to the reader on its own
              // terms — unlike `detail`, which stays free-form and ungranted.
              deviceDetail: true,
              createdAt: true
            }
          })
        : null,
      this.options.database.agentCommand.findFirst({
        where: { printJobId },
        // `payload` names the documents the kiosk is to fetch. Not selected,
        // not granted.
        select: {
          type: true,
          status: true,
          attempts: true,
          claimedAt: true,
          leaseExpiresAt: true,
          expiresAt: true,
          resultCode: true,
          completedAt: true
        }
      }),
      // What a person recorded seeing, and who they are. Available to everyone
      // who can see the job: an observation is the answer to the question the
      // job is asking, so withholding it would leave the screen looking
      // unanswered while somebody had already answered it.
      this.options.database.printJobRecoveryResolution.findUnique({
        where: { printJobId },
        select: {
          id: true,
          printJobId: true,
          outcome: true,
          reason: true,
          refundSuggested: true,
          observedSheets: true,
          resolvedByAdminId: true,
          resolvedByRole: true,
          createdAt: true,
          resolvedBy: { select: { displayName: true } }
        }
      }),
      // Every correction to that observation, oldest first. Shown in full
      // rather than collapsed into a single current answer: a correction that
      // hid what it corrected would be an edit wearing a different name, and
      // the point of the chain is that both versions stay readable.
      this.options.database.printJobRecoveryCorrection.findMany({
        where: { printJobId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          printJobId: true,
          supersedesId: true,
          outcome: true,
          reason: true,
          refundSuggested: true,
          observedSheets: true,
          correctedByAdminId: true,
          correctedByRole: true,
          createdAt: true,
          correctedBy: { select: { displayName: true } }
        }
      })
    ]);

    return {
      job: toPrintJob(job, now),
      corrections: corrections.map((correction) => ({
        id: correction.id,
        printJobId: correction.printJobId,
        supersedesId: correction.supersedesId,
        outcome: correction.outcome as AdminRecoveryCorrection["outcome"],
        reason: correction.reason,
        refundSuggested: correction.refundSuggested,
        observedSheets: correction.observedSheets,
        correctedByAdminUserId: correction.correctedByAdminId,
        correctedByDisplayName: correction.correctedBy?.displayName ?? null,
        correctedByRole: correction.correctedByRole,
        correctedAt: correction.createdAt.toISOString()
      })),
      resolution: resolution
        ? {
            id: resolution.id,
            printJobId: resolution.printJobId,
            outcome: resolution.outcome as AdminRecoveryResolution["outcome"],
            reason: resolution.reason,
            refundSuggested: resolution.refundSuggested,
            observedSheets: resolution.observedSheets,
            resolvedByAdminUserId: resolution.resolvedByAdminId,
            resolvedByDisplayName: resolution.resolvedBy?.displayName ?? null,
            resolvedByRole: resolution.resolvedByRole,
            resolvedAt: resolution.createdAt.toISOString()
          }
        : null,
      ledger:
        ledger?.map((event) => ({
          sequence: event.sequence,
          type: event.type,
          status: event.status,
          confidence: event.confidence,
          failureCode: event.failureCode,
          warningCode: event.warningCode,
          // Re-read through the contract rather than trusted from the column.
          // It was bounded on the way in, but a stored shape outlives the code
          // that wrote it, and this response is a grant boundary.
          deviceDetail: readDeviceDetail(event.deviceDetail),
          createdAt: event.createdAt.toISOString()
        })) ?? null,
      command: command
        ? {
            type: command.type,
            status: command.status,
            attempts: command.attempts,
            claimedAt: command.claimedAt?.toISOString() ?? null,
            leaseExpiresAt: command.leaseExpiresAt?.toISOString() ?? null,
            expiresAt: command.expiresAt.toISOString(),
            resultCode: command.resultCode,
            completedAt: command.completedAt?.toISOString() ?? null
          }
        : null
    };
  }

  // -------------------------------------------------------------------------
  // Money
  // -------------------------------------------------------------------------

  public async payments(
    scope: AdminReadScope,
    filters: {
      kioskId?: string | undefined;
      status?: string | undefined;
      cursor?: string | undefined;
      /** `payment.reconcile.read`. Without it the provider reference is withheld. */
      includeProviderReference: boolean;
    }
  ): Promise<AdminPaymentsResponse> {
    const cursor = filters.cursor ? decodeAdminCursor(filters.cursor) : null;

    const rows = await this.options.database.payment.findMany({
      where: {
        ...scopedViaSessionFilter(scope, filters.kioskId),
        ...(filters.status ? { status: filters.status } : {}),
        ...keysetWhere("createdAt", cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_PAGE_SIZE + 1,
      select: {
        id: true,
        sessionId: true,
        provider: true,
        providerIntentId: true,
        status: true,
        appliedToSession: true,
        amountMinor: true,
        currency: true,
        currencyExponent: true,
        failureCode: true,
        expiresAt: true,
        createdAt: true,
        authorizedAt: true,
        capturedAt: true,
        failedAt: true,
        session: { select: { kioskId: true } },
        _count: { select: { attempts: true } }
      }
    });

    const page = rows.slice(0, ADMIN_PAGE_SIZE);
    return {
      scoped: scope.kioskIds !== null,
      nextCursor: nextCursorFrom(rows, page, (row) => ({ at: row.createdAt, id: row.id })),
      items: page.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        kioskId: row.session.kioskId,
        provider: row.provider,
        providerIntentId: filters.includeProviderReference ? row.providerIntentId : null,
        status: row.status,
        appliedToSession: row.appliedToSession,
        amountMinor: row.amountMinor,
        currency: row.currency,
        currencyExponent: row.currencyExponent,
        failureCode: row.failureCode,
        attempts: row._count.attempts,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        authorizedAt: row.authorizedAt?.toISOString() ?? null,
        capturedAt: row.capturedAt?.toISOString() ?? null,
        failedAt: row.failedAt?.toISOString() ?? null
      }))
    };
  }

  /**
   * The prints waiting for somebody who can decide about money.
   *
   * Phase 3 recorded observations and stopped. Two of its four outcomes mean a
   * person thinks money is owed, and one — `UNRESOLVABLE` — meant nobody could
   * tell, which suggested no refund and then appeared on no list at all. Both
   * belong here: the first is "how much", the second is "somebody with more
   * authority has to make a call", and neither is a closed case.
   *
   * A job leaves this queue when a refund has been authorized against it, not
   * when somebody decides it owes nothing — deciding that a print owes nothing
   * is a correction, and it leaves a record.
   *
   * The account each row shows is the *effective* one: the newest correction if
   * there is one, otherwise the original observation. A queue that showed
   * superseded evidence would be a queue that pays out on it.
   */
  public async refundQueue(
    scope: AdminReadScope,
    filters: { cursor?: string | undefined }
  ): Promise<AdminRefundQueueResponse> {
    const cursor = filters.cursor ? decodeAdminCursor(filters.cursor) : null;

    // Oldest first: this is a worklist, and the print somebody has been waiting
    // longest on is the one that should be answered next.
    const candidates = await this.options.database.printJobRecoveryResolution.findMany({
      where: {
        ...scopedKioskFilter(scope),
        ...keysetWhere("createdAt", cursor, "asc"),
        printJob: {
          status: "RECOVERY_REQUIRED",
          // Authorizing a refund is what takes a print off this list.
          refundAuthorization: { is: null },
          payment: { status: "CAPTURED" }
        }
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: ADMIN_PAGE_SIZE + 1,
      select: REFUND_QUEUE_SELECT
    });

    const page = candidates.slice(0, ADMIN_PAGE_SIZE);
    const decided = page
      .map((row) => toRefundQueueCandidate(row))
      .filter((entry) => entry !== null);

    // What is already owed on each payment, from every reason combined, so the
    // ceiling the server enforces is the ceiling the screen shows.
    const refunded = await this.refundedByPayment(decided.map((entry) => entry.paymentId));

    const items = decided.map((entry) => {
      const alreadyRefunded = refunded.get(entry.paymentId) ?? 0;
      return {
        ...entry.presentation,
        refundedAmountMinor: alreadyRefunded,
        authorizableAmountMinor: Math.max(entry.capturedAmountMinor - alreadyRefunded, 0)
      };
    });

    return {
      items,
      nextCursor: nextCursorFrom(candidates, page, (row) => ({ at: row.createdAt, id: row.id })),
      totals: await this.refundQueueTotals(scope)
    };
  }

  /**
   * Exact counts for the two reasons a print is in the queue.
   *
   * Split in two because "the newest correction wins" is not expressible as a
   * `where` clause. Prints nobody has corrected — very nearly all of them — are
   * counted by the database. The handful that carry a correction are read and
   * resolved here, bounded so this can never become an unbounded scan.
   */
  private async refundQueueTotals(
    scope: AdminReadScope
  ): Promise<{ suggested: number; unresolvable: number }> {
    const uncorrected = {
      ...scopedKioskFilter(scope),
      printJob: {
        status: "RECOVERY_REQUIRED",
        refundAuthorization: { is: null },
        payment: { status: "CAPTURED" },
        recoveryCorrections: { none: {} }
      }
    } as const;

    const [suggested, unresolvable, corrected] = await Promise.all([
      this.options.database.printJobRecoveryResolution.count({
        where: { ...uncorrected, refundSuggested: true }
      }),
      this.options.database.printJobRecoveryResolution.count({
        where: { ...uncorrected, outcome: "UNRESOLVABLE" }
      }),
      this.options.database.printJobRecoveryResolution.findMany({
        where: {
          ...scopedKioskFilter(scope),
          printJob: {
            status: "RECOVERY_REQUIRED",
            refundAuthorization: { is: null },
            payment: { status: "CAPTURED" },
            recoveryCorrections: { some: {} }
          }
        },
        take: MAX_CORRECTED_QUEUE_ENTRIES,
        select: REFUND_QUEUE_SELECT
      })
    ]);

    let correctedSuggested = 0;
    let correctedUnresolvable = 0;
    for (const row of corrected) {
      const entry = toRefundQueueCandidate(row);
      if (!entry) continue;
      if (entry.presentation.queueReason === "UNRESOLVABLE") correctedUnresolvable += 1;
      else correctedSuggested += 1;
    }

    return {
      suggested: suggested + correctedSuggested,
      unresolvable: unresolvable + correctedUnresolvable
    };
  }

  /** Everything already owed on each of these payments, by every reason. */
  private async refundedByPayment(paymentIds: readonly string[]): Promise<Map<string, number>> {
    if (paymentIds.length === 0) return new Map();
    const sums = await this.options.database.refund.groupBy({
      by: ["paymentId"],
      where: { paymentId: { in: [...new Set(paymentIds)] } },
      _sum: { amountMinor: true }
    });
    return new Map(sums.map((row) => [row.paymentId, row._sum.amountMinor ?? 0]));
  }

  public async refunds(
    scope: AdminReadScope,
    filters: { unsettledOnly: boolean; cursor?: string | undefined }
  ): Promise<AdminRefundsResponse> {
    const now = this.options.clock.now();
    const cursor = filters.cursor ? decodeAdminCursor(filters.cursor) : null;
    const scopeWhere = scopedViaSessionFilter(scope);

    const [rows, unsettledCount] = await Promise.all([
      this.options.database.refund.findMany({
        where: {
          ...scopeWhere,
          ...(filters.unsettledOnly ? { completedAt: null } : {}),
          ...keysetWhere("createdAt", cursor)
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: ADMIN_PAGE_SIZE + 1,
        select: {
          id: true,
          paymentId: true,
          sessionId: true,
          provider: true,
          reason: true,
          status: true,
          amountMinor: true,
          currency: true,
          currencyExponent: true,
          createdAt: true,
          completedAt: true,
          // Null for an obligation the payment path raised on its own. "The
          // system noticed" and "a named person decided" are different kinds of
          // claim on the same ledger, and the screen should not merge them.
          authorization: {
            select: {
              reason: true,
              authorizedBy: { select: { displayName: true } }
            }
          }
        }
      }),
      this.options.database.refund.count({ where: { ...scopeWhere, completedAt: null } })
    ]);

    const page = rows.slice(0, ADMIN_PAGE_SIZE);
    return {
      unsettledCount,
      nextCursor: nextCursorFrom(rows, page, (row) => ({ at: row.createdAt, id: row.id })),
      items: page.map((row) => ({
        id: row.id,
        paymentId: row.paymentId,
        sessionId: row.sessionId,
        provider: row.provider,
        reason: row.reason,
        status: row.status,
        amountMinor: row.amountMinor,
        currency: row.currency,
        currencyExponent: row.currencyExponent,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        outstandingHours: row.completedAt
          ? null
          : Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / 3_600_000)),
        authorizedByDisplayName: row.authorization?.authorizedBy?.displayName ?? null,
        authorizationReason: row.authorization?.reason ?? null
      }))
    };
  }

  /**
   * The money dashboard: one window, the window before it, and the shape of it.
   *
   * This is the only read in the file that exists to describe the business
   * rather than to list records, and it is here because the alternative was a
   * browser dividing one page of fifty rows by another and calling the result a
   * success rate. Every number it returns is counted or summed by the database
   * over the whole window.
   *
   * Three decisions are worth stating, because each one is a way this could
   * have been subtly wrong.
   *
   * **Everything is bucketed by when the payment started.** Not by when it was
   * captured. One basis for every series is what makes a bucket's success rate
   * meaningful — "of the payments started on Tuesday, this many went through" —
   * and a kiosk captures seconds after it creates, so the difference is a
   * rounding error at a day boundary rather than a distortion.
   *
   * **The two periods are exactly the same length.** The current one ends now,
   * not at midnight, and the previous one is the identical span immediately
   * before it. Comparing a day-and-a-half against two days would produce a fall
   * every morning that nobody could explain.
   *
   * **The bars tile the window exactly.** The first and last are short, and are
   * marked as short, rather than being dropped or silently drawn as though they
   * were whole. The sum of the bars is the period total, so the chart can be
   * checked against the headline above it.
   */
  public async moneySummary(
    scope: AdminReadScope,
    filters: {
      window: MoneyWindow;
      /** Minutes added to UTC to reach the clock the caller reads. */
      utcOffsetMinutes: number;
      /** `refund.obligation.read`. Without it the refund halves are withheld. */
      includeRefunds: boolean;
    }
  ): Promise<AdminMoneySummaryResponse> {
    const now = this.options.clock.now();
    const shape = MONEY_WINDOW_SHAPE[filters.window];
    const offsetMilliseconds = filters.utcOffsetMinutes * 60_000;

    // The bucket the present moment falls in, cut on the caller's clock, and
    // then as many whole buckets back as the window is wide.
    const latestBarStart = truncateToInterval(now, shape.interval, offsetMilliseconds);
    const currentFrom = new Date(
      latestBarStart.getTime() - (shape.bars - 1) * shape.barMilliseconds
    );
    const length = now.getTime() - currentFrom.getTime();
    const previousFrom = new Date(currentFrom.getTime() - length);

    const paymentScope = scopedViaSessionFilter(scope);
    const inWindow = (from: Date, to: Date) => ({ createdAt: { gte: from, lt: to } });

    const [
      currentStatuses,
      currentCaptured,
      previousStatuses,
      previousCaptured,
      trendRows,
      openNow,
      expiredNow
    ] = await Promise.all([
      this.options.database.payment.groupBy({
        by: ["status"],
        where: { ...paymentScope, ...inWindow(currentFrom, now) },
        _count: { _all: true }
      }),
      this.options.database.payment.groupBy({
        by: ["currency", "currencyExponent"],
        where: {
          ...paymentScope,
          ...inWindow(currentFrom, now),
          status: { in: [...CAPTURED_PAYMENT_STATUSES] }
        },
        _sum: { amountMinor: true }
      }),
      this.options.database.payment.groupBy({
        by: ["status"],
        where: { ...paymentScope, ...inWindow(previousFrom, currentFrom) },
        _count: { _all: true }
      }),
      this.options.database.payment.groupBy({
        by: ["currency", "currencyExponent"],
        where: {
          ...paymentScope,
          ...inWindow(previousFrom, currentFrom),
          status: { in: [...CAPTURED_PAYMENT_STATUSES] }
        },
        _sum: { amountMinor: true }
      }),
      // The one row-reading query here, and the only one that can be outrun by a
      // busy window. Ordered so that a truncated read is a prefix rather than an
      // arbitrary sample — though a truncated read is not drawn at all.
      this.options.database.payment.findMany({
        where: { ...paymentScope, ...inWindow(currentFrom, now) },
        orderBy: { createdAt: "asc" },
        take: MAX_TREND_ROWS + 1,
        select: {
          createdAt: true,
          status: true,
          amountMinor: true,
          currency: true,
          currencyExponent: true
        }
      }),
      this.options.database.payment.count({
        where: { ...paymentScope, status: { in: [...OPEN_PAYMENT_STATUSES] } }
      }),
      this.options.database.payment.count({
        where: {
          ...paymentScope,
          status: { in: [...OPEN_PAYMENT_STATUSES] },
          expiresAt: { lt: now }
        }
      })
    ]);

    const trendTruncated = trendRows.length > MAX_TREND_ROWS;

    return {
      generatedAt: now.toISOString(),
      scoped: scope.kioskIds !== null,
      window: filters.window,
      utcOffsetMinutes: filters.utcOffsetMinutes,
      interval: shape.interval,
      current: {
        from: currentFrom.toISOString(),
        to: now.toISOString(),
        started: sumCounts(currentStatuses),
        byStatus: currentStatuses.map((row) => ({ status: row.status, count: row._count._all })),
        capturedAmounts: toCurrencyAmounts(currentCaptured)
      },
      previous: {
        from: previousFrom.toISOString(),
        to: currentFrom.toISOString(),
        started: sumCounts(previousStatuses),
        byStatus: previousStatuses.map((row) => ({ status: row.status, count: row._count._all })),
        capturedAmounts: toCurrencyAmounts(previousCaptured)
      },
      trend: trendTruncated
        ? []
        : barsOf(trendRows, {
            from: currentFrom,
            to: now,
            first: currentFrom.getTime(),
            step: shape.barMilliseconds,
            count: shape.bars
          }),
      trendTruncated,
      now: { open: openNow, expired: expiredNow },
      ...(await this.moneyRefunds(scope, filters.includeRefunds, {
        now,
        currentFrom,
        previousFrom
      }))
    };
  }

  /**
   * The refund halves of the summary, or two nulls.
   *
   * Withheld rather than zeroed for a role without `refund.obligation.read`:
   * "nothing is owed" and "you may not see what is owed" are different answers
   * and a zero would be the wrong one.
   */
  private async moneyRefunds(
    scope: AdminReadScope,
    include: boolean,
    at: { now: Date; currentFrom: Date; previousFrom: Date }
  ): Promise<Pick<AdminMoneySummaryResponse, "liability" | "refunds">> {
    if (!include) return { liability: null, refunds: null };

    const refundScope = scopedViaSessionFilter(scope);
    const raisedIn = (from: Date, to: Date) => ({ createdAt: { gte: from, lt: to } });
    const returnedIn = (from: Date, to: Date) => ({ completedAt: { gte: from, lt: to } });

    // Written out rather than spread from a shared options object: Prisma infers
    // the shape of an aggregate from the literal it is handed, and a spread
    // widens `_count` back to a union the callers below cannot read.
    const totalsBy = (where: RefundTotalsFilter) =>
      this.options.database.refund.groupBy({
        by: ["currency", "currencyExponent"],
        where,
        _sum: { amountMinor: true },
        _count: { _all: true }
      });

    const [outstanding, oldest, raisedNow, returnedNow, raisedBefore, returnedBefore] =
      await Promise.all([
        totalsBy({ ...refundScope, completedAt: null }),
        this.options.database.refund.findFirst({
          where: { ...refundScope, completedAt: null },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true }
        }),
        totalsBy({ ...refundScope, ...raisedIn(at.currentFrom, at.now) }),
        totalsBy({ ...refundScope, ...returnedIn(at.currentFrom, at.now) }),
        totalsBy({ ...refundScope, ...raisedIn(at.previousFrom, at.currentFrom) }),
        totalsBy({ ...refundScope, ...returnedIn(at.previousFrom, at.currentFrom) })
      ]);

    return {
      liability: {
        unsettled: sumCounts(outstanding),
        amounts: toCurrencyAmounts(outstanding),
        oldestOutstandingHours: oldest
          ? Math.max(0, Math.floor((at.now.getTime() - oldest.createdAt.getTime()) / 3_600_000))
          : null
      },
      refunds: {
        current: {
          raised: sumCounts(raisedNow),
          raisedAmounts: toCurrencyAmounts(raisedNow),
          returned: sumCounts(returnedNow),
          returnedAmounts: toCurrencyAmounts(returnedNow)
        },
        previous: {
          raised: sumCounts(raisedBefore),
          raisedAmounts: toCurrencyAmounts(raisedBefore),
          returned: sumCounts(returnedBefore),
          returnedAmounts: toCurrencyAmounts(returnedBefore)
        }
      }
    };
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  public async retention(
    scope: AdminReadScope,
    filters: { problemsOnly: boolean; cursor?: string | undefined }
  ): Promise<AdminRetentionResponse> {
    const now = this.options.clock.now();
    const overdueCutoff = new Date(now.getTime() - RETENTION_OVERDUE_GRACE_MILLISECONDS);
    const cursor = filters.cursor ? decodeAdminCursor(filters.cursor) : null;
    const kioskScope = scopedKioskFilter(scope);
    const scopeWhere = scopedViaSessionFilter(scope);

    const [rows, pending, deadLettered, overdue] = await Promise.all([
      this.options.database.cleanupRun.findMany({
        where: {
          ...scopeWhere,
          ...(filters.problemsOnly
            ? {
                OR: [
                  { deadLetteredAt: { not: null } },
                  { completedAt: null, session: { cleanupDueAt: { lt: overdueCutoff } } }
                ]
              }
            : {}),
          ...keysetWhere("createdAt", cursor)
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: ADMIN_PAGE_SIZE + 1,
        select: {
          id: true,
          sessionId: true,
          reason: true,
          status: true,
          checkpoint: true,
          attempts: true,
          lastErrorCode: true,
          objectsDeleted: true,
          orphanObjectsDeleted: true,
          availableAt: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          deadLetteredAt: true,
          session: {
            select: { kioskId: true, state: true, cleanupDueAt: true, filesDeletedAt: true }
          }
        }
      }),
      this.options.database.printSession.count({
        where: { ...kioskScope, cleanupStatus: { in: ["PENDING", "IN_PROGRESS"] } }
      }),
      this.options.database.printSession.count({
        where: { ...kioskScope, cleanupStatus: "DEAD_LETTER" }
      }),
      this.options.database.printSession.count({
        where: {
          ...kioskScope,
          cleanupStatus: { in: [...ACTIVE_CLEANUP_STATUSES] },
          cleanupDueAt: { lt: overdueCutoff },
          filesDeletedAt: null
        }
      })
    ]);

    const page = rows.slice(0, ADMIN_PAGE_SIZE);
    return {
      scoped: scope.kioskIds !== null,
      totals: { pending, overdue, deadLettered },
      nextCursor: nextCursorFrom(rows, page, (row) => ({ at: row.createdAt, id: row.id })),
      items: page.map((row) => ({
        sessionId: row.sessionId,
        kioskId: row.session.kioskId,
        sessionState: row.session.state as SessionState,
        reason: row.reason,
        status: row.status,
        checkpoint: row.checkpoint,
        attempts: row.attempts,
        lastErrorCode: row.lastErrorCode,
        objectsDeleted: row.objectsDeleted,
        orphanObjectsDeleted: row.orphanObjectsDeleted,
        availableAt: row.availableAt.toISOString(),
        dueAt: row.session.cleanupDueAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        deadLetteredAt: row.deadLetteredAt?.toISOString() ?? null,
        overdue:
          row.session.filesDeletedAt === null &&
          row.session.cleanupDueAt !== null &&
          row.session.cleanupDueAt.getTime() < overdueCutoff.getTime()
      }))
    };
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  /**
   * Failures grouped by subsystem and code.
   *
   * Grouping rather than listing is what keeps this bounded and what makes it
   * useful: thirty rows of one code from one kiosk is one problem, and a list
   * makes it look like thirty.
   *
   * Two subsystems report a null kiosk. Upload, payment, retention and event
   * failures hang off a session rather than a kiosk, and grouping by a kiosk
   * they only reach through a join would cost more than the answer is worth.
   * The scope filter still traverses that relation, so an Operator sees only
   * their own kiosks' failures even where the group cannot name one.
   */
  public async errors(scope: AdminReadScope, windowHours: number): Promise<AdminErrorsResponse> {
    const now = this.options.clock.now();
    const since = new Date(now.getTime() - windowHours * 3_600_000);
    const viaSession = scopedViaSessionFilter(scope);
    const direct = scopedKioskFilter(scope);

    const [rejections, processing, payments, prints, commands, cleanups, outbox] =
      await Promise.all([
        this.options.database.uploadedFile.groupBy({
          by: ["rejectionCode"],
          where: { ...viaSession, rejectionCode: { not: null }, updatedAt: { gte: since } },
          _count: true,
          _max: { updatedAt: true }
        }),
        this.options.database.uploadedFile.groupBy({
          by: ["processingErrorCode"],
          where: { ...viaSession, processingErrorCode: { not: null }, updatedAt: { gte: since } },
          _count: true,
          _max: { updatedAt: true }
        }),
        this.options.database.payment.groupBy({
          by: ["failureCode"],
          where: { ...viaSession, failureCode: { not: null }, updatedAt: { gte: since } },
          _count: true,
          _max: { updatedAt: true }
        }),
        this.options.database.printJob.groupBy({
          by: ["kioskId", "failureCode"],
          where: { ...direct, failureCode: { not: null }, updatedAt: { gte: since } },
          _count: true,
          _max: { updatedAt: true }
        }),
        // A settled command records `failureCode ?? status` as its result, so a
        // command that simply worked carries the result code `COMPLETED`.
        // Without the status filter the error centre lists every successful
        // print as a failure — which is noise on its own, and becomes worse
        // once an operator can acknowledge a group as an incident.
        this.options.database.agentCommand.groupBy({
          by: ["kioskId", "resultCode"],
          where: {
            ...direct,
            status: { in: [...FAILED_COMMAND_STATUSES] },
            resultCode: { not: null },
            updatedAt: { gte: since }
          },
          _count: true,
          _max: { updatedAt: true }
        }),
        this.options.database.cleanupRun.groupBy({
          by: ["lastErrorCode"],
          where: { ...viaSession, lastErrorCode: { not: null }, updatedAt: { gte: since } },
          _count: true,
          _max: { updatedAt: true }
        }),
        this.options.database.outboxEvent.groupBy({
          by: ["lastErrorCode"],
          where: { ...viaSession, lastErrorCode: { not: null }, createdAt: { gte: since } },
          _count: true,
          _max: { createdAt: true }
        })
      ]);

    const groups: UnacknowledgedErrorGroup[] = [
      ...toErrorGroups("UPLOAD", rejections, "rejectionCode", "updatedAt"),
      ...toErrorGroups("DOCUMENT_PROCESSING", processing, "processingErrorCode", "updatedAt"),
      ...toErrorGroups("PAYMENT", payments, "failureCode", "updatedAt"),
      ...toErrorGroups("PRINTING", prints, "failureCode", "updatedAt"),
      ...toErrorGroups("KIOSK_AGENT", commands, "resultCode", "updatedAt"),
      ...toErrorGroups("RETENTION", cleanups, "lastErrorCode", "updatedAt"),
      ...toErrorGroups("EVENT_PUBLISHING", outbox, "lastErrorCode", "createdAt")
    ].sort(
      (left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt)
    );

    const shown = groups.slice(0, MAX_ERROR_GROUPS);
    const acknowledgements = await this.acknowledgements(since);

    return {
      windowHours,
      scoped: scope.kioskIds !== null,
      truncated: groups.length > MAX_ERROR_GROUPS,
      groups: shown.map((group) => {
        const acknowledgement = acknowledgements.get(incidentKey(group));
        return {
          ...group,
          acknowledgedAt: acknowledgement?.at.toISOString() ?? null,
          acknowledgedBy: acknowledgement?.by ?? null,
          // The case where "somebody is on it" stops being reassuring: it has
          // happened again since they said so.
          recurredSinceAcknowledgement: acknowledgement
            ? Date.parse(group.lastSeenAt) > acknowledgement.at.getTime()
            : false
        };
      })
    };
  }

  /**
   * The most recent acknowledgement of each failure group.
   *
   * Read from the audit log, because that is where an acknowledgement lives:
   * it is a record that a named person saw something at a time, and there is no
   * operational state behind it to keep in sync. Bounded by the same window as
   * the groups themselves, so it cannot grow into an unbounded scan.
   *
   * Not scoped by kiosk. The groups it annotates are already scoped, and an
   * acknowledgement carries no information beyond a colleague's name.
   */
  private async acknowledgements(since: Date): Promise<Map<string, { at: Date; by: string }>> {
    const rows = await this.options.database.auditEvent.findMany({
      where: {
        action: "admin.incident.acknowledge",
        outcome: "SUCCESS",
        occurredAt: { gte: since }
      },
      orderBy: { occurredAt: "desc" },
      take: MAX_ACKNOWLEDGEMENTS,
      select: { occurredAt: true, actorId: true, kioskId: true, metadata: true }
    });
    if (rows.length === 0) return new Map();

    const names = new Map<string, string>();
    const people = await this.options.database.adminUser.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.actorId))] } },
      select: { id: true, displayName: true }
    });
    for (const person of people) names.set(person.id, person.displayName);

    // Newest first, so the first entry for a key wins and later ones are the
    // superseded acknowledgements of the same group.
    const latest = new Map<string, { at: Date; by: string }>();
    for (const row of rows) {
      const { metadata } = projectAuditMetadata(row.metadata);
      const subsystem = metadata.subsystem;
      const code = metadata.incidentCode;
      if (typeof subsystem !== "string" || typeof code !== "string") continue;
      const key = incidentKey({ subsystem, code, kioskId: row.kioskId });
      if (latest.has(key)) continue;
      latest.set(key, { at: row.occurredAt, by: names.get(row.actorId) ?? row.actorId });
    }
    return latest;
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  /**
   * The append-only log, filtered.
   *
   * `selfActorId` is set for a role trusted to review its own actions but not
   * everybody's. It is applied as a query filter rather than as a post-filter,
   * so a page never silently shrinks and a total never counts rows the caller
   * cannot see.
   */
  public async audit(
    scope: AdminReadScope,
    filters: {
      selfActorId: string | null;
      sessionId?: string | undefined;
      kioskId?: string | undefined;
      action?: string | undefined;
      cursor?: string | undefined;
    }
  ): Promise<AdminAuditResponse> {
    const cursor = filters.cursor ? decodeAdminCursor(filters.cursor) : null;
    const kioskScope = scopedKioskFilter(scope, filters.kioskId);

    const rows = await this.options.database.auditEvent.findMany({
      where: {
        ...(filters.selfActorId
          ? { actorType: ADMIN_ACTOR_TYPE, actorId: filters.selfActorId }
          : {}),
        // A scoped caller sees kiosk-attributed events for their kiosks. Events
        // with no kiosk — account management, their own sign-ins — stay visible
        // because withholding an operator's own history helps nobody.
        ...(kioskScope.kioskId === undefined
          ? {}
          : filters.kioskId
            ? { kioskId: kioskScope.kioskId }
            : { OR: [{ kioskId: kioskScope.kioskId }, { kioskId: null }] }),
        ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
        ...(filters.action ? { action: filters.action } : {}),
        ...keysetWhere("occurredAt", cursor)
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: ADMIN_PAGE_SIZE + 1,
      select: {
        id: true,
        occurredAt: true,
        actorType: true,
        actorId: true,
        kioskId: true,
        sessionId: true,
        action: true,
        outcome: true,
        requestId: true,
        metadata: true
      }
    });

    const page = rows.slice(0, ADMIN_PAGE_SIZE);
    // Named actors only. An admin event written before anybody was
    // authenticated — a failed sign-in, a consumed recovery credential — carries
    // `ANONYMOUS_ADMIN_ACTOR_ID` rather than an account, and `admin_users.id` is
    // a UUID: asking for that row made PostgreSQL refuse the whole query, so a
    // single failed sign-in on the page turned the audit log into a 500. Found
    // by the Phase 6 benchmark, which was the first thing to read this table
    // with real history in it rather than a suite's own rows.
    const adminActorIds = [
      ...new Set(
        page
          .filter((row) => row.actorType === ADMIN_ACTOR_TYPE && isUuid(row.actorId))
          .map((row) => row.actorId)
      )
    ];
    const names = new Map<string, string>();
    if (adminActorIds.length > 0) {
      const people = await this.options.database.adminUser.findMany({
        where: { id: { in: adminActorIds } },
        select: { id: true, displayName: true }
      });
      for (const person of people) names.set(person.id, person.displayName);
    }

    return {
      scope: filters.selfActorId ? "SELF" : "ALL",
      nextCursor: nextCursorFrom(rows, page, (row) => ({ at: row.occurredAt, id: row.id })),
      items: page.map((row) => {
        const projected = projectAuditMetadata(row.metadata);
        return {
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          actorType: row.actorType,
          actorId: row.actorId,
          actorDisplayName: names.get(row.actorId) ?? null,
          kioskId: row.kioskId,
          sessionId: row.sessionId,
          action: row.action,
          outcome: row.outcome,
          requestId: row.requestId,
          metadata: projected.metadata,
          redactedKeys: projected.redactedKeys
        };
      })
    };
  }

  /**
   * The Operators, and enough about each to decide what to do about them.
   *
   * Read through the same read-only pool as every other screen, deliberately:
   * the people *actions* need their own least-privilege role, but looking at a
   * roster is a read, and routing it anywhere else would have given the
   * connection that suspends people a reason to be able to enumerate them too.
   *
   * Only Operators appear. `operator.manage` and `authenticator.manage.operator`
   * reach no other role, so listing Admins here would be showing a person a set
   * of rows on which every control is refused — and telling them who the
   * Technical Admins are, which is the more interesting half of that mistake.
   *
   * There is no pagination and no cursor. This is a roster of colleagues, not a
   * log: an installation with enough Operators to need a page here has a
   * different problem, and the take below is what stops that being unbounded.
   */
  public async people(now: Date): Promise<AdminPeopleResponse> {
    const operators = await this.options.database.adminUser.findMany({
      where: { role: "OPERATOR" },
      orderBy: [{ status: "asc" }, { displayName: "asc" }],
      take: ADMIN_PEOPLE_LIMIT,
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        status: true,
        createdAt: true,
        activatedAt: true,
        suspendedAt: true,
        disabledAt: true,
        lastLoginAt: true
      }
    });

    const ids = operators.map((person) => person.id);
    if (ids.length === 0) return { items: [], kiosks: await this.assignableKiosks() };

    // Bounded queries rather than several per person. Everything here is
    // keyed on `admin_user_id`, which is indexed on every one of these tables.
    const [authenticators, sessions, scopes, passwords, invitations, resets, kiosks] =
      await Promise.all([
        this.options.database.adminAuthenticator.findMany({
          where: { adminUserId: { in: ids }, revokedAt: null },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            adminUserId: true,
            label: true,
            attachment: true,
            backupEligible: true,
            createdAt: true,
            lastUsedAt: true
          }
        }),
        // A locked session is still a live credential — it can be reopened —
        // so it counts. Only revocation and the absolute limit end one.
        this.options.database.adminSession.findMany({
          where: {
            adminUserId: { in: ids },
            revokedAt: null,
            hardExpiresAt: { gt: now }
          },
          select: { id: true, adminUserId: true }
        }),
        this.options.database.adminKioskScope.findMany({
          where: { adminUserId: { in: ids }, revokedAt: null },
          orderBy: { kioskId: "asc" },
          select: { adminUserId: true, kioskId: true }
        }),
        // Presence only. The reader role's grant stops at `admin_user_id`, so
        // this query could not fetch a digest even if it asked.
        this.options.database.adminPassword.findMany({
          where: { adminUserId: { in: ids } },
          select: { adminUserId: true }
        }),
        this.options.database.adminInvitation.findMany({
          where: {
            adminUserId: { in: ids },
            consumedAt: null,
            revokedAt: null,
            expiresAt: { gt: now }
          },
          orderBy: { expiresAt: "desc" },
          select: { adminUserId: true, expiresAt: true }
        }),
        this.options.database.adminPasswordReset.findMany({
          where: {
            adminUserId: { in: ids },
            consumedAt: null,
            revokedAt: null,
            expiresAt: { gt: now }
          },
          orderBy: { expiresAt: "desc" },
          select: { adminUserId: true, expiresAt: true }
        }),
        this.assignableKiosks()
      ]);

    const byPerson = <TRow extends { adminUserId: string }>(rows: readonly TRow[]) => {
      const grouped = new Map<string, TRow[]>();
      for (const row of rows) {
        const existing = grouped.get(row.adminUserId);
        if (existing) existing.push(row);
        else grouped.set(row.adminUserId, [row]);
      }
      return grouped;
    };

    const keysByPerson = byPerson(authenticators);
    const sessionsByPerson = byPerson(sessions);
    const scopesByPerson = byPerson(scopes);
    const passwordByPerson = new Set(passwords.map((row) => row.adminUserId));
    const invitationsByPerson = byPerson(invitations);
    const resetsByPerson = byPerson(resets);

    return {
      items: operators.map((person) => {
        const keys = keysByPerson.get(person.id) ?? [];
        const liveInvitations = invitationsByPerson.get(person.id) ?? [];
        const liveResets = resetsByPerson.get(person.id) ?? [];
        return {
          adminUserId: person.id,
          username: person.username,
          displayName: person.displayName,
          role: asAdminRole(person.role),
          status: asAdminUserStatus(person.status),
          createdAt: person.createdAt.toISOString(),
          activatedAt: person.activatedAt?.toISOString() ?? null,
          suspendedAt: person.suspendedAt?.toISOString() ?? null,
          disabledAt: person.disabledAt?.toISOString() ?? null,
          lastLoginAt: person.lastLoginAt?.toISOString() ?? null,
          passwordSet: passwordByPerson.has(person.id),
          usableAuthenticators: keys.length,
          minimumAuthenticators: minimumAuthenticators(asAdminRole(person.role)),
          authenticators: keys.map((key) => ({
            id: key.id,
            label: key.label,
            attachment: asAttachment(key.attachment),
            backupEligible: key.backupEligible,
            createdAt: key.createdAt.toISOString(),
            lastUsedAt: key.lastUsedAt?.toISOString() ?? null
          })),
          activeSessions: (sessionsByPerson.get(person.id) ?? []).length,
          kioskIds: (scopesByPerson.get(person.id) ?? []).map((scope) => scope.kioskId),
          pendingInvitationExpiresAt: liveInvitations[0]?.expiresAt.toISOString() ?? null,
          pendingPasswordResetExpiresAt: liveResets[0]?.expiresAt.toISOString() ?? null
        };
      }),
      kiosks
    };
  }

  private async assignableKiosks(): Promise<AdminPeopleResponse["kiosks"]> {
    const kiosks = await this.options.database.kiosk.findMany({
      orderBy: { id: "asc" },
      take: ADMIN_PEOPLE_KIOSK_LIMIT,
      select: { id: true, name: true }
    });
    return kiosks.map((kiosk) => ({ id: kiosk.id, name: kiosk.name }));
  }
}

/**
 * Ceilings on the people roster.
 *
 * Not pagination — a bound. Every query in the control plane is bounded, and a
 * roster is no exception just because it is expected to be short.
 */
const ADMIN_PEOPLE_LIMIT = 200;
const ADMIN_PEOPLE_KIOSK_LIMIT = 200;

/**
 * The role and status columns are `VARCHAR`, so the database can in principle
 * hold a value this build does not know. Narrowing here rather than casting
 * means such a row fails the response schema loudly instead of arriving in a
 * browser as an unhandled string.
 */
function asAdminRole(value: string): AdminRole {
  if (!isAdminRole(value)) throw new Error(`ADMIN_ROLE_INVALID:${value}`);
  return value;
}

function asAdminUserStatus(value: string): AdminUserStatus {
  if (!isAdminUserStatus(value)) throw new Error(`ADMIN_STATUS_INVALID:${value}`);
  return value;
}

/** `platform`, `cross-platform`, or the authenticator declining to say. */
function asAttachment(value: string | null): "platform" | "cross-platform" | null {
  return value === "platform" || value === "cross-platform" ? value : null;
}

// ---------------------------------------------------------------------------
// Shared query shaping
// ---------------------------------------------------------------------------

const PRINT_JOB_SELECT = {
  id: true,
  sessionId: true,
  kioskId: true,
  status: true,
  resultConfidence: true,
  failureCode: true,
  warningCode: true,
  copies: true,
  printedSides: true,
  physicalSheets: true,
  sheetsProduced: true,
  dispatchAttempts: true,
  deadlineAt: true,
  createdAt: true,
  dispatchedAt: true,
  startedAt: true,
  completedAt: true,
  failedAt: true,
  manifestRedactedAt: true,
  // Presence only. The list needs to say "somebody has answered this" without
  // pulling one person's free-text account of every job on the page.
  recoveryResolution: { select: { printJobId: true } }
} as const;

interface PrintJobRow {
  id: string;
  sessionId: string;
  kioskId: string;
  status: string;
  resultConfidence: string;
  failureCode: string | null;
  warningCode: string | null;
  copies: number;
  printedSides: number;
  physicalSheets: number;
  sheetsProduced: number | null;
  dispatchAttempts: number;
  deadlineAt: Date;
  createdAt: Date;
  dispatchedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  recoveryResolution: { printJobId: string } | null;
  manifestRedactedAt: Date | null;
}

function toPrintJob(job: PrintJobRow, now: Date): AdminPrintJobsResponse["items"][number] {
  return {
    id: job.id,
    sessionId: job.sessionId,
    kioskId: job.kioskId,
    status: job.status,
    resultConfidence: job.resultConfidence,
    failureCode: job.failureCode,
    warningCode: job.warningCode,
    copies: job.copies,
    printedSides: job.printedSides,
    physicalSheets: job.physicalSheets,
    sheetsProduced: job.sheetsProduced,
    dispatchAttempts: job.dispatchAttempts,
    deadlineAt: job.deadlineAt.toISOString(),
    createdAt: job.createdAt.toISOString(),
    dispatchedAt: job.dispatchedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    failedAt: job.failedAt?.toISOString() ?? null,
    manifestRedactedAt: job.manifestRedactedAt?.toISOString() ?? null,
    overdue:
      (OPEN_PRINT_STATUSES as readonly string[]).includes(job.status) &&
      job.deadlineAt.getTime() < now.getTime(),
    recoveryResolved: job.recoveryResolution !== null
  };
}

/**
 * One inventory row, or its absence, as the panel reads it.
 *
 * No row is a kiosk nobody has started tracking. That is reported as unknown
 * rather than as zero, here as everywhere else, because a wrong pessimistic
 * answer closes a machine that could have served somebody.
 *
 * The clamp stays even though a check constraint now enforces the same bounds.
 * It costs nothing and it means a value that somehow got past the database
 * still cannot render as a negative sheet count on an operator's screen.
 */
function paperSummary(
  inventory: {
    estimatedSheets: number;
    lastRefillSheets: number | null;
    lastRefillNote: string | null;
    lastRefillById: string | null;
    lastRefillAt: Date | null;
    lastRefillBy: { displayName: string } | null;
  } | null
): AdminKioskPaperSummary {
  const safeEstimate =
    inventory === null
      ? null
      : Math.min(PAPER_ESTIMATE_MAX_SHEETS, Math.max(0, inventory.estimatedSheets));
  return {
    estimatedSheets: safeEstimate,
    status: classifyPaperEstimate(safeEstimate),
    gettingLowAtSheets: PAPER_GETTING_LOW_THRESHOLD_SHEETS,
    refillSoonAtSheets: PAPER_REFILL_SOON_THRESHOLD_SHEETS,
    lastRefill:
      inventory?.lastRefillSheets == null ||
      inventory.lastRefillById === null ||
      inventory.lastRefillAt === null
        ? null
        : {
            sheetsAdded: inventory.lastRefillSheets,
            note: inventory.lastRefillNote,
            recordedByAdminUserId: inventory.lastRefillById,
            recordedByDisplayName: inventory.lastRefillBy?.displayName ?? null,
            recordedAt: inventory.lastRefillAt.toISOString()
          }
  };
}

type KioskSelector = { in: string[] } | string;

/**
 * A kiosk filter for the kiosk table itself.
 *
 * Empty only when the caller is unrestricted and asked for no particular
 * kiosk. A scoped caller who names a kiosk outside their scope gets the
 * intersection, which is empty — asking for someone else's kiosk returns
 * nothing rather than an error that would confirm it exists.
 */
function scopedKioskIdFilter(scope: AdminReadScope, requested?: string): { id?: KioskSelector } {
  if (scope.kioskIds === null) return requested ? { id: requested } : {};
  const allowed = requested
    ? scope.kioskIds.filter((kioskId) => kioskId === requested)
    : scope.kioskIds;
  return { id: { in: [...allowed] } };
}

/** The same filter, for a table whose own rows carry `kiosk_id`. */
function scopedKioskFilter(scope: AdminReadScope, requested?: string): { kioskId?: KioskSelector } {
  const filter = scopedKioskIdFilter(scope, requested);
  return filter.id === undefined ? {} : { kioskId: filter.id };
}

/**
 * The same filter again, for a table that reaches a kiosk through its session.
 *
 * Traversing the relation costs a join, which is why the tables that carry
 * `kiosk_id` themselves use the filter above. It matters that both exist: a
 * scope that only worked on some tables would be a scope with holes in it.
 */
// ---------------------------------------------------------------------------
// The money summary's arithmetic
// ---------------------------------------------------------------------------

/**
 * The three ways the summary narrows the refund ledger.
 *
 * Spelled out rather than taken from Prisma's generated `RefundWhereInput`,
 * which would drag the whole write-capable filter surface into a file whose
 * point is that it cannot write.
 */
interface RefundTotalsFilter {
  session?: { kioskId: KioskSelector };
  completedAt?: null | { gte: Date; lt: Date };
  createdAt?: { gte: Date; lt: Date };
}

/**
 * The start of the bucket an instant falls in, on a clock `offset` from UTC.
 *
 * Shifting the instant, truncating in UTC and shifting back is the same
 * operation as truncating in the local zone, and it needs no timezone database
 * in the API process. It is exact wherever the offset holds for the whole
 * window, which is everywhere without daylight saving.
 */
function truncateToInterval(at: Date, interval: "HOUR" | "DAY", offsetMilliseconds: number): Date {
  const shifted = new Date(at.getTime() + offsetMilliseconds);
  const truncated =
    interval === "HOUR"
      ? Date.UTC(
          shifted.getUTCFullYear(),
          shifted.getUTCMonth(),
          shifted.getUTCDate(),
          shifted.getUTCHours()
        )
      : Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(truncated - offsetMilliseconds);
}

/**
 * The payments of one window, laid into the bars that tile it.
 *
 * Every bar is created empty first, so a quiet Tuesday is a zero on the chart
 * rather than a gap in it — a missing bar reads as missing data, which is a
 * different and much worse claim than "nothing happened".
 *
 * The first and last bars are clipped to the window and marked `partial`. Both
 * are ordinary: a trailing window opens part-way through a bucket and closes
 * part-way through the present one.
 */
function barsOf(
  rows: readonly {
    createdAt: Date;
    status: string;
    amountMinor: number;
    currency: string;
    currencyExponent: number;
  }[],
  span: { from: Date; to: Date; first: number; step: number; count: number }
): AdminMoneySummaryResponse["trend"] {
  const buckets = Array.from({ length: span.count }, (_unused, index) => {
    const opens = span.first + index * span.step;
    const closes = opens + span.step;
    return {
      opens: Math.max(opens, span.from.getTime()),
      closes: Math.min(closes, span.to.getTime()),
      whole: opens >= span.from.getTime() && closes <= span.to.getTime(),
      started: 0,
      captured: 0,
      failed: 0,
      amounts: new Map<string, { currencyExponent: number; amountMinor: number }>()
    };
  });

  for (const row of rows) {
    const index = Math.min(
      Math.max(Math.floor((row.createdAt.getTime() - span.first) / span.step), 0),
      span.count - 1
    );
    const bucket = buckets[index];
    if (!bucket) continue;

    bucket.started += 1;
    if (row.status === "FAILED") bucket.failed += 1;
    if (CAPTURED.has(row.status)) {
      bucket.captured += 1;
      const total = bucket.amounts.get(row.currency) ?? {
        currencyExponent: row.currencyExponent,
        amountMinor: 0
      };
      total.amountMinor += row.amountMinor;
      bucket.amounts.set(row.currency, total);
    }
  }

  return buckets.map((bucket) => ({
    startsAt: new Date(bucket.opens).toISOString(),
    endsAt: new Date(bucket.closes).toISOString(),
    partial: !bucket.whole,
    started: bucket.started,
    captured: bucket.captured,
    failed: bucket.failed,
    capturedAmounts: [...bucket.amounts.entries()]
      .map(([currency, total]) => ({ currency, ...total }))
      .sort((left, right) => left.currency.localeCompare(right.currency))
  }));
}

const CAPTURED = new Set<string>(CAPTURED_PAYMENT_STATUSES);

/**
 * Grouped rows turned into one amount per currency, never added across them.
 *
 * A currency with a zero sum is kept rather than dropped: the group only exists
 * because rows exist, and a currency that took nothing is a different fact from
 * a currency nobody used.
 */
function toCurrencyAmounts(
  rows: readonly {
    currency: string;
    currencyExponent: number;
    _sum?: { amountMinor?: number | null } | undefined;
  }[]
): AdminMoneySummaryResponse["current"]["capturedAmounts"] {
  return rows
    .map((row) => ({
      currency: row.currency,
      currencyExponent: row.currencyExponent,
      amountMinor: row._sum?.amountMinor ?? 0
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

function sumCounts(rows: readonly { _count: { _all: number } }[]): number {
  return rows.reduce((total, row) => total + row._count._all, 0);
}

function scopedViaSessionFilter(
  scope: AdminReadScope,
  requested?: string
): { session?: { kioskId: KioskSelector } } {
  const filter = scopedKioskFilter(scope, requested);
  return filter.kioskId === undefined ? {} : { session: { kioskId: filter.kioskId } };
}

/**
 * Whether an actor identifier names an account row.
 *
 * `audit_events.actor_id` is free text because it holds a kiosk id, a provider
 * name or `anonymous` as readily as an account's UUID. Anything asking the
 * accounts table about one has to check first, or PostgreSQL refuses the query
 * rather than returning no rows.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function scopeKey(scope: AdminReadScope): string {
  return scope.kioskIds === null ? "*" : [...scope.kioskIds].sort().join(",");
}

/**
 * The keyset predicate: everything strictly after the cursor's position.
 *
 * The tie-break on `id` is what makes a page boundary safe. Two rows created in
 * the same millisecond are common under load, and without it one of them would
 * be returned twice or not at all.
 */
function keysetWhere(
  field: "createdAt" | "occurredAt",
  cursor: { at: Date; id: string } | null,
  // Every list in the panel is newest-first except one: the refund queue is a
  // worklist, and the print somebody has been waiting longest on is the one to
  // answer next.
  direction: "asc" | "desc" = "desc"
): Record<string, unknown> {
  if (!cursor) return {};
  const beyond = direction === "asc" ? "gt" : "lt";
  return {
    OR: [{ [field]: { [beyond]: cursor.at } }, { [field]: cursor.at, id: { [beyond]: cursor.id } }]
  };
}

function nextCursorFrom<TRow>(
  fetched: readonly TRow[],
  page: readonly TRow[],
  position: (row: TRow) => { at: Date; id: string }
): string | null {
  const last = page.at(-1);
  if (fetched.length <= page.length || !last) return null;
  return encodeAdminCursor(position(last));
}

/**
 * Everything one refund queue row is decided from.
 *
 * Written once and used by both the page and the totals, so the two can never
 * disagree about which prints are waiting — a queue whose count and contents
 * were computed differently is a queue somebody stops believing.
 */
const REFUND_QUEUE_SELECT = {
  id: true,
  printJobId: true,
  sessionId: true,
  kioskId: true,
  outcome: true,
  reason: true,
  observedSheets: true,
  createdAt: true,
  resolvedBy: { select: { displayName: true } },
  printJob: {
    select: {
      paymentId: true,
      sheetsProduced: true,
      physicalSheets: true,
      payment: {
        select: { amountMinor: true, currency: true, currencyExponent: true }
      },
      recoveryCorrections: {
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
        select: {
          id: true,
          supersedesId: true,
          outcome: true,
          reason: true,
          observedSheets: true,
          createdAt: true,
          correctedBy: { select: { displayName: true } }
        }
      }
    }
  }
};

/**
 * A ceiling on the corrected prints resolved in memory when counting the queue.
 *
 * Correcting an observation is meant to be rare. If this ever truncates, the
 * count is low rather than wrong in an unbounded direction, and the queue is
 * telling somebody that corrections have stopped being exceptional.
 */
const MAX_CORRECTED_QUEUE_ENTRIES = 500;

type RefundQueueRow = {
  id: string;
  printJobId: string;
  sessionId: string;
  kioskId: string;
  outcome: string;
  reason: string;
  observedSheets: number | null;
  createdAt: Date;
  resolvedBy: { displayName: string } | null;
  printJob: {
    paymentId: string;
    sheetsProduced: number | null;
    physicalSheets: number;
    payment: { amountMinor: number; currency: string; currencyExponent: number } | null;
    recoveryCorrections: readonly {
      id: string;
      supersedesId: string;
      outcome: string;
      reason: string;
      observedSheets: number | null;
      createdAt: Date;
      correctedBy: { displayName: string } | null;
    }[];
  } | null;
};

/**
 * Turn one observation and its corrections into a queue row, or into nothing.
 *
 * Nothing when the effective account says the customer got their pages: a
 * correction to `DELIVERED` is how a print that never owed anything leaves this
 * list, and it leaves by being answered rather than by being hidden.
 */
function toRefundQueueCandidate(row: RefundQueueRow): {
  paymentId: string;
  capturedAmountMinor: number;
  presentation: Omit<
    AdminRefundQueueEntry,
    "refundedAmountMinor" | "authorizableAmountMinor" | "capturedAmountMinor"
  > & { capturedAmountMinor: number };
} | null {
  const job = row.printJob;
  const payment = job?.payment;
  if (!job || !payment) return null;

  // Follow the chain rather than taking the newest timestamp. They agree today,
  // and the chain is the one that stays right if they ever stop agreeing.
  const bySuperseded = new Map(job.recoveryCorrections.map((entry) => [entry.supersedesId, entry]));
  let effective = {
    id: row.id,
    outcome: row.outcome,
    reason: row.reason,
    observedSheets: row.observedSheets,
    at: row.createdAt,
    byDisplayName: row.resolvedBy?.displayName ?? null,
    corrected: false
  };
  for (let step = 0; step < job.recoveryCorrections.length; step += 1) {
    const next = bySuperseded.get(effective.id);
    if (!next) break;
    effective = {
      id: next.id,
      outcome: next.outcome,
      reason: next.reason,
      observedSheets: next.observedSheets,
      at: next.createdAt,
      byDisplayName: next.correctedBy?.displayName ?? null,
      corrected: true
    };
  }

  const queueReason =
    effective.outcome === "UNRESOLVABLE"
      ? "UNRESOLVABLE"
      : effective.outcome === "PARTIALLY_DELIVERED" || effective.outcome === "NOT_DELIVERED"
        ? "REFUND_SUGGESTED"
        : null;
  if (!queueReason) return null;

  return {
    paymentId: job.paymentId,
    capturedAmountMinor: payment.amountMinor,
    presentation: {
      printJobId: row.printJobId,
      sessionId: row.sessionId,
      kioskId: row.kioskId,
      queueReason,
      outcome: effective.outcome as AdminRefundQueueEntry["outcome"],
      reason: effective.reason,
      observedSheets: effective.observedSheets,
      sheetsProduced: job.sheetsProduced,
      physicalSheets: job.physicalSheets,
      observedByDisplayName: effective.byDisplayName,
      observedAt: effective.at.toISOString(),
      corrected: effective.corrected,
      paymentId: job.paymentId,
      capturedAmountMinor: payment.amountMinor,
      currency: payment.currency,
      currencyExponent: payment.currencyExponent
    }
  };
}

function countsByKey<TKey extends string>(
  groups: readonly ({ _count: number } & Record<TKey, string | null>)[],
  key: TKey
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const group of groups) {
    const value = group[key];
    if (value === null) continue;
    counts[value] = (counts[value] ?? 0) + group._count;
  }
  return counts;
}

function sumValues(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

function toErrorGroups<TRow extends { _count: number }>(
  subsystem: AdminErrorsResponse["groups"][number]["subsystem"],
  rows: readonly TRow[],
  codeField: string,
  timeField: string
): UnacknowledgedErrorGroup[] {
  const groups: UnacknowledgedErrorGroup[] = [];
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown>;
    const code = record[codeField];
    if (typeof code !== "string") continue;
    const maximum = record._max as Record<string, Date | null> | undefined;
    const lastSeenAt = maximum?.[timeField];
    groups.push({
      subsystem,
      code,
      kioskId: typeof record.kioskId === "string" ? record.kioskId : null,
      count: row._count,
      lastSeenAt: (lastSeenAt ?? new Date(0)).toISOString()
    });
  }
  return groups;
}

/** A group before anybody's acknowledgement has been matched to it. */
type UnacknowledgedErrorGroup = Omit<
  AdminErrorsResponse["groups"][number],
  "acknowledgedAt" | "acknowledgedBy" | "recurredSinceAcknowledgement"
>;

/**
 * The device's account of an operation, as the control plane may show it.
 *
 * Read through the contract rather than trusted from the column. It was bounded
 * when the agent reported it, but stored shapes outlive the code that wrote
 * them and this response crosses a grant boundary. A row that no longer parses
 * is shown as absent rather than as itself.
 */
function readDeviceDetail(value: unknown): AdminDeviceDetail | null {
  if (value === null || value === undefined) return null;
  const parsed = adminDeviceDetailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
