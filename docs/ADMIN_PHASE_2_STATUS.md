# Admin Control Plane — Phase 2: read-only observability

Status: implemented to the Phase 2 acceptance boundary. The control plane can
now see the printing system. It cannot change any part of it, and that is
asserted three separate ways rather than promised once.

Phase 1 built a human identity and a server-side answer to "may this person do
this". Phase 2 is the first time that identity is pointed at production data,
so almost all of the work below is about bounding what it can reach.

---

## 1. What was implemented

### The control plane's own database role

The largest change is not a feature. `printing_kiosk_admin_reader` is a
PostgreSQL role that holds `SELECT` on 21 tables — ten of them
column-restricted — and nothing else. The admin API connects as it.

That role cannot read a customer's filename, a content digest, a storage object
key, a print manifest, a settings selection blob, a session-event payload, an
agent-command payload, a kiosk credential digest, an admin session digest, a
break-glass digest, an authenticator public key, or a stored idempotency
response. Not "does not", **cannot**: there is no grant, and the query fails at
the database.

The policy lives as data in
`packages/database/scripts/admin-reader-matrix.mjs` and is applied and checked
by `packages/database/scripts/admin-reader.mjs`:

```
ADMIN_READ_DATABASE_PASSWORD=... pnpm db:admin-reader provision
pnpm db:admin-reader verify
```

`verify` fails when a table exists that the policy does not mention, so a
migration that adds one cannot quietly inherit a grant — a new table is denied
until somebody decides otherwise, and `verify` is what makes them decide. It
also fails if the role holds any write privilege, if a column-restricted table
has become readable in full, or if the role's settings have drifted.

### Read-only by connection, not by convention

The admin pool is opened with `default_transaction_read_only=on`,
`statement_timeout=5s`, `lock_timeout=2s` and
`idle_in_transaction_session_timeout=10s` in the startup packet, and with at
most four connections. So:

- a write fails with PostgreSQL error `25006` regardless of what the code asks
  for, including in a development environment that has not provisioned the role;
- a slow dashboard query is cancelled by the database rather than left to
  compete with a paid print job for connections and locks;
- the panel cannot exhaust the pool the print path depends on.

`assertAdminReadClientIsReadOnly` runs at boot and refuses to serve the control
plane if the setting did not take effect — a driver upgrade that silently
stopped forwarding it would otherwise leave every read working and the
guarantee gone.

### Read-only by type

`services/api/src/modules/admin/read-database.ts` exposes only
`findMany`/`findFirst`/`findUnique`/`count`/`groupBy`, on only the models the
dashboard needs. `database.printSession.update(...)` in an admin read path is a
compile error. This is the layer that survives into Phase 3, where the
temptation to reach for the pool already in scope will be strongest.

### The reads

Thirteen endpoints, all `GET`, each naming one capability:

| Endpoint                           | Capability                   | Answers                                            |
| ---------------------------------- | ---------------------------- | -------------------------------------------------- |
| `/v1/admin/overview`               | `dashboard.read`             | What needs a person, and what the system is doing  |
| `/v1/admin/kiosks`                 | `kiosk.read`                 | Which kiosks are alive and what each is doing      |
| `/v1/admin/sessions`               | `session.read`               | Sessions, filterable by kiosk and state            |
| `/v1/admin/sessions/:id`           | `session.read`               | One session: settings, money, document totals      |
| `/v1/admin/sessions/:id/timeline`  | `session.timeline.read`      | The workflow in order, with durations              |
| `/v1/admin/sessions/:id/documents` | `document.metadata.read`     | Upload metadata. Never contents                    |
| `/v1/admin/print-jobs`             | `print.read`                 | Jobs, with overdue flagged                         |
| `/v1/admin/print-jobs/:id`         | `print.read` (+ diagnostics) | One job; the device ledger for Technical Admins    |
| `/v1/admin/payments`               | `payment.read`               | Payment state; provider reference gated separately |
| `/v1/admin/refunds`                | `refund.obligation.read`     | Money owed back, and for how long                  |
| `/v1/admin/retention`              | `document.retention.read`    | Whether documents were actually destroyed          |
| `/v1/admin/errors`                 | `error.read`                 | Failures grouped by subsystem and code             |
| `/v1/admin/audit`                  | `audit.read` / `.self`       | The append-only log                                |

