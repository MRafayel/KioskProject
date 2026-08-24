/**
 * The one connection in this system through which a person can put money back.
 *
 * Phase 3's writer role is defined by what it cannot reach: it holds no
 * privilege on `refunds`, `payments` or anything else that touches money, so
 * "an Operator cannot cause a payout" is answerable by reading a grant list
 * rather than by reading the application. Phase 4 had to add the ability to
 * authorize a refund without discarding that answer.
 *
 * The way it does that is this role. It holds INSERT on `refunds`, on the
 * record of who authorized one, and on the audit log — and nothing else,
 * anywhere. So the question stays exactly as answerable as it was, with a
 * slightly longer answer:
 *
 *     Which connection can create a monetary obligation?
 *     printing_kiosk_admin_refund_writer, and only it.
 *
 * Three properties of the shape below are worth stating plainly, because each
 * one is a thing a compromised admin backend cannot do:
 *
 *   - **It cannot settle a refund**, only raise one. No UPDATE on `refunds`
 *     means the panel cannot mark an obligation paid, cannot attach a provider
 *     reference to it, and cannot close one that was never honoured. Settlement
 *     belongs to an executor holding a provider credential; nothing in the
 *     control plane holds one.
 *   - **It cannot touch a payment.** No INSERT and no UPDATE on `payments`, so
 *     it cannot invent a capture to refund or rewrite the one it is refunding
 *     against. `amount_minor` on the capture is the ceiling, and this role can
 *     read it but not move it.
 *   - **It cannot record an observation.** No INSERT on
 *     `print_job_recovery_resolutions`. The person who says pages are missing
 *     and the person who pays for it act through different roles on different
 *     pools, which is the same separation the capability model states, restated
 *     where an attacker meets it.
 *
 * A trigger completes the picture from the other side: a refund carrying the
 * `OPERATOR_REQUESTED` reason cannot exist without a row in `refund_authorizations`
 * naming who decided it, and this role may write no other reason code. So the
 * grants say what may be created, and the database says it cannot be created
 * anonymously.
 */

/** The role the API's refund pool connects as. Never owns anything. */
export const ADMIN_REFUND_WRITER_ROLE = "printing_kiosk_admin_refund_writer";

/**
 * The three tables this role may add a row to.
 *
 * All three are append-only. Authorizing a refund produces new facts — an
 * obligation, its justification, and the audit event — and no edited ones.
 */
export const INSERTABLE_TABLES = Object.freeze({
  refunds: "The obligation itself, at PENDING. Raising one is not paying it.",
  refund_authorizations:
    "Who authorized it, on what evidence, and why. Written in the same transaction as the obligation, and required by a deferred trigger.",
  audit_events: "Every authorization records itself here, including the ones that were refused."
});

/**
 * Tables this role may SELECT, and the columns it may see.
 *
 * Narrow for the same reason the writer's list is narrow: this connection
 * exists to decide, inside the transaction that writes, whether this refund may
 * be created and for how much. The panel's reading is done by the read role.
 *
 * Nothing here names a document. A refund decision is made from what was paid
 * and what a person saw come out of a printer, and neither of those is a
 * filename.
 */
