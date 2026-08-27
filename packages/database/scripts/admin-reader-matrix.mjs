/**
 * What the control plane's database role is allowed to read.
 *
 * This file is the privilege policy for the admin panel, written as data rather
 * than as prose. Everything the dashboard can ever show has to pass through a
 * role that holds these grants and nothing else, so a bug in a query — a stray
 * `include`, a `select: undefined`, a future endpoint written in a hurry —
 * cannot return a column that is not listed here. PostgreSQL refuses it.
 *
 * Two rules decide every entry.
 *
 * A column is denied if it is, or points at, customer document content. That
 * covers the obvious (`display_name` is the customer's own filename) and the
 * less obvious: an object key is the address of the bytes, a content digest
 * confirms a suspected file, and a JSON payload is a column whose contents are
 * decided by whatever wrote it last.
 *
 * A column is denied if it is a credential, a digest of one, or a lease token.
 * The dashboard never needs one, and the cheapest way to guarantee a compromised
 * admin backend cannot read them is for its role not to hold the grant.
 *
 * Everything else — states, counts, sizes, codes, amounts and timestamps — is
 * operational metadata and is exactly what an operator is meant to see.
 *
 * `verify` fails when a table exists in the database that appears in neither
 * list. New tables are therefore denied by default and force a decision here,
 * which is the property that keeps this file true as the schema grows.
 */

/** The role the API's admin read pool connects as. Never owns anything. */
export const ADMIN_READER_ROLE = "printing_kiosk_admin_reader";

/**
 * Tables the reader may SELECT.
 *
 * `"*"` grants every column. An array grants exactly those columns and denies
 * the rest, including columns added later — a new column is invisible until
 * somebody adds it here and re-runs `provision`.
 */
