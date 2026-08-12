/**
 * What the control plane's database role is allowed to change.
 *
 * Phase 2 gave the admin panel a role that can only read. This is the role it
 * uses for the handful of things an operator is allowed to *do*, and it is
 * written the same way: as data, so that the answer to "could a compromised
 * admin backend move money" is a grant list rather than a code review.
 *
 * The shape of this policy is the whole point. It holds INSERT on a short list
 * of tables and nothing else — no UPDATE and no DELETE anywhere in the
 * database, on any table, ever. That is not a coincidence of the current
 * feature set; it is the Phase 3 acceptance gate expressed as a privilege, and
 * Phase 4 kept it by giving money its own role rather than widening this one:
 *
 *   - It cannot touch `refunds` or `payments`, so nobody acting through this
 *     connection can cause a payout. Money is `refund.authorize`, and it runs
 *     on `printing_kiosk_admin_refund_writer` over its own pool.
 *   - It cannot UPDATE `cleanup_runs`, so asking retention to try again is a
 *     row appended to a request table that the worker reads — not a reach into
 *     retention state.
 *   - It cannot UPDATE `print_jobs` or `print_sessions`, so nobody can force a
 *     job into recovery, out of one, or into a success. What the device
 *     reported stays exactly as reported.
 *   - It cannot UPDATE or DELETE `audit_events` or the resolutions it writes,
 *     so it cannot erase its own tracks. Triggers refuse this too; the missing
 *     grant means the refusal does not depend on a trigger surviving.
 *
 * A future admin action that genuinely needs to change operational state has to
 * add a grant here, in a file whose diff says exactly what new power the
 * control plane gained. That is the review this file exists to force.
 */

/** The role the API's admin write pool connects as. Never owns anything. */
export const ADMIN_WRITER_ROLE = "printing_kiosk_admin_writer";

/**
 * The tables this role may add a row to.
 *
 * Every one of them is append-only by trigger as well: an admin action produces
 * new facts, never edited ones. Nothing here changes operational state — a
 * correction supersedes an observation without touching it, and a retry request
 * asks the worker to act rather than acting.
 */
export const INSERTABLE_TABLES = Object.freeze({
  print_job_recovery_resolutions:
    "One operator observation per print job that the device could not settle.",
  print_job_recovery_corrections:
    "A later account superseding one of those, by somebody who did not make it. Appends; the original stays exactly as written.",
  cleanup_retry_requests:
    "A person asking retention to try a dead-lettered run again. The worker re-arms its own run; this role holds nothing on cleanup_runs.",
  audit_events: "Every admin action records itself here, including the ones that failed."
});

/**
 * Tables the writer may SELECT, and the columns it may see.
 *
 * Deliberately much narrower than the read role's. This connection exists to
 * revalidate eligibility inside the transaction that writes — "is this job
 * still in recovery, on a kiosk this person is assigned to" — and nothing else.
 * The panel's reading is done by the read role on its own pool.
 *
 * Anything not listed is unreadable, which includes every column the read role
 * is also denied: no filename, no content digest, no object key, no manifest,
 * no event payload, no credential digest.
 */
