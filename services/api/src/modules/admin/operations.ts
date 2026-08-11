import { createHash } from "node:crypto";

import {
  incidentKey,
  suggestsRefund,
  type AcknowledgeIncidentBody,
  type AdminIncidentAcknowledgement,
  type AdminRecoveryCorrection,
  type AdminRecoveryResolution,
  type AdminRetentionRetry,
  type CorrectRecoveryBody,
  type CorrectRecoveryResponse,
  type ResolveRecoveryBody,
  type ResolveRecoveryResponse,
  type RetryRetentionBody,
  type RetryRetentionResponse
} from "@printing-kiosk/admin-access";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { writeAdminAuditEvent, type AdminAuditMetadataValue } from "./audit.js";
import { adminNotFound } from "./http.js";
import type { AdminObservabilityService } from "./observability.js";
import type { AuthenticatedAdmin } from "./service.js";
import type { AdminWriteDatabase, AdminWriteTransaction } from "./write-database.js";

/**
 * The things a person may do that do not involve money.
 *
 * Four actions: record what was seen at a tray, correct such a record, ask
 * retention to retry a run that gave up, and say that somebody is looking at a
 * failure. All of them are additive. None changes a print job, a session, a
 * payment, a cleanup run or a refund, and the connection they run on holds no
 * privilege to do so even if this file were rewritten to try.
 *
 * Authorizing a refund is deliberately not here. It runs in `refunds.ts`, on a
 * different pool as a different database role, because the phase gate is that
 * the money path and the operator observation path are separate — and a
 * separation that lives in one file's control flow is not one.
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
  // Correcting a recovery observation (R2)
  // -------------------------------------------------------------------------

  /**
   * Put right an account of a print that turned out to be wrong.
   *
   * Phase 3 left this deliberately impossible: an observation was one per job,
   * append-only, and there was no way to say "that was a mistake". That is the
   * correct default — somebody who could rewrite their own account of a paid
   * print could launder a failure into a success — but a system where a genuine
   * error can never be recorded as an error is a system where people stop
   * trusting the record.
   *
   * So the correction is a new fact, made by somebody else. The original stays
   * exactly as written; this appends a row that supersedes it, holds a
   * capability no Operator has, and names the record it replaces so that two
   * people correcting the same print collide instead of overwriting each other.
   *
   * What it cannot do: withdraw a refund somebody already authorized. A
   * correction changes what the queue says is owed, not what has been decided.
   * Undoing a decision about money is a different act and does not exist yet.
   */
  public async correctPrintRecovery(
    admin: AuthenticatedAdmin,
    printJobId: string,
    body: CorrectRecoveryBody,
    requestId: string
  ): Promise<CorrectRecoveryResponse> {
    const now = this.options.clock.now();
    const refundSuggested = suggestsRefund(body.outcome);
    const digest = digestCorrectionRequest(body);

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const job = await transaction.printJob.findFirst({
            where: { id: printJobId },
            select: {
              id: true,
              sessionId: true,
              kioskId: true,
              status: true,
              resultConfidence: true,
              sheetsProduced: true
            }
          });

          if (!job || !(await this.mayActOnKiosk(transaction, admin, job.kioskId))) {
            throw new RefusedAction(adminNotFound(), {
              action: "admin.print.recovery.correct",
              failureCode: "NOT_FOUND_OR_OUT_OF_SCOPE",
              reason: body.reason,
              printJobId
            });
          }

          const resolution = await transaction.printJobRecoveryResolution.findUnique({
            where: { printJobId },
            select: RESOLUTION_FIELDS
          });

          // Nothing to correct is a different answer from "you may not correct
          // it", and the person reading it needs to know which.
          if (!resolution) {
            throw new RefusedAction(
              new ApiError(
                409,
                "PRINT_RECOVERY_NOT_RESOLVED",
                "Nobody has recorded what happened to this print yet, so there is nothing to correct."
              ),
              {
                action: "admin.print.recovery.correct",
                failureCode: "NOT_RESOLVED",
                reason: body.reason,
                printJobId,
                kioskId: job.kioskId,
                sessionId: job.sessionId
              }
            );
          }

          // A repeat of the same correction replays. The digest includes the
          // record being superseded, so resubmitting a form is a replay while
          // correcting the same record twice with different words is not.
          const existing = await transaction.printJobRecoveryCorrection.findUnique({
            where: { supersedesId: body.supersedesId },
            select: CORRECTION_FIELDS
          });

          if (existing) {
            if (existing.requestDigest !== digest) {
              throw new RefusedAction(
                new ApiError(
                  409,
                  "PRINT_RECOVERY_ALREADY_CORRECTED",
                  "Somebody has already corrected this record. Reload to see what it says now."
                ),
                {
                  action: "admin.print.recovery.correct",
                  failureCode: "ALREADY_CORRECTED",
                  reason: body.reason,
                  printJobId,
                  kioskId: job.kioskId,
                  sessionId: job.sessionId,
                  outcome: body.outcome
                }
              );
            }

            return {
              correction: await this.presentCorrection(transaction, existing),
              replayed: true,
              refundAuthorized: false as const
            };
          }

          // The record being corrected must be the newest account of this
          // print. Correcting a superseded one would be answering a question
          // somebody has already moved past, and the answer would silently lose
          // to the row that superseded it.
          const effective = await this.effectiveObservation(transaction, printJobId, resolution);
          if (effective.id !== body.supersedesId) {
            throw new RefusedAction(
              new ApiError(
                409,
                "PRINT_RECOVERY_SUPERSEDED",
                "This account of the print has already been superseded. Reload and correct the current one."
              ),
              {
                action: "admin.print.recovery.correct",
                failureCode: "STALE_SUPERSEDES",
                reason: body.reason,
                printJobId,
                kioskId: job.kioskId,
                sessionId: job.sessionId
              }
            );
          }

          const created = await transaction.printJobRecoveryCorrection.create({
            data: {
              id: this.options.random.uuid(now),
              printJobId: job.id,
              sessionId: job.sessionId,
              kioskId: job.kioskId,
              supersedesId: body.supersedesId,
              outcome: body.outcome,
              reason: body.reason,
              refundSuggested,
              observedSheets: body.observedSheets ?? null,
              correctedByAdminId: admin.adminUserId,
              correctedByRole: admin.role,
              requestDigest: digest,
              createdAt: now
            },
            select: CORRECTION_FIELDS
          });

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.print.recovery.correct",
            outcome: "SUCCESS",
            requestId,
            kioskId: job.kioskId,
            metadata: {
              role: admin.role,
              capability: "print.recovery.correct",
              risk: "R2",
              stepUpFresh: true,
              printJobId: job.id,
              reason: body.reason,
              supersedesId: body.supersedesId,
              // Before and after, as accounts of the print rather than as
              // states of it. The job itself did not move and cannot.
              previousOutcome: effective.outcome,
              recoveryOutcome: body.outcome,
              refundSuggested,
              observedSheets: body.observedSheets ?? null,
              sheetsProduced: job.sheetsProduced,
              confidence: job.resultConfidence,
              previousState: "RECOVERY_REQUIRED",
              resultingState: "RECOVERY_REQUIRED"
            }
          });

          return {
            correction: await this.presentCorrection(transaction, created),
            replayed: false,
            refundAuthorized: false as const
          };
        },
        { timeout: ACTION_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
      if (error instanceof RefusedAction) {
        await this.auditRefusal(admin, requestId, now, error.details);
        throw error.response;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Asking retention to try again (R1)
  // -------------------------------------------------------------------------

  /**
   * Ask the retention worker to retry a cleanup run that gave up.
   *
   * A dead-lettered run means a customer's documents are still in object
   * storage past the point this system promised they would be gone, and the
   * only thing still holding the line is a storage lifecycle rule meant to be a
   * backstop. Somebody has to be able to say "the object store is back" without
   * waiting for an approval, so this is R1 and needs no step-up.
   *
   * It appends a request; it does not re-arm anything. The control plane holds
   * no privilege on `cleanup_runs` — it can read six columns of one and write
   * nothing — so the worker re-arms its own run after reading this. That is
   * what keeps "retry the cleanup" from being a way to reach into retention
   * state and change something else, and it is why this returns
   * `rearmed: false`: the panel is not the thing that deletes documents and
   * should never report that it is.
   */
  public async retryRetention(
    admin: AuthenticatedAdmin,
    body: RetryRetentionBody,
    requestId: string
  ): Promise<RetryRetentionResponse> {
    const now = this.options.clock.now();

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const run = await transaction.cleanupRun.findFirst({
            where: { sessionId: body.sessionId },
            select: {
              id: true,
              sessionId: true,
              status: true,
              attempts: true,
              lastErrorCode: true,
              deadLetteredAt: true
            }
          });

          if (!run) {
            throw new RefusedAction(adminNotFound(), {
              action: "admin.document.retention.retry",
              failureCode: "NOT_FOUND",
              reason: body.reason,
              sessionId: body.sessionId
            });
          }

          // Revalidated here rather than trusted from the list the person was
          // looking at. A run that recovered on its own between the page
          // rendering and this request is not a run anybody needs to retry.
          if (run.status !== "DEAD_LETTER" || !run.deadLetteredAt) {
            throw new RefusedAction(
              new ApiError(
                409,
                "CLEANUP_RUN_NOT_DEAD_LETTERED",
                "This cleanup has not given up. Reload to see where it is."
              ),
              {
                action: "admin.document.retention.retry",
                failureCode: "NOT_DEAD_LETTERED",
                reason: body.reason,
                sessionId: body.sessionId,
                previousState: run.status
              }
            );
          }

          // One request per dead-lettering. An identical repeat replays rather
          // than piling up requests the worker would answer once anyway.
          const existing = await transaction.cleanupRetryRequest.findFirst({
            where: { cleanupRunId: run.id, deadLetteredAt: run.deadLetteredAt },
            select: RETRY_FIELDS
          });

          if (existing) {
            return {
              retry: await this.presentRetry(transaction, existing),
              replayed: true,
              rearmed: false as const
            };
          }

          const created = await transaction.cleanupRetryRequest.create({
            data: {
              id: this.options.random.uuid(now),
              cleanupRunId: run.id,
              sessionId: run.sessionId,
              deadLetteredAt: run.deadLetteredAt,
              attempts: run.attempts,
              lastErrorCode: run.lastErrorCode,
              reason: body.reason,
              requestedByAdminId: admin.adminUserId,
              requestedByRole: admin.role,
              createdAt: now
            },
            select: RETRY_FIELDS
          });

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.document.retention.retry",
            outcome: "SUCCESS",
            requestId,
            sessionId: run.sessionId,
            metadata: {
              role: admin.role,
              capability: "document.retention.retry",
              risk: "R1",
              cleanupRunId: run.id,
              reason: body.reason,
              attempts: run.attempts,
              failureCode: run.lastErrorCode,
              // The run's state before and after. Identical, because this
              // records a request and the worker is what acts on it.
              previousState: "DEAD_LETTER",
              resultingState: "DEAD_LETTER"
            }
          });

          return {
            retry: await this.presentRetry(transaction, created),
            replayed: false,
            rearmed: false as const
          };
        },
        { timeout: ACTION_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
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

  /**
   * The account of a print as it currently stands.
   *
   * A resolution, then however many corrections have superseded it in turn.
   * Following the chain rather than taking the newest row by timestamp is what
   * makes "correct the current record" a checkable claim: the chain has exactly
   * one end, and two people cannot both be at it.
   */
  private async effectiveObservation(
    transaction: AdminWriteTransaction,
    printJobId: string,
    resolution: StoredResolution & { id?: string }
  ): Promise<{ id: string; outcome: string }> {
    const corrections = await transaction.printJobRecoveryCorrection.findMany({
      where: { printJobId },
      select: { id: true, supersedesId: true, outcome: true }
    });

    const bySuperseded = new Map(corrections.map((row) => [row.supersedesId, row]));
    let current = { id: resolution.id ?? "", outcome: resolution.outcome };

    // Bounded by the number of rows read, so a cycle the database should make
    // impossible cannot become a loop that holds a transaction open.
    for (let step = 0; step < corrections.length; step += 1) {
      const next = bySuperseded.get(current.id);
      if (!next) break;
      current = { id: next.id, outcome: next.outcome };
    }

    return current;
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
      id: row.id,
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

  /** The same, for a correction. */
  private async presentCorrection(
    transaction: AdminWriteTransaction,
    row: StoredCorrection
  ): Promise<AdminRecoveryCorrection> {
    const person = await transaction.adminUser.findUnique({
      where: { id: row.correctedByAdminId },
      select: { displayName: true }
    });

    return {
      id: row.id,
      printJobId: row.printJobId,
      supersedesId: row.supersedesId,
      outcome: row.outcome as AdminRecoveryCorrection["outcome"],
      reason: row.reason,
      refundSuggested: row.refundSuggested,
      observedSheets: row.observedSheets,
      correctedByAdminUserId: row.correctedByAdminId,
      correctedByDisplayName: person?.displayName ?? null,
      correctedByRole: row.correctedByRole,
      correctedAt: row.createdAt.toISOString()
    };
  }

  /** And for a retention retry request. */
  private async presentRetry(
    transaction: AdminWriteTransaction,
    row: StoredRetry
  ): Promise<AdminRetentionRetry> {
    const person = await transaction.adminUser.findUnique({
      where: { id: row.requestedByAdminId },
      select: { displayName: true }
    });

    return {
      sessionId: row.sessionId,
      cleanupRunId: row.cleanupRunId,
      deadLetteredAt: row.deadLetteredAt.toISOString(),
      lastErrorCode: row.lastErrorCode,
      attempts: row.attempts,
      requestedByAdminUserId: row.requestedByAdminId,
      requestedByDisplayName: person?.displayName ?? null,
      requestedAt: row.createdAt.toISOString()
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
  id: true,
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
  id: string;
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

const CORRECTION_FIELDS = {
  id: true,
  printJobId: true,
  supersedesId: true,
  outcome: true,
  reason: true,
  refundSuggested: true,
  observedSheets: true,
  correctedByAdminId: true,
  correctedByRole: true,
  requestDigest: true,
  createdAt: true
} as const;

interface StoredCorrection {
  id: string;
  printJobId: string;
  supersedesId: string;
  outcome: string;
  reason: string;
  refundSuggested: boolean;
  observedSheets: number | null;
  correctedByAdminId: string;
  correctedByRole: string;
  requestDigest: string;
  createdAt: Date;
}

const RETRY_FIELDS = {
  sessionId: true,
  cleanupRunId: true,
  deadLetteredAt: true,
  attempts: true,
  lastErrorCode: true,
  requestedByAdminId: true,
  createdAt: true
} as const;

interface StoredRetry {
  sessionId: string;
  cleanupRunId: string;
  deadLetteredAt: Date;
  attempts: number;
  lastErrorCode: string | null;
  requestedByAdminId: string;
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
 * The same, for a correction.
 *
 * The record being superseded is part of the digest. Resubmitting a form is a
 * replay; correcting the same record a second time with different words is a
 * conflict, and correcting a *different* record is a different request that has
 * to stand on its own.
 */
function digestCorrectionRequest(body: CorrectRecoveryBody): string {
  return createHash("sha256")
    .update("printing-kiosk/admin/recovery-correction/v1", "utf8")
    .update("\0", "utf8")
    .update(body.supersedesId, "utf8")
    .update("\0", "utf8")
    .update(body.outcome, "utf8")
    .update("\0", "utf8")
    .update(body.reason, "utf8")
    .update("\0", "utf8")
    .update(body.observedSheets === undefined ? "" : String(body.observedSheets), "utf8")
    .digest("hex");
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