Two role differences change the _content_ of a response rather than access to
it, and are a second `hasCapability` check inside the handler so the shape of
the answer stays one thing:

- **`print.diagnostics.read`** — the device ledger. Everyone who may see a job
  sees whether it printed; only a Technical Admin sees every attempt that got
  it there.
- **`payment.reconcile.read`** — the provider's own intent identifier. It is
  what makes a row reconcilable against the provider's ledger, so it is the
  reconciliation capability rather than part of "this session was paid for".

### Operator kiosk scoping, finally enforced

`admin_kiosk_scopes` was stored and reported in Phase 1 but bounded no query.
It now bounds every one. An Operator sees their assigned kiosks and nothing
else — lists, detail pages, overview counts, error groups and the audit log.
An Operator with no assignment sees nothing at all, which is the safe default
for a newly created account.

A record outside the caller's scope is a **404, never a 403**. A 403 confirms
that the identifier names something real, which is the entire mechanism of an
enumeration attack (T8). The same 404 is returned for a session that does not
exist, and both cases are covered by test.

### Kiosk liveness

`Kiosk.lastSeenAt` had a column and an index and was never written (Phase 0 §20
item 7), so "is that kiosk alive" — the first question an operator asks — had
no answer anywhere in the system. The throttled kiosk heartbeat in
`sessions/auth.ts` now writes it, riding on the existing once-a-minute throttle
so polls that did not already qualify for a write still cost nothing.

Liveness is classified as `ONLINE` / `DEGRADED` / `OFFLINE` / `NEVER_SEEN`.
"Never seen" is kept distinct from "offline" deliberately: one is a
provisioning problem and the other is an operational one, and collapsing them
sends somebody to look at the wrong thing.

### Bounded queries

- Keyset pagination on `(createdAt, id)` rather than `OFFSET`. Offset paging
  re-scans what it skips and drops rows when data changes between pages — for
  an incident list, the worst possible time to lose one.
- Fixed page size of 50, no client override.
- A malformed cursor is treated as the first page rather than an error, so a
  query-string value cannot become an injection point or an error oracle.
- The overview is cached per scope for five seconds, so a wall of open
  dashboards costs one query rather than one per person per poll.
- Errors are grouped rather than listed: thirty rows of the same code from one
  kiosk is one problem, and a list makes it look like thirty.
- Every aggregate rides an index this schema already had.

### Document privacy, stated three times

The rule is that an administrator sees operational metadata and never document
contents. It is enforced at three independent layers, and a leak needs all
three to be wrong:

1. **The reader role's grants.** The column does not come back.
2. **The response schemas** in `packages/admin-access/src/observability.ts`.
   Every operational response is parsed through a closed shape before it is
   sent. There is no passthrough field and no `metadata: unknown`.
3. **Explicit `select` clauses** in every query, naming only granted columns.

The session timeline deserves its own note: the stored `SessionEvent.payload`
is not returned at all. Type and ordering answer what a timeline is for — what
order, how long between steps, where it stopped — and a JSON column whose
contents are decided by whatever writes it next has no place in a viewer. The
same reasoning removes `PrintJobEvent.detail` and `AgentCommand.payload`.

Audit metadata is the one place where stored JSON is displayed, so it passes
through a read-side allow-list. Keys that are withheld are **named** rather
than hidden, so an operator chasing an incident can tell "the system never
recorded that" from "this view will not show it".

### The admin UI

Nine sections behind a dark navigation rail, in the palette the owner asked
for: one warm accent on near-black and off-white, generous radii, numbers set
large and light.

