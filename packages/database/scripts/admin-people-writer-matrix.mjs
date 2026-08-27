/**
 * What the control plane's database role is allowed to change about a person.
 *
 * Three roles before this one answered "could a compromised admin backend do X"
 * with a grant list, and each of them could answer it the same short way: no
 * UPDATE, anywhere, ever. This is the first role that holds one, so the property
 * that makes it reviewable has to be stated differently and more carefully —
 *
 *     UPDATE on a named list of *columns*, and no table-level UPDATE, no
 *     DELETE, and no TRUNCATE anywhere in the database.
 *
 * — which is the question this file exists to keep answerable. "What can this
 * connection change about a person" is `UPDATABLE_COLUMNS` below, in full, and
 * `verify` asserts that PostgreSQL agrees column by column rather than table by
 * table. A grant on one more column is a diff in this file.
 *
 * Four absences are load-bearing, and each is checked rather than assumed:
 *
 *   - **It cannot change anybody's role.** `admin_users.role` is absent from
 *     the updatable list, so no path through this connection promotes an
 *     Operator, and a compromised Admin account cannot make itself a Technical
 *     Admin. That is the single most valuable column in the database to hold
 *     and this role does not hold it.
 *   - **It cannot enrol an authenticator.** It has no INSERT on
 *     `admin_authenticators` and may only set `revoked_at` and `revoked_reason`
 *     on one that exists. Enrolment needs a WebAuthn ceremony on the
 *     application connection; this role can end a key's life, never start one.
 *   - **It cannot read a credential or a session token.** Column-level SELECT
 *     stops short of `credential_id`, `public_key`, `user_handle`,
 *     `token_digest`, `csrf_digest` and the ticket digest it writes. It can
 *     revoke a session it cannot replay.
 *   - **It holds nothing at all on any product table.** Not a print job, not a
 *     payment, not a refund, not a document. Managing people and touching the
 *     printing system are different jobs and this connection can only do one.
 *
 * The triggers on these tables are still the mechanism for the invariants that
 * matter — a privileged account cannot fall below two authenticators, an
 * account's status cannot move backwards, a ticket is single use. This role
 * cannot disable any of them: the tables are owned by `printing_kiosk_migrator`
 * (see `admin-owner.mjs`), and an owner's rights are what switching off a
 * trigger requires.
 */

/** The role the API's admin people pool connects as. Never owns anything. */
export const ADMIN_PEOPLE_WRITER_ROLE = "printing_kiosk_admin_people_writer";

/**
 * The columns this role may change, and nothing else in the database.
 *
 * Read it as a sentence per table. Note what each list stops short of: a status
 * but not a role, a revocation but not an enrolment, an end to an assignment but
 * not the assignment's subject.
 */
export const UPDATABLE_COLUMNS = Object.freeze({
  // Suspend, resume, disable. `role` is absent, and so are `user_handle`,
  // `display_name`, `created_at` and `activated_at`: the account's identity and
  // its history are not administrative attributes.
  admin_users: ["status", "suspended_at", "disabled_at", "updated_at"],

  // Retiring somebody's key. Only the two revocation columns — the trigger that
  // keeps an ACTIVE account above its minimum still applies, and the immutable
  // identity columns beside these are refused by another one.
  admin_authenticators: ["revoked_at", "revoked_reason"],

  // Ending a session. Nothing here extends one, and nothing here can read the
  // token that would let it be used.
  admin_sessions: ["revoked_at", "revoked_reason"],

  // Taking a kiosk away, and giving it back. `revoked_at` is the only column,
  // so an assignment cannot be re-pointed at a different person or kiosk — the
  // history of who could act where stays as it was written.
  admin_kiosk_scopes: ["revoked_at"]
});

/**
 * The tables this role may add a row to.
 *
 * Two, and they are different in kind. A kiosk assignment is state somebody
 * administers; an audit event is the record that they did. Nothing else on this
 * connection creates a row, and in particular nothing creates an account, an
 * authenticator or a session.
 */
export const INSERTABLE_TABLES = Object.freeze({
  admin_kiosk_scopes:
    "Assigning a kiosk to an Operator for the first time. A repeat assignment clears revoked_at on the row that already exists.",
  audit_events: "Every people action records itself here, including the ones that failed."
});

/**
 * Tables this role may SELECT, and the columns it may see.
 *
 * Narrower than the read role's, and pointed at a different question. The panel
 * reads people through `printing_kiosk_admin_reader`; this connection reads only
 * to revalidate inside the transaction that writes — is this still an Operator,
 * are they still ACTIVE, do they still hold a spare key — and so the list stops
 * at exactly those columns.
 */
