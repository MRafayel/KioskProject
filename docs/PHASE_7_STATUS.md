# Phase 7 status

- Date: 2026-08-02
- Status: complete for the pilot/prototype acceptance boundary
- Scope: a simulated payment provider, an auditable payment ledger, and a
  session that reaches `PAID` only through a verified capture

“Complete” here means the local pilot is integrated, migration-safe, and
covered by automated gates. It does not mean the commercial items under
[Known boundaries before commercial distribution](#known-boundaries-before-commercial-distribution)
are done. No real money moves anywhere in this phase, and no card data enters
this system at any point.

## What Phase 7 adds

1. `POST /v1/sessions/:sessionId/payments` turns a live quote into one payment
   and locks the session into `AWAITING_PAYMENT`. The request names the quote
   and nothing else: the body has no field for an amount, so a browser cannot
   propose what it would like to pay.
2. The amount is copied from the stored quote, and a database trigger re-checks
   it on every insert and update. A payment whose amount, currency, exponent,
   settings revision or manifest hash differs from its quote cannot be stored
   at all, whatever application code believes.
3. Capture happens only through a signed provider callback at
   `POST /v1/webhooks/payments/mock`. The signature is verified over the exact
   bytes received, with a timestamp tolerance and a constant-time comparison,
   before anything is read from the database. Confirmation never captures.
4. Every verified callback is written to `payment_webhook_inbox` before it is
   acted on, keyed by provider event ID. A duplicate delivery is acknowledged
   and does nothing a second time.
5. Payment state is monotonic and the database enforces it. A late decline
   cannot overwrite a capture, a declined payment can never later capture, and
   a partial unique index permits at most one captured payment per session and
   at most one payment in flight.
6. A capture that arrives too late — after cancellation, expiry, or a timeout —
   is still recorded as a capture, and a `refunds` row records the obligation
   to give the money back. Nothing is silently discarded, and no original
   payment record is ever rewritten.
7. A decline, cancellation or timeout releases the manifest lock: the session
   returns to `CONFIGURING` with its quote still `ACTIVE`, so the next attempt
   costs exactly the same.
8. The worker settles abandoned payments. Past its deadline a payment becomes
   `TIMED_OUT`, the session is released, and `payment.failed` is emitted. The
   reconciler never invents a capture: an intent the provider still reports as
   live is recorded for an operator instead of guessed at.
9. Cancelling a session closes an in-flight payment in the same transaction.
   Once money has been captured it is refused outright, as
   `409 PAYMENT_ALREADY_CAPTURED`.
10. `payment.pending`, `payment.succeeded` and `payment.failed` are durable
    outbox events with the same sequencing, replay and redaction rules as
    Phase 4. Payloads carry the amount the kiosk must display and nothing else:
    no provider intent, no card detail, no document identity.
11. The touchscreen no longer simulates payment locally. It asks the control
    plane to start one, confirms it, and then displays only the status the
    control plane reports. Printing begins on a capture and on nothing else.

Phase 7 does not add real payment hardware, refunds execution, print jobs,
partial capture, or multi-currency settlement.

### Recovering a mock-paid development session

Until Phase 8 owns print fulfilment, a successful mock payment can remain in
`PAID`. Do not cancel it or edit the payment row. Complete the simulated print
by listing the affected sessions and then using the exact UUID:

```bash
pnpm db:recover-paid-session -- --list
pnpm db:recover-paid-session -- <session-uuid>
```

The command refuses production, remote databases, non-mock providers,
non-`PAID` sessions, and sessions without exactly one captured mock payment. It
records `PAID -> PRINTING -> COMPLETED`, writes the audit/outbox evidence,
revokes upload access, and schedules the private files for cleanup.

## Request path

```text
Kiosk touchscreen
   |  (loopback only; no device credential in browser JavaScript)
   v
Kiosk agent facade  --- Bearer device credential --->  API
   |                                                     |
   |  POST /v1/sessions/:id/payments   (Idempotency-Key, quote only)
   |  POST /v1/payments/:id/confirm    (Idempotency-Key)
   |  GET  /v1/payments/:id
   v                                                     |
                                                         |
Payment provider  -- signed callback -->  POST /v1/webhooks/payments/mock
                                                         |
                            packages/payment-adapters    (deterministic, pure)
                                                         |
                              PostgreSQL: payments, payment_attempts,
                              payment_webhook_inbox, refunds, price_quotes,
                              outbox_events, audit_events
```

The adapter holds no state and performs no input or output. Every identifier it
returns is derived from the payment it was asked about, so the same call after
a crash and a retry produces the same answer.

## Payment model

```text
                 create                confirm            signed capture
CONFIGURING ---------------> AWAITING_PAYMENT ------------------------> PAID
     ^                              |
     |   decline / cancel / timeout |
     +------------------------------+

Payment: PENDING -> AUTHORIZED -> CAPTURED
              |          |
              +----------+--> DECLINED | CANCELED | TIMED_OUT
                                   |
                    late capture   +--> CAPTURED + refunds(LATE_CAPTURE)
```

A capture is effective only when the payment is still open, the session is
still `AWAITING_PAYMENT`, and the quote is still `ACTIVE` and unexpired. Any
other capture is compensation, not fulfilment.

The payment window is the earlier of `PAYMENT_TIMEOUT_SECONDS`, the quote's
deadline, and the session's idle and hard expiry. A window shorter than 30
seconds is refused with `422 QUOTE_EXPIRED` rather than offered to a customer
who cannot finish it.

## Public API additions

```text
POST /v1/sessions/:sessionId/payments   payments:create
POST /v1/payments/:paymentId/confirm    payments:write
GET  /v1/payments/:paymentId            payments:read
POST /v1/webhooks/payments/mock         provider signature only
POST /v1/test/payments/:id/outcomes     development only
```

The first three require the owning kiosk credential; a foreign kiosk receives
`404` so a payment's existence is never disclosed. Both mutations require an
`Idempotency-Key`. Errors use `409` for state, staleness and a payment already
in progress, `410` for an expired session, `422` for a price that cannot be
paid in time, and `503` when the provider is unavailable. Every response is
`no-store`.

The webhook route answers `401 INVALID_WEBHOOK_SIGNATURE` for anything it
cannot verify and says no more than that: which check failed is not something
an unauthenticated caller may probe. A verified callback that cannot be acted
on — an unknown intent, a wrong amount, a settled payment — is still answered
`200`, because a provider must not retry forever against a decision that will
not change.

The development kiosk credential gains `payments:create`, `payments:write`, and
`payments:read`. Re-run `pnpm db:seed` after migrating: an existing credential
without those scopes receives `403` on the new routes.

## Database additions

- `payments` — the accounting record: session, quote, provider intent, status,
  integer amount, currency, the settings revision and manifest hash it is
  paying for, and its window. Triggers enforce that it equals its quote exactly
  and that its status only ever moves forwards.
- `payment_attempts` — append-only provider interactions. An `UPDATE` trigger
  rejects in-place edits; only the idempotency key's digest is stored, never
  the key.
- `payment_webhook_inbox` — verified callbacks, unique per provider event ID,
  with the payload digest and what was decided. Its evidence fields cannot be
  rewritten.
- `refunds` — compensation records, unique per payment and reason, referencing
  their payment with `ON DELETE RESTRICT` so an obligation cannot be erased by
  deleting what it refers to.

Every table is new and every foreign key is additive: a session written before
this migration simply has no payments.

## Configuration

```text
PAYMENT_PROVIDER=mock
PAYMENT_WEBHOOK_SECRET=...        # ≥32 chars; distinct from every other key
PAYMENT_TIMEOUT_SECONDS=180       # must not exceed QUOTE_TTL_SECONDS
PAYMENT_WEBHOOK_TOLERANCE_SECONDS=300
PAYMENT_TEST_OUTCOMES_ENABLED=true   # refused outright in production
```

Configuration validation refuses a production environment that enables the
outcome-control route, that reuses another key as the webhook secret, or that
leaves a placeholder in it. The API and the kiosk agent each check the flag
again before registering their route, so a mistaken environment still cannot
expose a way to dictate payment outcomes.

## Run locally

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Open `http://127.0.0.1:5173`. Upload a document from the phone, save settings,
take a price, and press pay. The checkout screen's outcome control chooses
which deterministic provider scenario the simulated terminal will produce. Use
only synthetic documents during development.

## Acceptance gate

Phase 7 is accepted only when all of these pass against the applied migrations
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
pnpm db:verify-phase7-upgrade
```

`pnpm db:verify-phase7-upgrade` builds an isolated temporary database, applies
Phase 0–6, inserts a session that already holds a settings revision and a live
price, applies Phase 7, and then proves in SQL that the existing session and
quote are untouched, that a payment must equal its quote, that a payment cannot
borrow another session's price, that only one payment is open and only one
capture exists per session, that a capture is final and a decline cannot become
one, that a duplicate callback is refused and received evidence cannot be
rewritten, that a compensation record is written once per reason, and that a
capture owing money back cannot be deleted.

### Verified evidence — 2026-08-02

- Formatting, lint, type-check, and build passed across every workspace
  package, including the new `@printing-kiosk/payment-adapters`.
- Unit and service suites passed (387 tests): 13 new adapter tests covering
  deterministic intents, signature verification over raw bytes, a tampered
  body, a forged signature, a stale timestamp, an oversized body and a
  correctly signed non-payment event; 5 reconciler tests; new API route tests
  for authentication, callback verification before any database access, and the
  gating of the outcome control; new kiosk-agent facade tests; new
  configuration tests; and a publisher test proving a provider reference is
  dropped from a published payment event.
- The full integration suite passed (72 tests across 5 files) against real
  loopback PostgreSQL, Redis, MinIO, ClamAV, the authenticated document
  processor, BullMQ, the API, and the janitor. The 16 Phase 7 scenarios drive
  the real Phase 3–6 path to a validated, priced document and then cover the
  happy capture, idempotent replay and key reuse, duplicate delivery, a late
  decline after capture, an unsigned and a tampered callback, a wrong amount
  with its compensation record, a decline followed by a successful retry on the
  same price, the settings and quote locks, cancellation of an in-flight
  payment, a late capture after cancellation, a refusal to cancel a paid
  session, reconciliation of an abandoned payment, cross-kiosk isolation, a
  request carrying its own amount, a stale quote, a window too short to open,
  an unavailable provider, and three deliveries through the outcome control
  producing exactly one capture.
- The deterministic browser gate passed 14 kiosk scenarios at both supported
  pilot resolutions, including a journey that now runs configure → checkout →
  pay → printing and asserts that no request the kiosk sent contained an
  amount.
- `db:verify-phase7-upgrade` passed against a temporary database built from the
  Phase 0–6 migrations.
- The production dependency audit reported no known vulnerabilities at
  `moderate` or higher, and Compose validation passed.

#### Two decisions made during implementation

1. **Received evidence is immutable, not undeletable.** The first draft of the
   migration refused every `DELETE` on `payment_attempts` and
   `payment_webhook_inbox`. That also made a payment lineage impossible to
   remove through its own foreign keys, which would have put Phase 9's
   retention schedule at odds with the schema. The tables now refuse rewrites —
   the property that actually resists tampering — while deletion stays governed
   by the foreign keys, and a capture that owes money back is still held in
   place by `refunds ... ON DELETE RESTRICT`.
2. **A provider failure is recognised by name as well as by class.** An adapter
   loaded through a second module instance — a test harness importing the
   package source while the service imports its build — would otherwise turn a
   provider outage into an unhandled `500`. The check now accepts either, which
   matches how this repository already recognises driver-adapter errors.

## Known boundaries before commercial distribution

- No real payment provider is integrated, and no PCI obligations have been
  assessed. A certified terminal or hosted gateway, and written confirmation of
  the actual obligations from the acquirer, are prerequisites for real sales.
- The mock creates its intent inside the same transaction that writes the
  payment, which is safe only because it is deterministic and performs no
  input or output. A network provider must move to a two-step create — persist
  the payment, then call the provider, then record the intent — so a crash
  between the two is recoverable.
- Refunds are recorded, not executed. `refunds` rows are obligations for an
  operator; nothing drives them to a provider, and there is no interface for
  reviewing them.
- A payment whose intent the provider still reports as live after its deadline
  is left open with an operator-visible record until the session expires. There
  is no alerting on that state.
- Capture cannot be partial, and there is no multi-currency or per-site
  settlement.
- The touchscreen stands in for a payment terminal by asking the deterministic
  provider for an outcome. That route is development-only and must be replaced
  by a real terminal adapter before any public pilot.
- Phase 9 must include `payments`, `payment_attempts`, `payment_webhook_inbox`
  and `refunds` in the retention schedule, keeping the commercial and
  accounting record for as long as law and provider rules require while
  scrubbing anything that identifies a document.
- Phase 8 must create the print job from the capture through the transactional
  outbox, and must decide the refund policy for a job that fails after payment.
