/**
 * The one connection in this system that can change what a customer is charged.
 *
 * This deployment has one Admin, so there is no second person between this
 * credential and the prices. The grants below are therefore not shaped to
 * prevent a bad publication — they are shaped so that no publication can happen
 * without leaving a record the same connection cannot alter, and so that the
 * blast radius of the credential stops at the tariff.
 *
 * Four properties of the grants below are worth stating plainly, because each
 * one is a thing a compromised admin backend holding this credential cannot do:
 *
 *   - **It cannot publish without recording who did.** A deferred constraint
 *     trigger recomputes the tariff's canonical digest from the rows actually
 *     written and refuses at COMMIT unless a row in `admin_change_executions`
 *     names that rule set with that digest — and that table takes no UPDATE and
 *     no DELETE from any role, this one included. Publishing something other
 *     than what was recorded is not a bug that can happen.
 *   - **It cannot edit a tariff.** UPDATE is held on three columns of
 *     `pricing_rule_sets` — `status`, `archived_at`, `updated_at` — and nothing
 *     else anywhere. Amounts, currency, version and validity are unreachable
 *     once written, which is what "publish a new version" means.
 *   - **It cannot un-archive.** A trigger bounds that UPDATE to two transitions,
 *     DRAFT → PUBLISHED and PUBLISHED → ARCHIVED, so an old tariff cannot be
 *     brought back into force without going through the workflow like anything
 *     else.
 *   - **It cannot touch a quote or a payment.** What a customer was quoted, and
 *     what they paid, are evidence. Changing the tariff does not reach back.
 */

/** The role the API's pricing pool connects as. Never owns anything. */
export const ADMIN_PRICING_WRITER_ROLE = "printing_kiosk_admin_pricing_writer";

/**
 * The tables this role may add a row to.
 *
 * A publication is four inserts and two updates, all in one transaction: the
 * draft tariff, its single rule, the record of who published it, the audit
 * event — then the archival of the tariff being replaced and the promotion of
 * the draft.
 */
export const INSERTABLE_TABLES = Object.freeze({
  pricing_rule_sets:
    "The new tariff, published. Its predecessor is archived in the same transaction.",
  pricing_rules:
    "The numbers. Exactly one row per tariff: the schema pins service, paper size and colour mode to one value each.",
  admin_change_executions:
    "Who published this tariff, and why. A trigger refuses a row naming anybody but an active Admin, and no role can edit or delete one afterwards.",
  audit_events: "Every publication records itself here, including the ones that were refused."
});

/**
 * The only UPDATE grant in the control plane outside the people role, and the
 * narrowest one in it.
 *
 * `status` is how a tariff starts and stops applying — a publication is written
 * as a draft, given its rules, and then published, because rules may only be
 * attached to a set that is not yet published. `archived_at` dates the tariff
 * being replaced. `updated_at` is Prisma's, and it is here because the ORM
 * writes it on every update rather than because anybody needs it to change.
 *
 * What is absent is the grant: `unit_amount_minor`, `currency`, `version`,
 * `valid_from`, `published_at` and everything else stay unwritable after the
 * insert that created them. A published tariff is immutable, enforced by a
 * trigger since Phase 6 and now by a missing grant as well. `published_at` in
 * particular is written by the insert that creates the draft, so a tariff cannot
 * be published carrying somebody else's publication date.
 */
export const UPDATABLE_COLUMNS = Object.freeze({
  pricing_rule_sets: ["status", "archived_at", "updated_at"]
});

/**
 * Tables this role may SELECT, and the columns it may see.
 *
 * Everything here is read inside the transaction that writes, to decide whether
 * the publication may proceed: is the tariff the Admin was shown still the
 * tariff in force, and is the account performing this still an active Admin.
 */