export const READABLE_TABLES = Object.freeze({
  // Revalidated inside the writing transaction: the role decides whether this
  // account is one this capability may touch at all, the status decides whether
  // the transition is permitted, and `activated_at` decides whether a suspended
  // account may be resumed. `user_handle` is absent — it is the WebAuthn
  // identifier and no people action needs it.
  admin_users: [
    "id",
    "username",
    "display_name",
    "role",
    "status",
    "created_at",
    "updated_at",
    "activated_at",
    "suspended_at",
    "disabled_at",
    "last_login_at"
  ],

  // Counting the spares before retiring one, and confirming the key being
  // retired belongs to the account named in the path. Never `credential_id`,
  // `public_key` or `sign_count`: this connection revokes credentials it cannot
  // identify to an authenticator, let alone verify with.
  admin_authenticators: [
    "id",
    "admin_user_id",
    "label",
    "attachment",
    "backup_eligible",
    "backed_up",
    "created_at",
    "last_used_at",
    "revoked_at",
    "revoked_reason"
  ],

  // Finding the live sessions to end. `token_digest` and `csrf_digest` are
  // absent, so this role can revoke a session and still not recognise one.
  admin_sessions: [
    "id",
    "admin_user_id",
    "created_at",
    "idle_expires_at",
    "hard_expires_at",
    "last_seen_at",
    "last_step_up_at",
    "revoked_at",
    "revoked_reason"
  ],

  admin_kiosk_scopes: "*",

  // An assignment must name a kiosk that exists. Nothing more is read of it.
  kiosks: ["id", "name", "status"],

  // Written and read back by the same `INSERT ... RETURNING` the other roles
  // use. The defect that taught us this is in ADMIN_PHASE_4_STATUS.md §4.2.
  audit_events: "*"
});

/**
 * Tables this role must hold no privilege on whatsoever — not even SELECT.
 *
 * The whole product is here, which is the point: the connection that
 * administers people has no reason to know that printing exists, and asserting
 * the absence explicitly means a future migration cannot quietly hand it one.
 */
export const FORBIDDEN_TABLES = Object.freeze({
  kiosk_paper_events:
    "Paper inventory is an operational ledger, not part of account administration.",
  admin_webauthn_challenges:
    "In-flight ceremony state. Managing a person does not mean standing in the middle of their WebAuthn ceremony.",
  admin_break_glass_credentials:
    "Recovery credential digests. Break-glass is a sealed offline artifact issued by CLI; nothing reachable from a browser touches it.",
  admin_passwords:
    "Password digests. The connection that suspends people must never read, plant or replace the thing that signs them in.",
  admin_invitations:
    "Invitation digests. Creating an account and its one-time code is the identity service's act on the application connection, with the invitation matrix in front of it.",
  admin_password_resets:
    "Reset digests. Same boundary as invitations: issued and redeemed on the application connection only.",

  refunds: "Money. Its own role, its own pool: printing_kiosk_admin_refund_writer.",
  refund_authorizations: "The record of who decided a payout.",
  payments: "The capture ledger.",
  payment_attempts: "The provider ledger.",
  payment_webhook_inbox: "Provider callbacks. A forged row here is a forged payment.",
  print_jobs: "What the device reported. Administering people does not touch printing.",
  print_sessions: "The session state machine.",
  print_job_events: "The device's own ledger.",
  print_job_recovery_resolutions:
    "An operator's account of what they saw. The connection that manages operators must not be able to write one in their name.",
  print_job_recovery_corrections: "A later account superseding one of those.",
  print_setting_revisions: "What was ordered.",
  cleanup_runs: "Retention state.",
  cleanup_retry_requests: "A person asking retention to try again.",
  kiosk_credentials:
    "Issuing or rotating a kiosk credential is not reachable from the dashboard in any role, at any risk level.",
  session_upload_grants: "Upload token digests.",
  mobile_clients: "Phone session digests.",
  uploaded_files: "Customer documents.",
  file_derivatives: "Storage addresses of customer documents.",
  file_pages: "Page geometry of customer documents.",
  pricing_rule_sets: "Publishing a tariff has its own role: printing_kiosk_admin_pricing_writer.",
  pricing_rules: "Publishing a tariff has its own role: printing_kiosk_admin_pricing_writer.",
  price_quotes: "What a customer was quoted.",
  admin_change_executions:
    "Changing the tariff belongs to the pricing role. The connection that can suspend somebody must not also be able to change what the prices are.",
  agent_commands: "Durable work for a printer.",
  outbox_events: "The event publication log.",
  session_events: "The session timeline.",
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
 * The same shape as the write role's, and for the same reason: a people action
 * is one short transaction against a handful of rows by primary key, so a
 * statement running past two seconds is a fault rather than a slow query. These
 * tables are small and uncontended, but the print path shares a cluster with
 * them and a lock held here is a lock held against it.
 */
export const ROLE_SETTINGS = Object.freeze({
  statement_timeout: "2s",
  idle_in_transaction_session_timeout: "5s",
  lock_timeout: "1s"
});
