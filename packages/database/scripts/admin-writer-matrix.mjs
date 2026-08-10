/**
 * What the control plane's database role is allowed to change.
 *
 * Phase 2 gave the admin panel a role that can only read. This is the role it
 * uses for the handful of things an operator is allowed to *do*, and it is
 * written the same way: as data, so that the answer to "could a compromised
 * admin backend move money" is a grant list rather than a code review.
 *
 * The shape of this policy is the whole point. It holds INSERT on two tables
 * and nothing else — no UPDATE and no DELETE anywhere in the database, on any
 * table, ever. That is not a coincidence of the current feature set; it is the
 * Phase 3 acceptance gate expressed as a privilege:
 *
 *   - It cannot touch `refunds` or `payments`, so an Operator cannot cause a
 *     payout. Money is `refund.authorize`, a later phase and a different role.
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
 * The only two tables this role may add a row to.
 *
 * Both are append-only by trigger as well: an admin action produces new facts,
 * never edited ones.
 */
export const INSERTABLE_TABLES = Object.freeze({
  print_job_recovery_resolutions:
    "One operator observation per print job that the device could not settle.",
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

  // Read back to replay an identical repeat submission instead of failing it.
  print_job_recovery_resolutions: "*",

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
    "Money. Creating or settling an obligation is refund.authorize, which nobody holding print.recovery.resolve holds by that fact alone.",
  payment_attempts: "The provider ledger. Written by the payment path, never by a person.",
  payment_webhook_inbox: "Provider callbacks. A forged row here is a forged payment.",
  kiosk_credentials:
    "Issuing or rotating a kiosk credential is not reachable from the dashboard in any role, at any risk level.",
  session_upload_grants: "Upload token digests.",
  mobile_clients: "Phone session digests.",
  uploaded_files: "Customer documents.",
  file_derivatives: "Storage addresses of customer documents.",
  file_pages: "Page geometry of customer documents.",
  cleanup_runs:
    "Retention state. Re-arming a dead-lettered run is document.retention.retry, a later phase, and it goes through the worker rather than through a row edit.",
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

/** Every table this policy has an opinion about. */
export function decidedTables() {
  return [
    ...new Set([
      ...Object.keys(INSERTABLE_TABLES),
      ...Object.keys(READABLE_TABLES),
      ...Object.keys(FORBIDDEN_TABLES)
    ])
  ].sort();
}

/**
 * Tables present in the database that this policy has not decided.
 *
 * A non-empty result stops the tool. A migration that adds a table has to say
 * whether the control plane may write to it, and the answer is written down
 * before the role is provisioned rather than discovered afterwards.
 */
export function undecidedTables(existingTables) {
  const decided = new Set(decidedTables());
  return existingTables.filter((table) => !decided.has(table)).sort();
}

/** Tables named by the policy that no longer exist. Stale entries to remove. */
export function staleTables(existingTables) {
  const existing = new Set(existingTables);
  return decidedTables().filter((table) => !existing.has(table));
}

/** Columns of a readable table the writer must NOT hold a grant on. */
export function deniedColumnsFor(table, existingColumns) {
  const allowed = READABLE_TABLES[table];
  if (allowed === undefined || allowed === "*") return [];
  const allowedSet = new Set(allowed);
  return existingColumns.filter((column) => !allowedSet.has(column));
}

/** Allow-listed columns the live schema does not have. */
export function missingColumnsFor(table, existingColumns) {
  const allowed = READABLE_TABLES[table];
  if (allowed === undefined || allowed === "*") return [];
  const existing = new Set(existingColumns);
  return allowed.filter((column) => !existing.has(column));
}

/**
 * A table appearing in both the insertable and forbidden lists is a policy
 * contradiction, and the safe reading of a contradiction is "forbidden".
 * Checked rather than assumed, because the two lists are edited separately.
 */
export function contradictoryTables() {
  return Object.keys(INSERTABLE_TABLES)
    .filter((table) => table in FORBIDDEN_TABLES)
    .sort();
}
