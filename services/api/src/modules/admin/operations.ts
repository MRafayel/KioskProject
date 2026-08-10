import { createHash } from "node:crypto";

import {
  incidentKey,
  suggestsRefund,
  type AcknowledgeIncidentBody,
  type AdminIncidentAcknowledgement,
  type AdminRecoveryResolution,
  type ResolveRecoveryBody,
  type ResolveRecoveryResponse
} from "@printing-kiosk/admin-access";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { writeAdminAuditEvent, type AdminAuditMetadataValue } from "./audit.js";
import { adminNotFound } from "./http.js";
import type { AdminObservabilityService } from "./observability.js";
import type { AuthenticatedAdmin } from "./service.js";
import type { AdminWriteDatabase, AdminWriteTransaction } from "./write-database.js";

/**
 * The two things an operator may actually do.
 *
 * Both are additive. Neither changes a print job, a session, a payment or a
 * refund, and the connection they run on holds no privilege to do so even if
 * this file were rewritten to try.
 *
 * The shape every action here follows, in order:
 *
 *   1. Re-read the world inside the transaction that will write. A capability
 *      was checked when the request arrived; whether the *thing* is still
 *      eligible is a separate question with a separate answer, and the gap
 *      between the two is where a stale dashboard turns into a wrong action.
 *   2. Refuse with a 404 when the caller may not see the record at all, so a
 *      refusal never confirms that an identifier names something real.
 *   3. Write the fact and its audit event in the same transaction, so there is
 *      no ordering in which one exists without the other.
 *
 * A refused action is audited too — somebody probing for jobs they cannot
 * resolve should leave exactly as much evidence as somebody who succeeds — but
 * a refusal is recorded *after* its transaction has rolled back rather than
 * inside it. An audit row written next to the throw that discards it would
 * describe attempts nobody could ever read.
 */

/** How long an admin action's transaction may hold the database. */
const ACTION_TRANSACTION_TIMEOUT_MILLISECONDS = 5_000;

/**
 * How far back an acknowledgement may reach.
 *
 * An acknowledgement has to name a group that is actually in the error centre,
 * so the window used to confirm it is the widest the panel can display.
 */
const ACKNOWLEDGEABLE_WINDOW_HOURS = 168;

export interface AdminOperationsServiceOptions {
  database: AdminWriteDatabase;
  /**
   * The read side, used only to confirm that an acknowledged failure group
   * genuinely exists. Acknowledging changes nothing operational, so confirming
   * it on the read pool costs nothing and keeps the write pool's grants as
   * narrow as they are.
   */
  observability: AdminObservabilityService;
  clock: Clock;
  random: RandomSource;
}

export class AdminOperationsService {
  public constructor(private readonly options: AdminOperationsServiceOptions) {}

  // -------------------------------------------------------------------------
  // Print recovery resolution (R2)
  // -------------------------------------------------------------------------

