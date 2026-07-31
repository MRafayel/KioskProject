# Phase 6 status

- Date: 2026-07-31
- Status: complete for the pilot/prototype acceptance boundary
- Scope: immutable print settings revisions, capability checks, and
  server-authoritative, reproducible price quotes

“Complete” here means the local pilot is integrated, migration-safe, and
covered by automated gates. It does not mean the commercial items under
[Known boundaries before commercial distribution](#known-boundaries-before-commercial-distribution)
are done. Phase 6 adds no payment: a quote is a promise about a price, and
nothing in this phase captures money.

## What Phase 6 adds

1. A validated document now moves the session on by itself. The worker
   transitions `WAITING_FOR_UPLOAD` to `FILES_UPLOADED` in the same
   transaction that marks a file `READY`, and removing the last validated
   document moves the session back.
2. `PUT /v1/sessions/:sessionId/settings` turns a customer's choices into one
   canonical, append-only revision: ordered documents, merged page ranges,
   copies, duplex, A4, orientation, and fit. Colour is not a
   parameter. Monochrome is written by the API, enforced by a database check
   constraint, and recorded in the manifest.
3. Page-range text is re-emitted canonically. `3,1-2,2-3` is stored as `1-3`,
   so two different keystrokes that mean the same pages produce the same
   revision, the same manifest hash, and the same price.
4. Every revision is checked against the kiosk capability snapshot and the
   deployment limits. A setting the device does not declare is refused with
   `422 UNSUPPORTED_PRINT_SETTING` rather than being silently downgraded.
5. `POST /v1/sessions/:sessionId/quotes` prices one exact revision from the
   published pricing rule set and stores the result. The request body has room
   for a settings revision and nothing else, so a browser cannot propose an
   amount; a request carrying one is refused as malformed.
6. Money is integer minor units plus a currency and its exponent, end to end.
   Percentages are integer basis points, every division states its rounding
   mode, and the database re-checks that the stored breakdown reconstructs the
   stored total.
7. A quote binds a manifest hash over the ordered documents, their exact
   content digests, their processing revisions, and the settings. Before a
   price is issued, the manifest is recomputed from what the session holds now
   and compared; a replaced or reprocessed document cannot inherit an old
   price.
8. Pricing is invalidated automatically. Saving settings, adding or removing a
   validated document, cancelling, and expiry all retire the active quote in
   the same transaction, emit `quote.invalidated`, and release the session's
   active-quote pointer. A quote that reaches its deadline is reported as
   `EXPIRED` immediately and settled by the janitor.
9. `settings.updated`, `quote.created`, and `quote.invalidated` are durable
   outbox events with the same sequencing, replay, and redaction rules as
   Phase 4. Payloads carry no manifest hash, object key, document name, or
   parser detail.
10. The touchscreen no longer calculates money. It saves settings, requests a
    price, and displays only what the control plane answered. “Review and pay”
    stays disabled until a live quote exists, and the checkout screen refuses
    to render at all without one.
11. A published pricing rule set is immutable in the database. Triggers refuse
    every rule write against a published tariff — insert, update and delete
    alike — and refuse an in-place edit of the set itself or of any settings
    revision. Publication is therefore ordered: draft the set, write its rules,
    then publish. Corrections publish a new version.

Phase 6 does not add payment, refunds, printing, promotions, multi-currency
pricing, or per-site tariffs.

## Request path

```text
Kiosk touchscreen
   |  (loopback only; no device credential in browser JavaScript)
   v
Kiosk agent facade  --- Bearer device credential --->  API
   |                                                     |
   |  PUT  /v1/sessions/:id/settings   (If-Match, Idempotency-Key)
   |  POST /v1/sessions/:id/quotes     (Idempotency-Key, revision only)
   |  GET  /v1/sessions/:id/settings | /print-capabilities | /quotes/:quoteId
   v                                                     v
                             packages/domain/print-settings   (pure)
                             packages/pricing                 (pure)
                                                              |
                                       PostgreSQL: print_setting_revisions,
                                       price_quotes, pricing_rule_sets,
                                       pricing_rules, outbox_events, audit
```

Both calculation packages are pure functions with no clock, randomness, or
input/output. The API supplies validated inputs and stores the result; the same
inputs and the same pricing version always produce the same quote.

## Pricing model

For each document in a revision:

```text
selectedPages       = pages in the canonical ranges
printedSidesPerCopy = selectedPages
printedSides        = sum(printedSidesPerCopy) * copies
physicalSheets      = simplex ? printedSides
                             : sum(ceil(printedSidesPerCopy / 2)) * copies
```

Each document starts on a fresh sheet, so files never share paper. Duplex
changes sheets, not inked sides, and the tariff charges by printed side:

```text
print      = printedSides * unitAmountMinor
adjusted   = max(print + duplexAdjustment + serviceFee, 0)
subtotal   = max(adjusted, minimumAmountMinor)        # BEFORE_TAX rule sets
tax        = round(subtotal * taxBasisPoints / 10000) # stated rounding mode
total      = subtotal + tax
```

`AFTER_TAX` rule sets apply the minimum to the gross amount instead. Both
placements are supported, stored, and constraint-checked.

The seeded development tariff is a placeholder for local work, not a price
list: AMD with exponent 2, 50.00 per printed side, no service fee, no minimum
transaction, 20% tax, rounded half up. **A local accountant must validate the
rate, the rounding point, and receipt rules before real sales.**

The minimum is a published rule field, not a hard-coded floor. A zero minimum
means every job pays exactly what its sides cost; the arithmetic, the storage,
and the `BEFORE_TAX` / `AFTER_TAX` placement stay in place so a deployment that
wants a floor sets `minimumAmountMinor` on its rule and nothing else changes.
The checkout screen shows the minimum line only when a floor actually moved the
price.

## State and invalidation rules

```text
WAITING_FOR_UPLOAD --first document READY--> FILES_UPLOADED
        ^                                        |
        |                                   settings saved
   last validated                                v
   document removed  <---- settings reset ---  CONFIGURING
                                                 |
                                          quote created (Phase 6 ends here;
                                          Phase 7 locks AWAITING_PAYMENT)
```

- A settings revision is append-only. Editing settings writes revision _n+1_;
  it never rewrites revision _n_.
- At most one quote per session is `ACTIVE`, enforced by a partial unique
  index rather than by application code alone.
- A quote is created only while the session is `CONFIGURING`, no document is
  still processing, the requested revision is the session's current one, and
  the recomputed manifest matches the revision's stored hash.
- Requesting a price for settings that have not changed, while the previous
  quote is still live, returns that quote instead of issuing a second one.
- A quote never outlives the session: its deadline is the earlier of
  `QUOTE_TTL_SECONDS` and the session's idle and hard expiry.
- Retrying with the same idempotency key replays the stored result. Asking for
  a genuinely new price after one expires uses a new key.

## Public API additions

```text
PUT  /v1/sessions/:sessionId/settings            settings:write
GET  /v1/sessions/:sessionId/settings            sessions:read
GET  /v1/sessions/:sessionId/print-capabilities  sessions:read
POST /v1/sessions/:sessionId/quotes              quotes:create
GET  /v1/sessions/:sessionId/quotes/:quoteId     quotes:read
```

All five require the owning kiosk credential; a foreign kiosk receives `404`
so a session's existence is never disclosed. `PUT` requires both `If-Match`
and `Idempotency-Key`; `POST /quotes` requires `Idempotency-Key`. Errors use
`409` for state and staleness, `412` for a stale version, `422` for a domain
or capability refusal, `423` once payment has locked the manifest, and `503`
when no tariff is published. Every response is `no-store`.

The development kiosk credential gains `settings:write`, `quotes:create`, and
`quotes:read`. Re-run `pnpm db:seed` after migrating: an existing credential
without those scopes receives `403` on the new routes.

## Database additions

- `print_setting_revisions` — append-only revisions keyed by session and
  revision number, with the canonical selections, counts, capability version,
  and manifest hash. An `UPDATE` trigger rejects in-place edits.
- `pricing_rule_sets` and `pricing_rules` — versioned tariffs. A partial
  unique index permits one published rule set per `(scope, scope_ref)` pair,
  and a check constraint keeps a `GLOBAL` set's `scope_ref` empty so the global
  tariff the API looks up is unambiguous. Triggers refuse to edit a published
  set, and refuse to insert, update or delete any of its rules.
- `price_quotes` — the stored breakdown, expiry, status, and invalidation
  reason, with a check constraint that reconstructs the total from the parts
  and a partial unique index allowing one `ACTIVE` quote per session.
- `print_sessions` gains `current_settings_revision` and `active_quote_id`.
  Both are `NULL` for every session created before this migration, so the
  change is additive.

## Configuration

```text
MAX_COPIES=20            # ceiling, further limited by the device snapshot
MAX_SELECTED_PAGES=200   # cannot exceed MAX_DOCUMENT_PAGES × MAX_FILES_PER_SESSION
MAX_PRINTED_SIDES=1000   # must cover one copy of the largest allowed selection
QUOTE_TTL_SECONDS=300    # must not outlive the idle session window
```

These are enforced by configuration validation at startup, by the domain
package, and by database check constraints.

## Run locally

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Open `http://127.0.0.1:5173`. Upload a document from the phone, wait for
validation, and the configuration screen will save settings and display a
server-calculated total. Use only synthetic documents during development.

## Acceptance gate

Phase 6 is accepted only when all of these pass against the applied migrations
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
pnpm db:verify-phase6-upgrade
```

`pnpm db:verify-phase6-upgrade` builds an isolated temporary database, applies
Phase 0–5, inserts a session that already holds a validated document, applies
Phase 6, and then proves in SQL that the pre-existing session keeps neutral
defaults, that a settings revision cannot be edited, that a colour revision is
impossible, that a published tariff and its rules cannot be changed, that an
inconsistent quote cannot be stored, and that a second active quote cannot be
created.

`.github/workflows/phase5.yml` is now `.github/workflows/acceptance.yml`, since
it runs the whole repository gate rather than one phase's. Its first remote run
is still unverified; that must be green before merging or deploying from
GitHub.

### Verified evidence — 2026-07-31

- Formatting, lint, type-check, and build passed across all 20 workspace
  packages.
- Unit and service suites passed, including 12 new domain settings tests with
  fast-check page-range and sheet-arithmetic properties, 16 pricing tests with
  integer-money and monotonicity properties, 6 capability-snapshot tests, and
  new API, kiosk-agent, kiosk model, and kiosk journey tests.
- The full integration suite passed (56 tests across 4 files) against real
  loopback PostgreSQL, Redis, MinIO, ClamAV, the authenticated document
  processor, BullMQ, the API, and the janitor. The 13 Phase 6 scenarios drive
  the real Phase 3–5 path to a validated three-page document and then cover
  canonical ranges, duplex pricing, a tariff with no minimum,
  idempotent replay and key reuse, a key reused under a version the request no
  longer names, quote invalidation on settings and document
  change, stale versions, capability and bounds refusals, an unusable printer
  snapshot reported as a device fault, a request carrying a
  browser-supplied total, cross-kiosk isolation, expiry and re-quoting, and
  the database immutability triggers including a rule insert against a
  published tariff.
- The deterministic browser gate passed 14 kiosk scenarios at both supported
  pilot resolutions, including a configure-to-checkout journey that asserts
  the displayed total comes from the server and that no kiosk request contains
  an amount.
- `db:verify-phase6-upgrade` passed against a temporary database built from the
  Phase 0–5 migrations.
- The whole system was driven live, not only through test harnesses: the
  development stack was started with `pnpm dev:kiosk`, and a script created a
  session through the loopback agent, joined it as a phone, uploaded a real
  three-page PDF, waited for the real worker and processor to validate it, then
  saved settings and took a price through the agent facade over HTTP. All 23
  checks passed, including canonical page ranges, the exact tariff total, a
  refused browser-supplied amount, quote invalidation, and a gapless realtime
  event sequence carrying no manifest hash or object key.
- A real browser then drove the touchscreen against that same live stack with
  no network stubbing: the phone's upload appeared without a reload, the kiosk
  saved settings, and the screen displayed the server's total, which the
  checkout screen offered unchanged. All 10 checks passed, including that no
  request the kiosk sent contained an amount.

#### Three defects found by that verification and fixed

1. **Concurrent saves returned 500 instead of 412.** Two settings writes
   arriving together made PostgreSQL raise a serialization failure on the
   session row lock, which Prisma surfaces as `P2010` rather than `P2034`. The
   Phase 2 session service already knew this; the new modules had copied the
   simpler classification from the files module and did not. Only one revision
   was ever created, so no data was wrong, but the loser saw a server error
   instead of the documented version conflict. The judgement now lives once in
   `services/api/src/modules/sessions/transactions.ts`, used by the session,
   settings, and quote modules, and an integration test drives two simultaneous
   saves and asserts exactly one `200` and one `412`.
2. **Every configuration session paid a wasted round-trip.** Validating a
   document advances the session version, so the kiosk's first save always sent
   a stale `If-Match`, was refused, re-read the version, and saved again. The
   configuration screen now reads the authoritative version when it opens; the
   retry inside the save remains the correctness guarantee. Measured in the live
   browser run: two settings requests before, one after.
3. **The kiosk never released its stored replay keys.** `clearStoredPricingKeys`
   was written but never called, so a browser that stays open for months would
   accumulate one `sessionStorage` entry per settings change. It is now part of
   the session key cleanup that already runs when a session ends.

The settings and quote rate limits were also raised from 60 to 120 per minute.
The touchscreen debounces to at most one save every 400 ms, so a customer who
keeps adjusting settings for a full minute can legitimately produce about two
saves a second; the old ceiling would have refused ordinary configuring. Forty
consecutive saves were accepted with none throttled.

- The production dependency audit reported no known vulnerabilities at
  `moderate` or higher, and Compose validation passed.

#### One pre-existing flake, unrelated to this phase

`tests/integration/sessions.test.ts` occasionally fails its Phase 3 deletion
assertion with `expected 202 to be 204`: the object delete inside
`FileService.removeAs` intermittently throws, so the request reports the
deletion as accepted rather than completed. The file still reaches `DELETED`
through the cleanup path, and the kiosk treats both statuses as success, so
there is no data or customer-visible defect — but the gate is not reliably
green on repeated runs.

This was measured, not assumed: with all Phase 6 work stashed, the same
assertion failed once in eight consecutive runs of the same suite at the
pre-Phase-6 commit, with the identical message. A direct probe of
`S3ObjectStore.deleteObject` (60 put/delete cycles) produced no failures, so
the cause is in the deletion request path rather than the store itself. It
belongs to Phase 5's version-aware cleanup and should be diagnosed and fixed
there rather than folded into this phase.

## Known boundaries before commercial distribution

- The seeded tariff is a development placeholder. Tax rate, rounding point,
  whether tax is included, receipt content, and fiscal reporting must be
  reviewed by a local accountant before any real sale.
- Pricing scope is global. Per-site and per-kiosk tariffs, time-boxed validity
  windows, and promotions are modelled in the schema but not implemented; the
  current rule is one published rule set for the whole fleet.
- There is no administrative interface for publishing a tariff. A new version
  is created by a seed or a migration, which is acceptable for a pilot and not
  for a fleet.
- A quote is not yet consumed. Phase 7 must lock the manifest into
  `AWAITING_PAYMENT`, verify the amount and currency against the stored quote
  before any capture, and mark the quote `CONSUMED`.
- The validated deployment profile still keeps `MAX_FILES_PER_SESSION=1`. The
  settings contract, the domain package, and the pricing arithmetic all handle
  ordered multi-document jobs, and the API accepts them, but the touchscreen
  provides no reorder or per-document controls yet. Do not raise the limit
  until that workflow exists.
- Orientation and scaling are recorded and priced but not yet
  rendered: the preview still shows the canonical document page rather than a
  simulation of the imposed sheet. The monochrome preview remains an
  approximation until a real capability snapshot exists.
- The kiosk requests a fresh price when a quote expires while the customer is
  still configuring. It does not warn before that happens; a visible countdown
  should be added alongside the Phase 7 payment window.
- Settings and quote metadata are retained with the session. Phase 9 must
  include `print_setting_revisions` and `price_quotes` in the retention
  schedule, keeping the commercial snapshot while scrubbing anything that
  identifies a document.