export const READABLE_TABLES = Object.freeze({
  // The capture being refunded. `amount_minor` and the currency are the
  // ceiling and the denomination; `status` is what makes a refund meaningful at
  // all. This role cannot write a single one of these columns.
  payments: [
    "id",
    "session_id",
    "status",
    "provider",
    "amount_minor",
    "currency",
    "currency_exponent"
  ],

  // Everything already owed on that payment, so the sum of obligations cannot
  // exceed the capture. Read back also to replay an identical repeat rather
  // than failing it.
  refunds: "*",
  refund_authorizations: "*",

  // The print the money paid for, and the evidence that it did not come out.
  print_jobs: [
    "id",
    "session_id",
    "kiosk_id",
    "payment_id",
    "status",
    "result_confidence",
    "failure_code",
    "sheets_produced",
    "physical_sheets",
    "created_at"
  ],
  print_sessions: ["id", "kiosk_id", "state", "created_at"],

  // The account of the print this decision rests on: the original observation
  // and any correction to it. An authorization must cite one of these rows.
  print_job_recovery_resolutions: "*",
  print_job_recovery_corrections: "*",

  // The acting account, revalidated at execution time so a suspended account
  // with a live session cannot still authorize a payout — plus the display
  // name, so the record names a person rather than a UUID.
  admin_users: ["id", "display_name", "role", "status", "disabled_at", "suspended_at"],

  // Readable because appending is not write-only in practice: the client issues
  // INSERT ... RETURNING, so a role that may add an audit row must be able to
  // read the row it just added. Granting SELECT costs nothing here — this is the
  // control plane's own log, which the reader role already reads in full.
  audit_events: "*",

  kiosks: ["id", "name", "status"]
});

/**
 * Tables this role must hold no privilege on whatsoever — not even SELECT.
 *
 * The list is short because everything not named in READABLE_TABLES is already
 * denied. These are the ones where the absence is load-bearing enough to assert
 * out loud, so that adding a grant means contradicting a sentence somebody
 * wrote on purpose.
 */
export const FORBIDDEN_TABLES = Object.freeze({
  payment_attempts: "The provider ledger. Written by the payment path, never by a person.",
  payment_webhook_inbox: "Provider callbacks. A forged row here is a forged payment.",
  print_job_events: "The device's own ledger.",
  agent_commands: "Durable work for a printer.",
  cleanup_runs: "Retention state. Nothing about money reaches it.",
  cleanup_retry_requests: "Retention requests belong to the operator writer, not to this role.",
  kiosk_credentials:
    "Issuing or rotating a kiosk credential is not reachable from the dashboard in any role, at any risk level.",
  session_upload_grants: "Upload token digests.",
  mobile_clients: "Phone session digests.",
  uploaded_files: "Customer documents.",
  file_derivatives: "Storage addresses of customer documents.",
  file_pages: "Page geometry of customer documents.",
  pricing_rule_sets: "Publishing a tariff has its own role: printing_kiosk_admin_pricing_writer.",
  pricing_rules: "Publishing a tariff has its own role: printing_kiosk_admin_pricing_writer.",
  price_quotes: "What a customer was quoted is evidence of what they agreed to pay.",
  admin_change_executions:
    "Changing the tariff belongs to the pricing role. The connection that can pay a customer must not also be able to change what customers are charged.",
  print_setting_revisions: "What was ordered.",
  outbox_events: "The event publication log.",
  session_events: "The session timeline.",
  admin_authenticators: "Enrolling a credential is authenticator.manage, and goes through no pool.",
  admin_sessions: "Session and CSRF digests.",
  admin_kiosk_scopes:
    "Kiosk scoping is contextual authorization for Operators, and no Operator can authorize a refund.",
  admin_webauthn_challenges: "In-flight ceremony state.",
  admin_break_glass_credentials: "Recovery credential digests.",
  admin_passwords:
    "Password digests. The connection that can pay a customer must not be able to read or replace what signs anybody in.",
  admin_invitations:
    "Invitation digests. The connection that can pay a customer must not be able to mint the identity that asks it to.",
  admin_password_resets: "Reset digests. Same boundary as invitations.",
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
 * The same ceilings as the writer role. An authorization is one short
 * transaction that reads a handful of rows by primary key and inserts three; a
 * statement running longer than two seconds is a fault, and a lock held against
 * the print path is the fault that matters most. Printing does not slow down
 * because somebody approved a refund.
 */
export const ROLE_SETTINGS = Object.freeze({
  statement_timeout: "2s",
  idle_in_transaction_session_timeout: "5s",
  lock_timeout: "1s"
});