  /**
   * Record what a person saw at the tray for a job the device could not settle.
   *
   * This is the dashboard's reason to exist, and it is also the action with the
   * most ways to go wrong, so most of the code below is refusal.
   *
   * What it cannot do, by construction rather than by care: mark the job
   * printed, move it out of recovery, reopen its session, create a refund, or
   * change anything a device reported. It appends one row.
   */
  public async resolvePrintRecovery(
    admin: AuthenticatedAdmin,
    printJobId: string,
    body: ResolveRecoveryBody,
    requestId: string
  ): Promise<ResolveRecoveryResponse> {
    const now = this.options.clock.now();
    const refundSuggested = suggestsRefund(body.outcome);
    const digest = digestResolutionRequest(body);

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const job = await transaction.printJob.findFirst({
            where: { id: printJobId },
            select: {
              id: true,
              sessionId: true,
              kioskId: true,
              paymentId: true,
              status: true,
              resultConfidence: true,
              failureCode: true,
              sheetsProduced: true
            }
          });

          // Not found and not yours are the same answer. A 403 on an
          // out-of-scope identifier confirms that the identifier names
          // something real, which is the whole mechanism of an enumeration
          // attack.
          if (!job || !(await this.mayActOnKiosk(transaction, admin, job.kioskId))) {
            throw new RefusedAction(adminNotFound(), {
              action: "admin.print.recovery.resolve",
              failureCode: "NOT_FOUND_OR_OUT_OF_SCOPE",
              reason: body.reason,
              printJobId
            });
          }

          // An observation already recorded is the idempotency boundary, and it
          // is the database's unique index rather than a record with a TTL. The
          // same submission replays; a different one is refused rather than
          // quietly dropped, because two people disagreeing about what they saw
          // is something a person needs to know about, not something to hide.
          const existing = await transaction.printJobRecoveryResolution.findUnique({
            where: { printJobId },
            select: RESOLUTION_FIELDS
          });

          if (existing) {
            if (existing.requestDigest !== digest) {
              throw new RefusedAction(
                new ApiError(
                  409,
                  "PRINT_RECOVERY_ALREADY_RESOLVED",
                  "Somebody has already recorded what happened to this print. Reload to see it."
                ),
                {
                  action: "admin.print.recovery.resolve",
                  failureCode: "ALREADY_RESOLVED",
                  reason: body.reason,
                  printJobId,
                  kioskId: job.kioskId,
                  sessionId: job.sessionId,
                  outcome: body.outcome
                }
              );
            }

            return {
              resolution: await this.present(transaction, existing),
              replayed: true,
              refundAuthorized: false as const
            };
          }

          // Eligibility, revalidated now rather than trusted from the list the
          // operator was looking at. A job settles asynchronously, so the row
          // that was RECOVERY_REQUIRED when the page rendered may not be.
          if (job.status !== "RECOVERY_REQUIRED") {
            throw new RefusedAction(notInRecovery(), {
              action: "admin.print.recovery.resolve",
              failureCode: "NOT_IN_RECOVERY",
              reason: body.reason,
              printJobId,
              kioskId: job.kioskId,
              sessionId: job.sessionId,
              previousState: job.status
            });
          }

          const session = await transaction.printSession.findFirst({
            where: { id: job.sessionId },
            select: { state: true }
          });
          if (session?.state !== "RECOVERY_REQUIRED") {
            throw new RefusedAction(notInRecovery(), {
              action: "admin.print.recovery.resolve",
              failureCode: "SESSION_NOT_IN_RECOVERY",
              reason: body.reason,
              printJobId,
              kioskId: job.kioskId,
              sessionId: job.sessionId,
              previousState: session?.state ?? "MISSING"
            });
          }

          // What the money did, recorded as evidence rather than acted on. A
          // person is saying pages are missing; whether that becomes a payout
          // is decided later, by somebody else, against this row.
          const payment = await transaction.payment.findFirst({
            where: { id: job.paymentId, sessionId: job.sessionId },
            select: { status: true }
          });

          const created = await transaction.printJobRecoveryResolution.create({
            data: {
              id: this.options.random.uuid(now),
              printJobId: job.id,
              sessionId: job.sessionId,
              kioskId: job.kioskId,
              outcome: body.outcome,
              reason: body.reason,
              refundSuggested,
              observedSheets: body.observedSheets ?? null,
              resolvedByAdminId: admin.adminUserId,
              resolvedByRole: admin.role,
              requestDigest: digest,
              createdAt: now
            },
            select: RESOLUTION_FIELDS
          });

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.print.recovery.resolve",
            outcome: "SUCCESS",
            requestId,
            kioskId: job.kioskId,
            metadata: {
              role: admin.role,
              capability: "print.recovery.resolve",
              risk: "R2",
              stepUpFresh: true,
              printJobId: job.id,
              reason: body.reason,
              recoveryOutcome: body.outcome,
              refundSuggested,
              observedSheets: body.observedSheets ?? null,
              // The device's own account, kept beside the human's. The gap
              // between the two is the reason this record exists at all.
              sheetsProduced: job.sheetsProduced,
              confidence: job.resultConfidence,
              failureCode: job.failureCode,
              status: payment?.status ?? "NONE",
              // The job's state before and after. They are identical, and that
              // is the point: this records an observation and moves nothing.
              previousState: "RECOVERY_REQUIRED",
              resultingState: "RECOVERY_REQUIRED"
            }
          });

          return {
            resolution: await this.present(transaction, created),
            replayed: false,
            refundAuthorized: false as const
          };
        },
        { timeout: ACTION_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
      // The transaction is gone by now, along with anything written in it. The
      // refusal is recorded on its own so that an attempt leaves a trace even
      // though the action left none.
      if (error instanceof RefusedAction) {
        await this.auditRefusal(admin, requestId, now, error.details);
        throw error.response;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Incident acknowledgement (R1)
  // -------------------------------------------------------------------------

  /**
   * Say that somebody is looking at a group in the error centre.
   *
   * The lowest-risk thing the panel can do: it changes no operational state,
   * and exists so two operators do not both walk to the same kiosk.
   *
   * It is stored as an audit event rather than as a row, because that is
   * genuinely all it is — a record that a named person saw something at a time.
   * There is no state to keep in sync, nothing to clear, and nothing to go
   * stale: it ages out with the window it was made in.
   *
   * The group is confirmed to exist before the event is written. Without that,
   * this endpoint would be a way to write caller-chosen strings into a
   * permanent, append-only log that operators read.
   */
  public async acknowledgeIncident(
    admin: AuthenticatedAdmin,
    body: AcknowledgeIncidentBody,
    requestId: string
  ): Promise<AdminIncidentAcknowledgement> {
    const now = this.options.clock.now();
    const scoped = admin.role === "OPERATOR";

    // An Operator may only speak for their own kiosks. A group with no kiosk is
    // a system-wide failure — upload, payment, retention, event publishing —
    // and acknowledging one of those is for a role whose view is not scoped.
    if (scoped && (body.kioskId === null || !admin.kioskScopes.includes(body.kioskId))) {
      await this.auditRefusal(admin, requestId, now, {
        action: "admin.incident.acknowledge",
        failureCode: "OUT_OF_SCOPE",
        reason: body.reason,
        subsystem: body.subsystem,
        incidentCode: body.code
      });
      throw adminNotFound();
    }

    const errors = await this.options.observability.errors(
      scoped ? { kioskIds: admin.kioskScopes } : { kioskIds: null },
      ACKNOWLEDGEABLE_WINDOW_HOURS
    );
    const wanted = incidentKey(body);
    if (!errors.groups.some((candidate) => incidentKey(candidate) === wanted)) {
      await this.auditRefusal(admin, requestId, now, {
        action: "admin.incident.acknowledge",
        failureCode: "NO_SUCH_INCIDENT",
        reason: body.reason,
        subsystem: body.subsystem,
        incidentCode: body.code
      });
      throw adminNotFound();
    }

    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: admin.adminUserId,
      action: "admin.incident.acknowledge",
      outcome: "SUCCESS",
      requestId,
      ...(body.kioskId ? { kioskId: body.kioskId } : {}),
      metadata: {
        role: admin.role,
        capability: "incident.acknowledge",
        risk: "R1",
        subsystem: body.subsystem,
        incidentCode: body.code,
        reason: body.reason
      }
    });

    return {
      subsystem: body.subsystem,
      code: body.code,
      kioskId: body.kioskId,
      acknowledgedByDisplayName: admin.displayName,
      acknowledgedAt: now.toISOString()
    };
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * Whether this person may act on this kiosk, asked of the database rather
   * than of the session.
   *
   * The signed-in identity carries the scopes it was issued with. An assignment
   * revoked since then must take effect on the next action, not on the next
   * sign-in, so the authoritative answer is re-read inside the transaction that
   * is about to write.
   */
  private async mayActOnKiosk(
    transaction: AdminWriteTransaction,
    admin: AuthenticatedAdmin,
    kioskId: string
  ): Promise<boolean> {
    if (admin.role !== "OPERATOR") return true;
    const assignment = await transaction.adminKioskScope.findFirst({
      where: { adminUserId: admin.adminUserId, kioskId },
      select: { kioskId: true }
    });
    return assignment !== null;
  }

  /** Put a person's name on the stored row without a second round trip. */
  private async present(
    transaction: AdminWriteTransaction,
    row: StoredResolution
  ): Promise<AdminRecoveryResolution> {
    const person = await transaction.adminUser.findUnique({
      where: { id: row.resolvedByAdminId },
      select: { displayName: true }
    });

    return {
      printJobId: row.printJobId,
      // Stored as text and returned through a closed enum on the way out. A
      // value the database somehow held that this build does not recognise
      // fails the response schema rather than reaching a screen.
      outcome: row.outcome as AdminRecoveryResolution["outcome"],
      reason: row.reason,
      refundSuggested: row.refundSuggested,
      observedSheets: row.observedSheets,
      resolvedByAdminUserId: row.resolvedByAdminId,
      resolvedByDisplayName: person?.displayName ?? null,
      resolvedByRole: row.resolvedByRole,
      resolvedAt: row.createdAt.toISOString()
    };
  }

  /** Record that somebody tried, and was told no. */
  private async auditRefusal(
    admin: AuthenticatedAdmin,
    requestId: string,
    now: Date,
    details: RefusalDetails
  ): Promise<void> {
    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: admin.adminUserId,
      action: details.action,
      outcome: "DENIED",
      requestId,
      ...(details.kioskId ? { kioskId: details.kioskId } : {}),
      metadata: {
        role: admin.role,
        failureCode: details.failureCode,
        reason: details.reason,
        ...(details.printJobId ? { printJobId: details.printJobId } : {}),
        ...(details.sessionId ? { sessionId: details.sessionId } : {}),
        ...(details.previousState ? { previousState: details.previousState } : {}),
        ...(details.outcome ? { recoveryOutcome: details.outcome } : {}),
        ...(details.subsystem ? { subsystem: details.subsystem } : {}),
        ...(details.incidentCode ? { incidentCode: details.incidentCode } : {})
      } satisfies Record<string, AdminAuditMetadataValue>
    });
  }
}

