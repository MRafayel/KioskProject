# Phase 8 status

- Date: 2026-08-03
- Status: complete for the pilot/prototype acceptance boundary
- Scope: an immutable print job built from a capture, a durable command a kiosk
  leases over its own outbound connection, a simulated printer that writes
  files, and a settlement that never claims more than the device could prove

"Complete" here means the local pilot is integrated, migration-safe, and
covered by automated gates. It does not mean the commercial items under
[Known boundaries before commercial distribution](#known-boundaries-before-commercial-distribution)
are done. No real printer is driven in this phase, and no customer filename
ever reaches a path, a log, or an event.

## What Phase 8 adds

1. `POST /v1/sessions/:sessionId/print-jobs` turns a capture into one print
   job. The request names the payment and nothing else: there is no field for
   documents, copies or page ranges, so a browser cannot ask for something
   other than what it paid for.
2. The job is built from the settings revision that capture was bound to, and a
   database trigger re-checks it on every insert. A job whose payment is not
   `CAPTURED`, is not applied to its own session, or does not match that
   payment's quote, settings revision and manifest hash cannot be stored at
   all, whatever application code believes.
3. A session prints once. A unique index over `print_jobs(session_id)` means a
   reload, a retried fetch or a fresh idempotency key all return the job that
   already exists rather than producing a second output.
4. The job manifest is immutable. Triggers refuse to rewrite the session, the
   payment, the settings revision, the manifest, the counts, the deadline or the
   creation time of a stored job, and refuse to move a settled one at all.
5. Nothing prints in an HTTP handler. The route writes a `QUEUED` job and the
   `print.started` event in one transaction; the worker's dispatcher turns that
   row into exactly one `agent_commands` row, and the kiosk agent leases it.
6. The queue is a wake-up, not a guarantee. Every step is guarded on the
   database row it read, so a duplicate delivery, a lost job or a restart
   produces the same single command rather than a second print.
7. The kiosk opens no inbound port. It claims work at
   `POST /v1/agent/commands/claim`, holds a lease, reports progress and a
   result, and reads print-ready documents only for the job it currently holds.
8. A submission is never blindly retried. The operation identifier is stable
   across redeliveries; the agent writes its intent to a local ledger before it
   touches the device; and a redelivered operation is resolved by asking the
   device what it already did, never by submitting again.
9. Acceptance by a queue is not proof that paper emerged. Every result carries
   a confidence, and only `COMPLETED` with `CONFIRMED` is a success. Anything
   the device could not confirm becomes `RECOVERY_REQUIRED` for a person to
   settle.
10. A capture that bought nothing owes money back. A definite failure — an
    offline device, a job that never reached one, a cancellation before
    submission — writes a `refunds` row with reason `PRINT_FAILED`, once per
    payment. An ambiguous result deliberately writes nothing.
11. `print.started`, `print.failed` and `print.recovery_required` are durable
    outbox events with the same sequencing, replay and redaction rules as
    Phase 4. Payloads carry a job identifier, a closed failure code and a
    confidence, and nothing else.
12. The touchscreen no longer simulates printing locally. It asks the control
    plane to print what the capture paid for and then displays only the status
    the control plane reports.

Phase 8 does not add real printer hardware, operator-driven reprints, refund
execution, partial page recovery, or multi-document collation across files.

## Request path

```text
Kiosk touchscreen
   |  (loopback only; no device credential in browser JavaScript)
   v
Kiosk agent facade  --- Bearer device credential --->  API
   |                                                     |
   |  POST /v1/sessions/:id/print-jobs  (Idempotency-Key, payment only)
   |  GET  /v1/print-jobs/:id
   |  POST /v1/print-jobs/:id/cancel    (Idempotency-Key)
   |                                                     |
Kiosk agent print runner                                 |
   |  POST /v1/agent/commands/claim      (outbound only) |
   |  POST /v1/agent/commands/:op/progress               |
   |  POST /v1/agent/commands/:op/result                 |
   |  GET  /v1/agent/print-jobs/:id/documents/:documentId |
   v                                                     |
packages/printer-adapters (MockPrinterAdapter)           |
   |                                                     |
var/mock-printer/output/<operationId>/          worker dispatch-print job
                                                         |
                              PostgreSQL: print_jobs, print_job_events,
                              agent_commands, refunds, outbox_events,
                              audit_events
```

The adapter performs no network input or output and knows nothing about
sessions, money or customers. It is handed an operation identifier, a manifest
and local file paths, and answers with a state and a confidence.

## Print model

```text
                create              dispatch            claim + submit
PAID ---------------> QUEUED -------------> DISPATCHED -----------------> PRINTING
                        |                       |                            |
                        |                       |            confirmed       v
                        |                       |            completion   COMPLETED  -> session COMPLETED
                        |                       |
                        +-----------------------+---> FAILED             -> session FAILED  + refund
                        |                       |     (device proved
                        |                       |      nothing printed)
                        |                       |
                        +-----------------------+---> RECOVERY_REQUIRED  -> session RECOVERY_REQUIRED
                                                      (device could not
                                                       say; no refund)
                        |
                        +---> CANCELED (before the device saw it) -> session FAILED + refund
```

Every terminal state is final. A retry is not offered: `FAILED` and
`RECOVERY_REQUIRED` end the print workflow, the documents are scheduled for
deletion, and any money owed back is already recorded. Both states are terminal
for the session too, so the kiosk is free to serve the next customer.

The settlement table is a pure function in `packages/domain/src/print-job.ts`,
so the API's cancel path, the agent result path and the worker's deadline sweep
cannot disagree about what a device result means.

## Public API additions

```text
POST /v1/sessions/:sessionId/print-jobs      print-jobs:create
GET  /v1/print-jobs/:printJobId              print-jobs:read
POST /v1/print-jobs/:printJobId/cancel       print-jobs:write
POST /v1/agent/commands/claim                print-jobs:agent
POST /v1/agent/commands/:operationId/progress    print-jobs:agent
POST /v1/agent/commands/:operationId/result      print-jobs:agent
GET  /v1/agent/print-jobs/:id/documents/:documentId   print-jobs:agent + lease
```

The first three require the owning kiosk credential; a foreign kiosk receives
`404` so a job's existence is never disclosed. Both mutations require an
`Idempotency-Key`. Errors use `409` for a session that has not been paid, for a
job that already exists under another payment, and for cancelling a completed
print, `410` for a session that has ended, and `404` for anything a caller does
not own. Every response is `no-store`.

The agent operations are not customer routes. They need the device credential
and a separate `print-jobs:agent` scope, so a compromised touchscreen
credential could not impersonate the device. Reading a print-ready document
additionally requires a live lease on that exact job: the manifest is the
allowlist, and a document identifier that is not in it cannot be read.

The development kiosk credential gains `print-jobs:create`, `print-jobs:read`,
`print-jobs:write` and `print-jobs:agent`. Re-run `pnpm db:seed` after
migrating: an existing credential without those scopes receives `403`.

## Database additions

- `print_jobs` — the immutable job: session, kiosk, quote, payment, settings
  revision, the manifest and its hash, the counts, the window, the status and
  the confidence. Triggers enforce that it was paid for, that its snapshot is
  never rewritten, and that its status only ever moves forwards.
- `print_job_events` — the append-only operation ledger. An `UPDATE` trigger
  rejects in-place edits; one row records that work was handed over before any
  row records what came back.
- `agent_commands` — durable work for a kiosk, unique per print job and per
  operation identifier, with a lease and a claim token. Its body cannot be
  rewritten after it is issued, and a settled command is final.

Every table is new and every foreign key is additive: a session written before
this migration simply has no print job. Deletion stays governed by the foreign
keys so Phase 9 retention can remove a print lineage whole — while the capture
it printed stays in the payment ledger.

## Configuration

```text
PRINTER_ADAPTER=mock
PRINTER_MOCK_OUTPUT_DIR=var/mock-printer/output
PRINTER_SPOOL_DIR=.tmp/kiosk-agent-spool
PRINT_JOB_TIMEOUT_SECONDS=300        # must not outlive the absolute session window
PRINT_COMMAND_LEASE_SECONDS=120      # must be shorter than the job timeout
PRINT_COMMAND_MAX_ATTEMPTS=2
PRINT_DISPATCH_MAX_ATTEMPTS=5
PRINT_TEST_OUTCOMES_ENABLED=true     # refused outright in production
```

Configuration validation refuses a production environment that enables the
device scenario control, a lease that could outlive the job it belongs to, and
a job that could outlive its own session. The API and the kiosk agent each
check the flag again before accepting a scenario, so a mistaken environment
still cannot expose a way to fail a paid print on request.

The local object-storage policy for the API credential now also permits
`s3:GetObject` on `normalized/v1/*`. That is the only path by which a kiosk may
fetch what it is printing; the API still cannot write there, and the worker
still cannot read quarantine.

## Run locally

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Open `http://127.0.0.1:5173`. Upload a document from the phone, save settings,
take a price, pay, and watch it print. The checkout screen's outcome control
chooses which deterministic device scenario the simulated printer will produce,
including the two failure paths. Output appears under
`var/mock-printer/output/<operationId>/`. Use only synthetic documents during
development.

The Phase 7 development command `pnpm db:recover-paid-session` has been
removed. It existed only because nothing owned print fulfilment; a paid session
now reaches a terminal state through the real print path.

## Acceptance gate

Phase 8 is accepted only when all of these pass against the applied migrations
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
```

`pnpm db:verify-phase8-upgrade` builds an isolated temporary database, applies
Phase 0–7, inserts a session that has already been paid, applies Phase 8, and
then proves in SQL that the existing session and capture are untouched, that a
print job requires a capture applied to its own session, that it must print
exactly what was paid for, that a session prints once, that the snapshot and
the deadline cannot be rewritten, that an impossible sheet count is refused,
that a settled job cannot be reopened or walked backwards, that one command
exists per job and its body is immutable, that a claim without a lease is
refused, that the ledger is append-only, and that removing a print lineage
leaves the payment ledger intact.

### Verified evidence — 2026-08-03

- Formatting, lint, type-check, and build passed across every workspace
  package, including the new `@printing-kiosk/printer-adapters`.
- Unit and service suites passed (452 tests): 15 new adapter tests covering
  every deterministic scenario, an operation identifier that is not a plain
  identifier, an artifact that does not match its manifest, and the difference
  between a live result and one reconstructed from the output directory; 10
  settlement-reducer tests covering the whole confidence table; 8 print
  dispatcher tests covering a duplicate queue delivery, a reused command, a
  redeliverable lease, an exhausted lease, a deadline with and without a
  handover, and a settled job; 8 agent runner tests covering a redelivered
  operation that is never resubmitted, a tampered manifest hash, a document
  whose digest does not match, an ambiguous adapter failure, and the removal of
  the local spool copy; new API route tests for authentication, the agent scope
  and the scenario field; new configuration tests; and a publisher test proving
  an operator note is dropped from a published print event.
- The full integration suite passed (89 tests across 6 files) against real
  loopback PostgreSQL, Redis, MinIO, ClamAV, the authenticated document
  processor, BullMQ, the API, the worker dispatcher and the kiosk agent. The 13
  Phase 8 scenarios drive the real Phase 3–7 path to a paid session and then
  cover the happy print, one job per session, an unpaid refusal, cross-kiosk
  isolation, a duplicate queue delivery, a definite failure with its refund, an
  unconfirmed result with no refund, a partial jam, a redelivery that prints
  nothing a second time, cancellation before and after the device saw the job,
  lease-scoped artifact access with path traversal and manifest-allowlist
  refusals, a deadline reached without a device answer, and the immutable
  snapshot with its append-only ledger.
- The deterministic browser gate passed 14 kiosk scenarios at both supported
  pilot resolutions, including a journey that now runs configure → checkout →
  pay → print → receipt and asserts that the print request named the capture
  and nothing else.
- `db:verify-phase8-upgrade` passed against a temporary database built from the
  Phase 0–7 migrations.
- The production dependency audit reported no known vulnerabilities at
  `moderate` or higher, and Compose validation passed.

### Post-implementation audit — 2026-08-04

- The agent now distinguishes artifact preparation from device submission,
  stops immediately when a progress/lease acknowledgement is refused, and
  classifies all failures before the adapter call as definite non-submission.
- Cancellation, exhausted leases, and deadlines use the accepted submission
  boundary rather than a command claim to decide between a refund obligation
  and operator recovery. Contradictory device results fail validation, and the
  settlement reducer remains defensive if it is called outside the API.
- Lease deadlines, result consistency, print replay redaction, immutable job
  provenance, and immutable command deadlines are enforced in PostgreSQL as
  well as application code. The clean Phase 7 → Phase 8 upgrade verifier covers
  the added constraints.
- A paid or printing kiosk workflow survives a browser refresh using a minimal
  session-only record. It deliberately excludes the QR bearer URL and customer
  filenames and validates every restored identifier and snapshot.
- Final validation passed: 464 unit/component/service tests, 92 integration
  tests across 6 files, 17 Playwright scenarios, formatting, lint, type-check,
  production builds, Compose validation, and a dependency audit with no known
  vulnerabilities.

#### Three decisions made during implementation

1. **A failed print is not retried, and that is what makes the refund rule
   honest.** An earlier draft allowed `FAILED → PRINTING` so a customer could
   try again. That produced a contradiction: a refund obligation written at the
   failure would be wrong the moment a retry succeeded, and one written later
   would need a status the `refunds` table does not have. Phase 8 therefore
   ends the print workflow at its first terminal state. A definite failure owes
   the money back immediately, an ambiguous one waits for a person, and a
   reprint becomes an operator action a later phase can add deliberately.
2. **The device is asked, not just the local ledger.** The agent's own record
   is enough to survive a crash, but not a wiped spool directory. Every
   redelivery therefore carries a flag, and the agent resolves it by querying
   the device — whose output directory survives an agent reinstall — before it
   is willing to submit anything.
3. **An adapter failure is recognised by validated shape as well as by class.** An adapter
   loaded through a second module instance — a test harness importing the
   package source while the agent imports its build — would otherwise turn a
   refusal the device is certain about into an ambiguous result nobody can
   settle. The cross-module check requires the adapter error name, a known code,
   and a boolean ambiguity marker before it accepts the error as trusted.

## Known boundaries before commercial distribution

- No real printer is driven. `MockPrinterAdapter` writes files; a Windows
  spooler, IPP or vendor-SDK adapter must replace it behind the same contract,
  and its result-confidence reporting is the part that needs the most care.
- The mock's "output" is the normalized print-ready PDF copied per document.
  Real page imposition, collation across documents, and duplex sheet accounting
  are the device's job and are only simulated here.
- Refunds are recorded, not executed. A `PRINT_FAILED` row is an obligation for
  an operator; nothing drives it to a provider, and there is no interface for
  reviewing them. This is the same boundary Phase 7 left open.
- There is no operator interface for a `RECOVERY_REQUIRED` job and no alerting
  on one. The audit trail records it and the kiosk asks the customer to find
  somebody; a fleet console is a later phase.
- A reprint after a failure is not possible without an operator relaxing the
  one-job-per-session index. That is deliberate for the pilot.
- The kiosk agent's local spool is a mode-0600 file deleted immediately after
  the print. It is not encrypted at rest, and the plan's session-key
  crypto-erasure for local caches is still outstanding.
- The agent claims work by polling. A fleet larger than a pilot should move to
  the authenticated Socket.IO connection that already exists for events.
- Phase 9 must include `print_jobs`, `print_job_events` and `agent_commands` in
  the retention schedule, and must clean the mock printer's output directory and
  the agent spool alongside the object store.