export const READABLE_TABLES = Object.freeze({
  // Operational surfaces. No secrets, no customer content.
  kiosks: "*",
  // Device-plane health is operational data. Stable installation identifiers,
  // capability digests and device identifiers remain denied by omission.
  kiosk_agents: [
    "id",
    "kiosk_id",
    "agent_version",
    "platform",
    "platform_release",
    "adapter",
    "queue_name",
    "printer_health",
    "active_operations",
    "registered_at",
    "last_heartbeat_at",
    "updated_at"
  ],
  printers: [
    "id",
    "kiosk_id",
    "queue_name",
    "adapter",
    "approval",
    "queue_state",
    "is_default",
    "shared",
    "driver_name",
    "port_name",
    "make_and_model",
    "firmware",
    "health",
    "warning_code",
    "last_seen_at",
    "last_healthy_at",
    "updated_at"
  ],
  print_sessions: "*",
  cleanup_runs: "*",
  refunds: "*",
  payments: "*",
  payment_webhook_inbox: "*",
  price_quotes: "*",
  pricing_rule_sets: "*",
  pricing_rules: "*",
  audit_events: "*",
  admin_kiosk_scopes: "*",
  // An operator's own account of what they saw at a tray. Every column is
  // meant to be read back — including `reason`, which is free text written by
  // somebody the system never shows a filename to.
  print_job_recovery_resolutions: "*",
  // The later accounts that supersede one. Readable for the same reason and by
  // the same argument: the panel shows the whole chain, because a correction
  // that hid what it corrected would be an edit wearing a different name.
  print_job_recovery_corrections: "*",
  // Why a refund exists when a person is the reason. Readable so the money
  // screens can say who decided and on what evidence, rather than showing an
  // obligation that appears to have raised itself.
  refund_authorizations: "*",
  // Who asked retention to try again, and about which failure. Operational
  // state the retention screen reports; it names no document and no object key.
  cleanup_retry_requests: "*",
  // Software inventory only: counts, actors and timestamps. No document data.
  kiosk_paper_events: "*",

  // `selections` carries per-document content digests until retention strips
  // them. The priced aggregates beside it answer every operational question.
  print_setting_revisions: [
    "id",
    "session_id",
    "revision",
    "paper_size",
    "scaling",
    "collate",
    "color_mode",
    "selections_redacted_at",
    "selected_pages",
    "printed_sides",
    "physical_sheets",
    "capability_version",
    "manifest_hash",
    "created_by_actor_type",
    "created_by_actor_id",
    "created_at"
  ],

  // `idempotency_key_digest` is a digest of a caller-supplied key.
  payment_attempts: [
    "id",
    "payment_id",
    "attempt",
    "action",
    "status",
    "provider_reference",
    "failure_code",
    "created_at"
  ],

  // `job_manifest` is the per-document list the job was paid for. The hash of
  // it stays readable: it is the evidence that the manifest was not changed,
  // and it names nothing.
  print_jobs: [
    "id",
    "session_id",
    "kiosk_id",
    "quote_id",
    "payment_id",
    "settings_revision",
    "settings_manifest_hash",
    "job_manifest_hash",
    "status",
    "result_confidence",
    "failure_code",
    "warning_code",
    "simulated_outcome",
    "manifest_redacted_at",
    "copies",
    "printed_sides",
    "physical_sheets",
    "sheets_produced",
    "dispatch_attempts",
    "available_at",
    "deadline_at",
    "cancel_requested_at",
    "created_by_actor_type",
    "created_by_actor_id",
    "created_at",
    "updated_at",
    "dispatched_at",
    "started_at",
    "completed_at",
    "failed_at"
  ],

  // `detail` is free-form JSON written by the print path. Its current contents
  // are counts, but a column whose shape is decided elsewhere is not a column
  // the control plane should hold a standing grant on.
  print_job_events: [
    "id",
    "print_job_id",
    "sequence",
    "type",
    "operation_id",
    "status",
    "confidence",
    "failure_code",
    "warning_code",
    // The device's own account of the operation, bounded by the agent contract
    // on the way in. Unlike `detail` beside it, which stays free-form and
    // ungranted, this is a fixed shape the job detail screen renders.
    "device_detail",
    "created_at"
  ],

  // `payload` tells a kiosk which documents to fetch. `claim_token` is a lease.
  agent_commands: [
    "id",
    "kiosk_id",
    "session_id",
    "print_job_id",
    "operation_id",
    "type",
    "status",
    "attempts",
    "available_at",
    "claimed_at",
    "lease_expires_at",
    "expires_at",
    "result_code",
    "completed_at",
    "created_at",
    "updated_at"
  ],

  // The session timeline is built from type and ordering alone. `payload`
  // carries per-file snapshots, so the grant stops at the envelope.
  session_events: ["id", "session_id", "kiosk_id", "sequence", "type", "occurred_at", "created_at"],

  outbox_events: [
    "id",
    "aggregate_type",
    "aggregate_id",
    "sequence",
    "type",
    "status",
    "publish_attempts",
    "available_at",
    "locked_at",
    "last_error_code",
    "created_at",
    "published_at"
  ],

  // The document privacy boundary, stated as a grant. Sizes, MIME types, page
  // counts, states and error codes are readable; the customer's filename, the
  // content digest and the object key are not, at any role.
  uploaded_files: [
    "id",
    "session_id",
    "ordinal",
    "status",
    "kind",
    "declared_mime",
    "detected_mime",
    "extension",
    "reserved_bytes",
    "size_bytes",
    "rejection_code",
    "processing_revision",
    "processing_generation",
    "processing_attempts",
    "processing_available_at",
    "processing_enqueued_at",
    "processing_lease_expires_at",
    "processing_started_at",
    "processing_error_code",
    "malware_scan_status",
    "page_count",
    "cleanup_attempts",
    "cleanup_due_at",
    "cleanup_error_code",
    "created_at",
    "updated_at",
    "quarantined_at",
    "ready_at",
    "delete_requested_at",
    "deleted_at"
  ],

  // Page geometry is operational. `preview_derivative_id` resolves to a
  // rendered page image, which is the most sensitive artifact in the system.
  file_pages: [
    "id",
    "file_id",
    "processing_revision",
    "page_number",
    "width_pixels",
    "height_pixels",
    "created_at"
  ],

  // Enough to put a colleague's name on an audit row. Not the WebAuthn handle.
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

  // Phase 4B: the people section has to answer "can this person work, and
  // should they" — which needs how many keys they hold, when each was last
  // used, and how many sessions are live. None of that is a credential, and the
  // columns that are stay denied by omission: `credential_id` and `public_key`
  // identify and verify a key, `sign_count`, `transports` and `aaguid` describe
  // the device holding it, and none of the five is anything an operator reads.
  admin_authenticators: [
    "id",
    "admin_user_id",
    "attachment",
    "backup_eligible",
    "backed_up",
    "label",
    "created_at",
    "last_used_at",
    "revoked_at",
    "revoked_reason"
  ],

  // Enough to count live sessions and say when one was last used. `token_digest`
  // and `csrf_digest` are absent: a digest is not replayable, but the panel has
  // no question that needs one, and the cheapest guarantee is the missing grant.
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

  // Whether an invitation or a password reset is outstanding on an account,
  // and until when — credentials in flight are exactly what the roster exists
  // to surface. Never `secret_digest`: the redeemable half lives on the
  // application connection, which is the only thing that ever needs to match
  // one.
  admin_invitations: [
    "id",
    "admin_user_id",
    "issued_by_admin_id",
    "reason",
    "created_at",
    "expires_at",
    "consumed_at",
    "revoked_at"
  ],

  admin_password_resets: [
    "id",
    "admin_user_id",
    "issued_by_admin_id",
    "reason",
    "created_at",
    "expires_at",
    "consumed_at",
    "revoked_at"
  ],

  // Presence only: the roster says whether an account has a password, never
  // anything about it. The digest column is denied by omission, so a query
  // that asked for it would be refused by PostgreSQL.
  admin_passwords: ["admin_user_id"],

  // What has been proposed about the tariff, and what became of it. Readable in
  // full: a change request contains numbers somebody typed into a form and the
  // reasons two people gave, and the whole point of the workflow is that both
  // are visible to anybody who can see the section. There is no digest here that
  // is a credential — `payload_digest` is a checksum of public numbers.
  admin_change_executions: "*"
});