export const READABLE_TABLES = Object.freeze({
  // The tariff being replaced, and the one being written, read back to answer
  // with the version now in force.
  pricing_rule_sets: "*",
  pricing_rules: "*",

  // What has been published before, so the panel can show the log and the
  // trigger can find the record it just wrote.
  admin_change_executions: "*",

  // The publisher, revalidated at execution time so a suspended account with a
  // live session cannot still publish — plus the display name, so the record
  // names a person rather than a UUID.
  admin_users: ["id", "display_name", "role", "status", "disabled_at", "suspended_at"],

  audit_events: "*"
});

/**
 * Tables this role must hold no privilege on whatsoever — not even SELECT.
 *
 * `price_quotes` is the one worth pausing on. A quote is what a named customer
 * was told they would pay, and it is the evidence a payment is checked against.
 * Publishing a tariff changes what the *next* quote costs and must not be able
 * to reach the ones already issued, so this connection cannot even read them.
 */
export const FORBIDDEN_TABLES = Object.freeze({
  kiosk_paper_inventory:
    "The paper estimate is an operational count, not part of publishing a tariff.",
  kiosk_paper_requests: "The idempotency record beside it, for the same reason.",
  price_quotes: "What a customer was already quoted. A new tariff does not reach backwards.",
  refunds: "Money owed back.",
  refund_authorizations: "The record of who authorized a payout.",
  payments: "Captures.",
  payment_attempts: "The provider ledger.",
  payment_webhook_inbox: "Provider callbacks. A forged row here is a forged payment.",
  print_jobs: "The printing system.",
  print_job_events: "The device's own ledger.",
  print_job_recovery_resolutions: "What an operator saw at a tray.",
  print_job_recovery_corrections: "A later account of the same print.",
  print_sessions: "Customer sessions.",
  print_setting_revisions: "What was ordered.",
  cleanup_runs: "Retention state.",
  cleanup_retry_requests: "Retention requests belong to the operator writer.",
  agent_commands: "Durable work for a printer.",
  kiosks: "Device configuration. A tariff is global; it names no kiosk.",
  kiosk_credentials:
    "Issuing or rotating a kiosk credential is not reachable from the dashboard in any role, at any risk level.",
  session_upload_grants: "Upload token digests.",
  mobile_clients: "Phone session digests.",
  uploaded_files: "Customer documents.",
  file_derivatives: "Storage addresses of customer documents.",
  file_pages: "Page geometry of customer documents.",
  outbox_events: "The event publication log.",
  session_events: "The session timeline.",
  admin_authenticators: "Enrolling a credential is authenticator.manage, and goes through no pool.",
  admin_sessions: "Session and CSRF digests.",
  admin_kiosk_scopes: "Kiosk scoping is contextual authorization for Operators.",
  admin_webauthn_challenges: "In-flight ceremony state.",
  admin_break_glass_credentials: "Recovery credential digests.",
  admin_passwords: "Password digests.",
  admin_invitations: "Invitation digests. Creating an account is not a pricing action.",
  admin_password_resets: "Reset digests. Recovering an account is not a pricing action.",
  kiosk_agents:
    "The device plane's agent registry. Hardware management is not reachable from any admin connection.",
  printers: "The device plane's printer registry. Same boundary as kiosk_agents.",
  idempotency_records: "Stored response bodies from every replayed request.",
  system_metadata: "Free-form configuration values.",
  _prisma_migrations: "Schema management, not operational data."
});

/**
 * Connection-level settings pinned onto the role.
 *
 * The same ceilings as every other admin write role, and they matter more here
 * than anywhere else: this transaction takes a row lock on the tariff the quote
 * path reads on every price request. It is a short lock on one row and quoting
 * takes no conflicting lock, but a publication that stalled while holding it
 * would be a publication that stopped a kiosk selling, so the ceiling is one
 * second and the failure is a rolled-back publication rather than a queue.
 */
export const ROLE_SETTINGS = Object.freeze({
  statement_timeout: "2s",
  idle_in_transaction_session_timeout: "5s",
  lock_timeout: "1s"
});
