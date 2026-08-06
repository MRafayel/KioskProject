# Phase 9 status

- Date: 2026-08-04
- Last audited: 2026-08-06
- Status: complete for the pilot/prototype acceptance boundary
- Scope: a finished session's documents removed by a durable, resumable
  workflow; every copy accounted for, including the ones no database row names;
  and a tombstone the database will not let anybody write until it is true

"Complete" here means the local pilot is integrated, migration-safe, and
covered by automated gates. It does not mean the commercial items under
[Known boundaries before commercial distribution](#known-boundaries-before-commercial-distribution)
are done.

## What Phase 9 adds

1. Every path that ends a session — a cancellation, an expiry, a finished or
   failed print — writes a retention schedule in the same transaction as the
   transition. Nothing depends on the ending process surviving long enough to
   enqueue anything.
2. The schedule is a policy, not a constant. A customer who walked away waits
   for nothing: a canceled or expired session's documents are deletable
   immediately. A finished print keeps its documents for a receipt window, and
   a result no device could confirm keeps them for a short operator review.
3. Deletion is a workflow. A `cleanup_runs` row holds a lease, records the last
   checkpoint that succeeded, and repeats from there after any interruption —
   a crashed worker, a storage outage, a redeployment mid-sweep. Running it
   three times does what running it once does.
4. The order is the point. Access is revoked before anything is deleted, so
   nothing can be written behind the run. Bytes go before rows: a scrubbed row
   can no longer name the object it pointed at, and an object nothing points at
   is one nobody can delete.
5. The storage prefix is then swept by position rather than by ledger. A
   partial upload whose row was never written, an artifact stored by a worker
   whose claim had already been revoked — those are exactly the copies a ledger
   cannot find, and the session identifier is enough to find them anyway.
6. Unfinished multipart uploads are aborted. Their parts are stored bytes that
   no object listing shows and no row names.
7. The relational record keeps its shape and loses its content: upload grant
   digests are deleted, the parser's opinion of each file is scrubbed, settled
   agent commands go, per-document digests are removed from retained settings,
   and a print job's document manifest is replaced by a count. What was paid
   for, what the device reported, and the audit trail stay.
8. `files_deleted_at` is a claim the database checks. A trigger re-reads the
   artifact ledger and refuses the update while any document, derivative or
   page row remains, so a run that skipped a step cannot record that it did not.
9. A cleaned session is closed in both directions: it cannot be reopened, and
   it cannot accept another document. An authorized caller asking for documents
   that are gone gets `410`, not an empty list.
10. A storage reconciler sweeps by age for objects no session accounts for at
    all, and for multipart uploads nobody finished. The bucket lifecycle rule
    stays what it was meant to be — a 24-hour backstop, not the mechanism.
11. The kiosk agent has its own watchdog. It discards spooled documents an
    interrupted print left behind and device output past the window in which a
    redelivery could still need it — locally and unconditionally, which is
    exactly the case where a cloud-issued delete command would never arrive.
12. A run that cannot finish is never quietly closed. Its attempts back off with
    jitter, and when the budget is spent it is dead-lettered and logged as an
    alert, because the documents are still there.

Phase 9 does not add an operator interface for a dead-lettered run, refund
execution, or crypto-erasure of the kiosk's local cache.

## Cleanup path

```text
session ends (cancel / expiry / print settled)
   |  same transaction: files marked, cleanup_status = PENDING, cleanup_due_at
   v
worker SessionCleanupRunner
   |  INSERT ... ON CONFLICT DO NOTHING     one run per session
   |  UPDATE ... FOR UPDATE SKIP LOCKED     one worker per run
   v
SCHEDULED ──▶ ACCESS_REVOKED ──▶ ARTIFACTS_DELETED ──▶ STORAGE_RECONCILED
                                                              |
                                        METADATA_SCRUBBED ◀───┘
                                                |
                                                v
                                           COMPLETED
                                    files_deleted_at + cleanup.completed
   |
   +── failure ──▶ attempts + 1, jittered backoff ──▶ DEAD_LETTER + alert

worker StorageReconciler (independent, by age)
   |  objects and multipart uploads no live session accounts for
   v
object storage lifecycle rule (24 h) — backstop only
```

Each checkpoint is idempotent on its own, so a run interrupted anywhere resumes
without repeating what already succeeded and without skipping what did not.

## Retention policy

| Session outcome     | Grace before deletion                                   |
| ------------------- | ------------------------------------------------------- |
| `CANCELED`          | none                                                    |
| `EXPIRED`           | none                                                    |
| `COMPLETED`         | `RETENTION_SETTLED_GRACE_SECONDS` (default 5 minutes)   |
| `FAILED`            | `RETENTION_SETTLED_GRACE_SECONDS`                       |
| `RECOVERY_REQUIRED` | `RETENTION_RECOVERY_GRACE_SECONDS` (default 15 minutes) |

The policy is a pure function in `packages/domain/src/retention.ts`, so the
API's cancel path, the expiry janitor and the print settlement path cannot
disagree about how long a customer's documents stay.

## What is deleted and what is kept

Deleted:

- the quarantined original, the normalized print-ready PDF and every page
  preview, both by ledger key and by session prefix;
- object versions and delete markers, so deletion is deletion on a bucket that
  keeps history;
- unfinished multipart uploads under the session's prefixes;
- `file_pages` and `file_derivatives` rows;
- `session_upload_grants` rows, which exist only to be checked against a secret
  nobody may present any more;
- settled `agent_commands`, whose payload names every document digest;
- the kiosk's spooled copy and the device's retained output.

Scrubbed to a tombstone:

- `uploaded_files` keeps an ordinal, a size, a status and a timestamp. The
  object key, the content digest, the page count, the declared and detected
  MIME types, the extension and the processing error code are removed.
- `print_jobs.job_manifest` becomes `{"redacted": true, "documentCount": n}`.
  The manifest hash, the counts, the confidence and the failure code stay.
- `print_setting_revisions.selections` keeps file order, page ranges and priced
  aggregates, but loses each selection's `contentSha256` fingerprint.

Kept:

- `payments`, `payment_attempts`, `payment_webhook_inbox`, `refunds`,
  `price_quotes`, `pricing_rule_sets` — the accounting record;
- the non-identifying fields of `print_setting_revisions` — what was priced and
  paid for;
- `audit_events` and `session_events` — the trail, which never contained a
  filename, a key or a digest in the first place;
- the `print_sessions` row itself, as a redacted tombstone.

## Database additions

- `cleanup_runs` — one per session, leased, checkpointed and retryable. A
  trigger refuses a checkpoint that walks backwards, an attempt count that
  rewinds, and any change to a finished run. A half-written lease is refused by
  a constraint, because it is a run two workers could both believe they hold.
- `print_sessions.cleanup_status`, `cleanup_due_at`, `files_deleted_at` — the
  schedule and the tombstone, indexed together so overdue retention is one
  query. Setting `files_deleted_at` runs a trigger that re-reads the artifact
  ledger; a session still holding a document, a derivative or a page cannot
  record that it holds none, and a cleaned session can never be reopened.
- `uploaded_files` — a `BEFORE INSERT` trigger refuses a document for a session
  that has already been cleaned.
- `print_jobs.manifest_redacted_at` — Phase 8's immutable-snapshot trigger now
  permits exactly one manifest change: on a settled job, into the redaction
  marker, recorded by this column, and never again.
- `print_setting_revisions.selections_redacted_at` — the otherwise append-only
  settings snapshot permits exactly one retention amendment: removal of the
  raw document digest and nothing else. Insert-time guards prevent either
  redaction marker from being forged ahead of cleanup.

Every change is additive. A session written before this migration simply has no
run; one that had already ended is adopted as overdue, which is what it is.

## Configuration

```text
RETENTION_SETTLED_GRACE_SECONDS=300     # receipt window for a finished print
RETENTION_RECOVERY_GRACE_SECONDS=900    # operator review for an unconfirmed one
RETENTION_SWEEP_INTERVAL_SECONDS=30
RETENTION_LEASE_SECONDS=120
RETENTION_MAX_ATTEMPTS=8                # then dead-letter and alert
RETENTION_ORPHAN_GRACE_SECONDS=7200     # must outlive the longest session
PRINTER_OUTPUT_RETENTION_SECONDS=900    # must outlive PRINT_JOB_TIMEOUT_SECONDS
```

Configuration validation refuses an orphan grace that could reach a live
session's documents, and device output pruned before the job it belongs to
could still be redelivered — which would turn a duplicate command into a
duplicate print.

The worker's object-storage policy now also permits `s3:DeleteObject`,
`s3:DeleteObjectVersion` and `s3:AbortMultipartUpload` on `quarantine/v1/*`.
Its `s3:PutObject` grant is unchanged and still excludes quarantine: the worker
may delete an upload it can read, and still cannot write one.

## Run locally

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Cancel a session from the kiosk and watch the worker log
`session documents deleted`. Nothing remains under `quarantine/v1/<session>/`,
`normalized/v1/<session>/` or `previews/v1/<session>/`; the session row keeps a
`files_deleted_at` and nothing that identifies a document.

Re-run `pnpm infra:up` after pulling this change: the worker's bucket policy is
applied by `minio-init`, and a worker without the new grants dead-letters every
cleanup run rather than silently skipping it.

## Acceptance gate

Phase 9 is accepted only when all of these pass against the applied migrations
and healthy PostgreSQL, Redis, MinIO, ClamAV, and processor containers:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm audit --prod --audit-level=moderate
pnpm infra:validate
pnpm db:verify-phase8-upgrade
pnpm db:verify-phase9-upgrade
```

`pnpm db:verify-phase9-upgrade` builds an isolated temporary database, applies
Phase 0–8, inserts a live paid session and one that had already ended, applies
Phase 9, and then proves in SQL that a live session is not scheduled and a
finished one is, that a session has one cleanup run, that a run's progress
never walks backwards and a finished one is final, that a partial lease is
refused, that a session cannot claim its documents are gone while it still
holds them, that a cleaned session accepts no further document and cannot be
reopened, that a print manifest can be redacted exactly once and only into the
marker, and that the payment ledger survives all of it.

### Verified evidence — 2026-08-04

- Formatting, lint, type-check, and production builds passed across every
  workspace package.
- Unit and service suites passed, including 26 new retention-policy tests
  (grace table, checkpoint monotonicity under fast-check, bounded jittered
  backoff, prefix derivation and refusal of an identifier that would widen a
  sweep), 12 cleanup-runner tests (bytes before rows, one multipart scan per
  session, resume from checkpoint, three repeated passes, backoff, dead-letter,
  lease loss, log redaction), 6 reconciler tests, 3 mock-adapter retention
  tests, and 3 configuration-validation tests.
- The Phase 9 integration suite passed (13 tests) against real loopback
  PostgreSQL and MinIO: a canceled session losing every object in all three
  roots, the redacted tombstone, the surviving audit and money, three repeat
  cleanups, a failure resuming from its checkpoint, a dead-lettered run, an
  aborted multipart upload, an object the ledger never knew about, `410` on
  both document routes, the two database triggers, and orphan reconciliation
  skipping a live session.
- `db:verify-phase9-upgrade` passed against a temporary database built from the
  Phase 0–8 migrations.

### Decisions made during implementation

1. **The print job is redacted, not deleted.** Phase 8 anticipated retention
   removing a print lineage whole, and the foreign keys allow it. But the job
   row is also the only place that records what the device reported for a
   `RECOVERY_REQUIRED` result, and retention reaches it fifteen minutes later —
   possibly before an operator does. Replacing the manifest's per-document
   digests with a count removes the fingerprint without removing the evidence,
   at the cost of one narrow amendment to Phase 8's immutability trigger.
2. **Multipart uploads are listed unfiltered and matched locally.**
   `ListMultipartUploads` prefix filtering is not portable: MinIO returns
   nothing for a prefix that plainly has uploads under it. A sweep that
   silently finds none of them is worse than one extra pass, and only uploads
   currently in flight are ever listed. All of a session's prefixes are matched
   in a single scan.
3. **Retention runs in the worker, not the API.** Deletion is background work
   with its own lease and its own retry budget, and the credential that may
   delete every storage root belongs to one process rather than to every
   request-serving replica. The API's existing file janitor still owns the
   per-file lifecycle that customer deletions and processing failures drive,
   but both workflows now honor the same per-file retention deadline so the
   janitor cannot cut through a session's receipt or recovery grace.
4. **The agent's watchdog is local, not commanded.** The plan sketches a signed
   delete command from the control plane. For the mock device the local
   age-based sweep is both sufficient and strictly safer: the cutoff is derived
   from the job's own deadline, past which no redelivery is possible, and it
   still runs on a kiosk that cannot reach the cloud — which is exactly when a
   command would not arrive. A commanded delete becomes necessary when a real
   device retains output the agent does not own.

## Known boundaries before commercial distribution

- There is no operator interface for a dead-lettered cleanup run and no
  alerting beyond an error log line. The run is visible in `cleanup_runs` with
  its checkpoint, attempt count and last error code; nothing pages anybody.
- The kiosk agent's local spool is a mode-0600 file deleted immediately after
  the print, and device output is deleted on a timer. Neither is encrypted at
  rest, so the plan's session-key crypto-erasure for local caches is still
  outstanding — this phase bounds how long a plaintext copy exists rather than
  making its remnants unreadable.
- Nothing here promises block-level erasure. Deleting an object removes it from
  the store and its versions; what an SSD's controller retains underneath is
  outside the application's reach and is a hardware and vendor question.
- `mobile_clients` rows keep their peppered cookie and nonce digests. They are
  digests of server-issued random values rather than customer data, and the
  columns are unique and non-null, so they are revoked rather than scrubbed.
- The storage reconciler scans a bounded number of pages per root and retains
  an in-memory continuation cursor between passes. It advances the cursor only
  after classification and deletion succeed, so a failed pass retries the same
  range. A backlog drains over several passes. A process restart loses that
  cursor and begins at the root; a durable cursor is recommended before
  operating at large bucket scale.
- Cleanup leases are compared on every database checkpoint, so an expired
  owner cannot finalize a newer owner's run, but long object-store operations
  do not renew the lease. They can therefore duplicate idempotent deletion work
  under sustained storage latency. Lease renewal is recommended before raising
  the prototype's object-count limits.
- Per-session cleanup explicitly removes non-current object versions and delete
  markers. Orphan discovery starts from the current-object listing, so a
  production bucket that enables versioning also needs non-current-version and
  expired-delete-marker lifecycle rules as an independent backstop.
- The retained settings/print manifest hashes are commercial evidence, but a
  party that already knows a candidate document and the canonicalization rules
  may still use hashes for correlation. Whether that evidence is legally
  necessary, and for how long, requires the Phase 11/12 privacy and accounting
  decision rather than an automatic schema change here.
- The settings-digest upgrade uses a set-based update over terminal revisions.
  It is atomic and fail-closed, but a production table much larger than the
  pilot fixture needs deployment-window and lock-duration monitoring.
- Retention has no admin-triggered path. There is deliberately no public
  scheduler endpoint; an authenticated manual cleanup belongs with the Phase 11
  admin surface.

## Post-implementation audit — 2026-08-06

The focused Phase 9 audit found and corrected defects that the original happy
path did not expose:

- settled and recovery file rows now inherit the session's configured grace;
  the API janitor can no longer delete them on its next 15-second pass;
- an upload reservation carries a cleanup barrier, refreshed immediately
  before object I/O, so cancellation or expiry cannot sweep the prefix and then
  have an already-authorized PUT recreate the document behind it;
- cleanup-run claims, deferrals and failures update their session mirror in the
  same transaction, and a stale lease cannot report a false success;
- known ledger keys are checked against the owning session prefix before any
  delete is issued;
- the storage reconciler rotates through later listing pages without an
  unbounded full-bucket scan, shares one timeout across the bounded scan, and
  does not acknowledge a page until its downstream work succeeds;
- manifest/settings redaction is guarded on insert and update, historical
  terminal rows are backfilled, and terminal print outcome evidence is final;
  database compatibility triggers also preserve these rules while older
  workers or API replicas are still draining during a rolling deployment;
- configured retention policy now reaches dispatcher-driven timeout and lease
  exhaustion settlements;
- a transient print API outage stays recoverable on the kiosk with the stable
  print idempotency key; only an observed terminal job can claim refund or
  scheduled deletion and hand the screen to the next customer; deterministic
  4xx refusals retain the paid session and stop on an operator-only screen
  instead of entering a futile retry loop;
- completion no longer depends on a redundant network cancellation, and all
  three kiosk locales describe deletion as scheduled rather than already done;
- local spool/output sweeps ignore only `ENOENT`; permission, path and I/O
  failures now reach retention warning logs;
- the shared state machine treats `FAILED` as terminal, and CI again runs both
  Phase 8 and Phase 9 real upgrade verifiers.