The palette choice is also load-bearing. A single accent means the accent can
mean something, and here orange is spent only on "a person has to do
something" — so a screen with no orange on it is a screen with nothing waiting.
Colour never carries meaning alone: every badge, counter and worklist entry
says in words what its colour repeats.

The overview leads with a worklist rather than a wall of numbers. Entries with
a count of zero are dropped, because a dashboard that always shows the same
eight rows is a dashboard nobody reads. Ranking is fixed in code and states a
product opinion: an undeleted document past its retention deadline outranks a
kiosk being offline.

Sections are hidden when the signed-in role lacks the capability behind them.
That is a courtesy, not a boundary — the server refuses regardless, and every
one of those refusals is covered by test.

Data refreshes by polling on a 15–30 second interval, never overlapping a
previous request and never while the tab is hidden. Phase 0 §17 chose this over
reusing the Socket.IO gateway: admin sockets would need a subscription path
into per-session event streams, which widens the surface for no operational
gain at this scale.

---

## 2. New dependencies

**None.** No package was added to any workspace in this phase. The one new
workspace edge is `@printing-kiosk/admin-access` → `@printing-kiosk/domain`, so
the admin session-state filter uses the same `SESSION_STATES` the state machine
defines instead of a copy that would drift.

---

## 3. Verification

| Check                         | Result                                            |
| ----------------------------- | ------------------------------------------------- |
| `pnpm lint`                   | clean                                             |
| `pnpm typecheck`              | clean                                             |
| `pnpm format:check`           | clean                                             |
| Unit tests                    | all packages green                                |
| `pnpm test:integration`       | green, twice consecutively                        |
| `pnpm db:admin-reader verify` | privilege matrix verified against live PostgreSQL |

The Phase 2 integration suite (`tests/integration/admin-observability.test.ts`,
29 tests) runs the **whole admin API through the least-privilege reader role**,
not through the application role. That is the part worth stating plainly: every
query in the observability service was proven compatible with a role that
cannot read a filename, because a single over-selected column would have failed
the run.

Direct probes against the reader role confirm the grants (`packages/database`,
run manually): `display_name`, `content_sha256`, `quarantine_object_key`,
`file_derivatives.object_key`, `print_jobs.job_manifest`,
`session_events.payload`, `agent_commands.payload`,
`print_setting_revisions.selections`, `kiosk_credentials.secret_digest`,
`admin_sessions.token_digest`, `admin_break_glass_credentials.secret_digest`,
`admin_authenticators.public_key`, `session_upload_grants.token_digest` and
`idempotency_records.response_body` all return `42501 permission denied`;
`UPDATE`, `INSERT` and `DELETE` all return `25006 read-only transaction`.

What the suite asserts:

- A canary planted in the filename, content digest, object key, print manifest
  and both event payloads appears in **no** response from **any** endpoint at
  the highest-privileged role.
- No route serves a document, a preview, a storage URL or a manifest — five
  plausible paths are probed and all 404.
- Every read path refuses `POST`, `PUT`, `PATCH` and `DELETE`.
- The read connection itself refuses a write.
- An Operator's kiosk assignment bounds lists, detail pages and overview counts;
  an out-of-scope record is a 404 indistinguishable from a missing one; an
  Operator with no assignment sees nothing.
- An Operator sees only their own audit history.
- An unrecognised audit metadata key is withheld and named.
- Pagination neither skips nor repeats a row; a malformed cursor is a first
  page, not an error.
- A filter value outside a closed vocabulary is rejected.

---

## 4. Security review

### What this phase closes

- **Phase 1 §9 item 1 — read-only database role.** Done, and further than
  planned: column-level restriction turns "the admin plane does not return
  document contents" from a code property into a database property.
- **Phase 1 §9 item 2 — `Kiosk.lastSeenAt`.** Written, and liveness derived
  from it.
- **Phase 1 §9 item 3 — Operator scoping unenforced.** Enforced everywhere.
- **T6 (dashboard queries degrade printing).** Separate small pool, database
  timeouts, keyset pagination, grouped aggregates, cached overview.