/**
 * Tables the reader holds no grant on at all.
 *
 * Each entry is a deliberate refusal with its reason. A table listed here is
 * unreadable from the control plane even if an endpoint asks for it.
 */
export const DENIED_TABLES = Object.freeze({
  kiosk_credentials:
    "A kiosk credential can fetch print-ready documents and page previews. Reading these rows is the escalation path the capability model exists to close.",
  session_upload_grants: "Upload token and short-code digests.",
  mobile_clients: "Phone session cookie and nonce digests.",
  file_derivatives:
    "Object keys: the storage address of original uploads, normalized PDFs and rendered page images. The control plane must not be able to name them, let alone hold a credential for them.",
  admin_webauthn_challenges: "In-flight ceremony state.",
  admin_break_glass_credentials: "Recovery credential digests.",
  idempotency_records: "Stored response bodies from every replayed request.",
  system_metadata: "Free-form configuration values.",
  _prisma_migrations: "Schema management, not operational data."
});

/**
 * Connection-level settings pinned onto the role.
 *
 * `default_transaction_read_only` is the belt to the grants' braces: even a
 * table the reader can SELECT cannot be written, and the failure is a
 * PostgreSQL error rather than a silent success. The timeouts are the answer to
 * "a dashboard query must never degrade printing" — a slow admin query is
 * cancelled rather than allowed to hold resources the print path needs.
 */
export const ROLE_SETTINGS = Object.freeze({
  default_transaction_read_only: "on",
  statement_timeout: "5s",
  idle_in_transaction_session_timeout: "10s",
  lock_timeout: "2s"
});

/** Every table this policy has an opinion about. */
export function decidedTables() {
  return [...Object.keys(READABLE_TABLES), ...Object.keys(DENIED_TABLES)].sort();
}

/**
 * Tables present in the database that this policy has not decided.
 *
 * A non-empty result is a failure, not a warning: it means a migration added a
 * table and nobody said whether the control plane may read it.
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

/**
 * Columns of a readable table that the reader must NOT hold a grant on.
 *
 * Derived rather than listed, so adding a column to the schema without adding
 * it to the allow-list denies it automatically.
 */
export function deniedColumnsFor(table, existingColumns) {
  const allowed = READABLE_TABLES[table];
  if (allowed === undefined || allowed === "*") return [];
  const allowedSet = new Set(allowed);
  return existingColumns.filter((column) => !allowedSet.has(column));
}

/**
 * Allow-listed columns that the live schema does not have.
 *
 * A renamed or dropped column would otherwise leave a grant that silently
 * matches nothing, and the policy would read as stricter than it is.
 */
export function missingColumnsFor(table, existingColumns) {
  const allowed = READABLE_TABLES[table];
  if (allowed === undefined || allowed === "*") return [];
  const existing = new Set(existingColumns);
  return allowed.filter((column) => !existing.has(column));
}