export const READABLE_TABLES = Object.freeze({
  // The job being resolved: its state, its money, its device outcome. Enough to
  // decide eligibility and to write an accurate before-state into the audit
  // event. `job_manifest` is absent here exactly as it is for the read role.
  print_jobs: [
    "id",
    "session_id",
    "kiosk_id",
    "payment_id",
    "status",
    "result_confidence",
    "failure_code",
    "warning_code",
    "sheets_produced",
    "physical_sheets",
    "created_at",
    "failed_at"
  ],

  // The session the job belongs to, to confirm it is genuinely in recovery and
  // not, say, a job left behind by a session that ended some other way.
  print_sessions: ["id", "kiosk_id", "state", "cleanup_status", "files_deleted_at", "created_at"],

  // Whether a capture actually exists, which is what makes "money may be owed"
  // a meaningful thing for a person to observe.
  payments: ["id", "session_id", "status", "applied_to_session", "amount_minor", "currency"],

  // Contextual authorization: an Operator may only act on their own kiosks, and
  // that has to be re-read at execution time rather than trusted from a cookie.
  admin_kiosk_scopes: "*",

  // The acting account's role and status, revalidated at execution time so a
  // suspended account with a live session cannot still act — plus the display
  // name, so the observation comes back naming a person rather than a UUID.
  // Never the WebAuthn handle.
  admin_users: ["id", "display_name", "role", "status", "disabled_at", "suspended_at"],

  // Read back to replay an identical repeat submission instead of failing it,
  // and — for a correction — to find the record it is allowed to supersede.
  print_job_recovery_resolutions: "*",
  print_job_recovery_corrections: "*",

  // A retry may only be asked for a run that has actually given up, and the
  // request has to describe the failure it answers, so the run is read to pin
  // those columns. Read only: re-arming is the worker's job.
  cleanup_runs: [
    "id",
    "session_id",
    "status",
    "attempts",
    "last_error_code",
    "dead_lettered_at",
    "available_at"
  ],
  cleanup_retry_requests: "*",

  // The error centre's acknowledgements are audit events; reading them back is
  // how a repeat acknowledgement is recognised as one.
  audit_events: "*",

  kiosks: ["id", "name", "status"]
});

/**
 * Tables this role must hold no privilege on whatsoever — not even SELECT.
 *
 * The read role's matrix lists tables it may not read. This list is stronger
 * and narrower: it names the tables where a *write* would be a security
 * incident, so `verify` asserts the absence explicitly rather than inferring it
 * from the absence of an entry above. If somebody ever adds `refunds` to the
 * insertable list, two files have to disagree before it takes effect.
 */
export const FORBIDDEN_TABLES = Object.freeze({
  refunds:
    "Money. Creating or settling an obligation is refund.authorize, which nobody holding print.recovery.resolve holds by that fact alone. It has its own role and its own pool: printing_kiosk_admin_refund_writer.",
  refund_authorizations:
    "The record of who authorized a payout. Written on the refund connection, in the same transaction as the obligation it explains, and never from here.",
  payment_attempts: "The provider ledger. Written by the payment path, never by a person.",
  payment_webhook_inbox: "Provider callbacks. A forged row here is a forged payment.",
  kiosk_credentials:
    "Issuing or rotating a kiosk credential is not reachable from the dashboard in any role, at any risk level.",
  session_upload_grants: "Upload token digests.",
  mobile_clients: "Phone session digests.",
  uploaded_files: "Customer documents.",
  file_derivatives: "Storage addresses of customer documents.",
  file_pages: "Page geometry of customer documents.",
  pricing_rule_sets: "A published tariff is an R3 change requiring three people.",
  pricing_rules: "A published tariff is an R3 change requiring three people.",
  price_quotes: "What a customer was quoted is evidence of what they agreed to pay.",
  print_setting_revisions: "What was ordered.",
  print_job_events: "The device's own ledger. A human observation is not a device report.",
  agent_commands: "Durable work for a printer. Writing one is issuing a print command.",
  outbox_events: "The event publication log.",
  session_events: "The session timeline.",
  admin_authenticators: "Enrolling a credential is authenticator.manage, and goes through no pool.",
  admin_sessions: "Session and CSRF digests.",
  admin_webauthn_challenges: "In-flight ceremony state.",
  admin_break_glass_credentials: "Recovery credential digests.",
  admin_enrollment_tickets:
    "Authorising somebody's first enrolment is authenticator.manage.operator, on the people role. A connection that records what an operator saw at a tray must not be able to mint an identity.",
  idempotency_records: "Stored response bodies from every replayed request.",
  system_metadata: "Free-form configuration values.",
  _prisma_migrations: "Schema management, not operational data."
});

/**
 * Connection-level settings pinned onto the role.
 *
 * Not read-only, obviously — this is the connection that writes. Everything
 * else is tighter than the read role rather than looser: an admin action is one
 * short transaction against a handful of rows, so a statement that runs for
 * more than two seconds or a transaction left open for more than five is a
 * fault, and a lock held against the print path is the fault that matters most.
 */
export const ROLE_SETTINGS = Object.freeze({
  statement_timeout: "2s",
  idle_in_transaction_session_timeout: "5s",
  lock_timeout: "1s"
});