- **T8 (IDOR across kiosks and sessions).** Scope filters in the query, 404 for
  out-of-scope identifiers.

### Known gaps

1. **`audit_events` write privileges are still held by the application role.**
   The append-only trigger is the real control and it works; the `REVOKE` that
   would add defence in depth is ineffective while the application role owns the
   tables, because an owner always holds every privilege on what it owns. Fixing
   this properly means a separate owner role for migrations, which is a
   deployment change rather than a code change.
2. **The error centre cannot name a kiosk for four subsystems.** Upload,
   payment, retention and event-publishing failures hang off a session rather
   than a device, and grouping through the relation would cost more than the
   answer is worth. The scope filter still traverses it, so an Operator sees
   only their own kiosks' failures — the group simply cannot label one.
3. **The overview cache is per process.** With more than one API instance,
   two operators can see counts up to five seconds apart from each other. This
   is correct for the stated priority (printing beats dashboard freshness) and
   worth revisiting only if the panel is ever used for coordination.
4. **No rate limit per account, only per address.** A stolen session behind the
   same address as legitimate operators shares their bucket. Session-keyed
   limiting needs the limiter to run after authentication, which is a change to
   the shared throttle.
5. **`publicId` is returned in session lists.** It is a path component of the
   phone handoff URL and grants nothing without the upload token, but it is one
   more identifier in a response than is strictly needed.

### Deliberately absent

No SQL console, no shell, no arbitrary query builder, no printer command
console, no queue or Redis console, no environment browser, no secrets viewer,
no document download, no preview, no storage URL, no kiosk credential surface —
consistent with Phase 0 §14 and the original brief. There is also no admin-side
S3 client anywhere in the process: the control plane holds no object-storage
credential at all, which is the cleanest possible guarantee that it cannot
serve document bytes.

---

## 5. Printing performance impact

Two writes and one pool were added to the hot path's neighbourhood:

- The kiosk heartbeat now writes `kiosks.last_seen_at` **only when** the
  existing credential heartbeat also wrote, so a polling kiosk pays one extra
  indexed `UPDATE` per minute and nothing on the polls in between.
- The admin read pool is separate, capped at four connections, and cancels its
  own queries after five seconds. It cannot take a connection the print path
  needs, and it cannot hold a lock for longer than two seconds.

No print, payment, upload or retention path was otherwise changed.

---

## 6. Setup

A development environment needs the reader role provisioned once:

```
ADMIN_READ_DATABASE_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  pnpm db:admin-reader provision
pnpm db:admin-reader verify
```

Then set `ADMIN_READ_DATABASE_URL` in `.env` to that role and password.
Development may leave it unset and share the application role; the connection
is still opened read-only, but the column restrictions do not exist to protect
anything. Production requires it and requires it to differ from `DATABASE_URL`.

**Re-run `provision` and `verify` after every migration.** A new table is denied
by default and a new column of a column-restricted table is invisible until it
is added to the matrix. That is the behaviour we want, but only if somebody
notices — `verify` is what notices.

---

## 7. What remains

Phase 3 (Operator tools) is unblocked. Before it starts:

1. **Decide the write-path pool.** Phase 3 introduces the first admin mutation
   (`print.recovery.resolve`). It must not use the read pool — which cannot
   write — and must not quietly get the application pool either. The
   authorization and audit story for that connection wants deciding before the
   first endpoint exists.
2. **Idempotency for admin actions.** `IdempotencyRecord` exists and is used by
   kiosk paths. An admin action that resolves a recovery needs the same
   treatment, keyed per job, per Phase 0 §14.1.
3. **Session-keyed rate limiting**, so a stolen session cannot spend an honest
   operator's allowance (gap 4 above).
4. **A separate migration owner role**, which is what makes the `audit_events`
   revoke meaningful (gap 1 above).

Not started, and correctly so: every mutation, the R3 approval workflow, and
any surface that could move money.