const RESOLUTION_FIELDS = {
  printJobId: true,
  outcome: true,
  reason: true,
  refundSuggested: true,
  observedSheets: true,
  resolvedByAdminId: true,
  resolvedByRole: true,
  requestDigest: true,
  createdAt: true
} as const;

interface StoredResolution {
  printJobId: string;
  outcome: string;
  reason: string;
  refundSuggested: boolean;
  observedSheets: number | null;
  resolvedByAdminId: string;
  resolvedByRole: string;
  requestDigest: string;
  createdAt: Date;
}

interface RefusalDetails {
  action: string;
  failureCode: string;
  reason: string;
  printJobId?: string;
  kioskId?: string;
  sessionId?: string;
  previousState?: string;
  outcome?: string;
  subsystem?: string;
  incidentCode?: string;
}

/**
 * A refusal, carried out of a transaction so the transaction can roll back
 * before the refusal is recorded.
 *
 * Not an `ApiError` itself: throwing one of those from inside the callback
 * would let a future caller forget that a refusal still has to be audited. This
 * type cannot reach the client, so the only way to resolve it is through the
 * handler that writes the audit row.
 */
class RefusedAction extends Error {
  public constructor(
    public readonly response: ApiError,
    public readonly details: RefusalDetails
  ) {
    super(details.failureCode);
    this.name = "RefusedAction";
  }
}

/**
 * Turn what the caller submitted into a digest that decides whether a repeat is
 * a replay or a contradiction.
 *
 * The reason is included, so resubmitting the same outcome with a different
 * account of it is a conflict rather than a silent no-op: the text is the part
 * a person will read later.
 */
function digestResolutionRequest(body: ResolveRecoveryBody): string {
  return createHash("sha256")
    .update("printing-kiosk/admin/recovery-resolution/v1", "utf8")
    .update("\0", "utf8")
    .update(body.outcome, "utf8")
    .update("\0", "utf8")
    .update(body.reason, "utf8")
    .update("\0", "utf8")
    .update(body.observedSheets === undefined ? "" : String(body.observedSheets), "utf8")
    .digest("hex");
}

/**
 * One message for "this job is not in recovery" and "its session is not".
 *
 * The distinction matters to the audit trail and not at all to the operator,
 * whose next step is the same either way: reload and look at what it says now.
 */
function notInRecovery(): ApiError {
  return new ApiError(
    409,
    "PRINT_JOB_NOT_IN_RECOVERY",
    "This print no longer needs recovery. Reload to see its current state."
  );
}
