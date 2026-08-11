# Admin control plane — Phase 4 status

Admin tools. The control plane can cost money for the first time, and this
document is mostly about the distance kept between that and everything else.

Phase 4's gate, from `ADMIN_PHASE_0.md` §22: **reason plus before/after audited,
and the refund path structurally separate from the Operator observation path.**
The separation is not a code convention. It is a different service, a different
connection pool and a different PostgreSQL role, and each half is refused the
other's work by the database rather than by a check.

The four decisions §7 of the Phase 3 document said had to be made first were
taken by the owner before any code was written. Each one is recorded in §1 with
what it cost.

---

## 1. What was implemented

### 1.1 The refund role — `printing_kiosk_admin_refund_writer`

**Decision 1 — how a refund authorization reaches the money tables.** A fourth
PostgreSQL role, holding INSERT on three tables and no UPDATE or DELETE
anywhere.

|            |                                                    |
| ---------- | -------------------------------------------------- |
| may INSERT | `refunds`, `refund_authorizations`, `audit_events` |
| may SELECT | 10 tables, 3 of them column-restricted             |
| may UPDATE | nothing                                            |
| may DELETE | nothing                                            |

The alternative was a grant bolted onto `printing_kiosk_admin_writer`, and it
was rejected for the reason Phase 3 §1.1 gives: that role is _defined_ by
holding nothing on money, so widening it would have discarded the property the
previous phase was built to establish. Instead the question keeps a one-line
answer, with a longer subject:

> Which connection can create an obligation to pay a customer?
> `printing_kiosk_admin_refund_writer`, and only it.

Three absences in that shape are load-bearing, and each is asserted at boot by
[`assertAdminRefundClientIsAppendOnly`](../packages/database/src/index.ts) and
again by `pnpm db:admin-refund-writer verify`:

- **It cannot settle a refund, only raise one.** No UPDATE on `refunds`, so the
  panel cannot mark a payout complete, attach a provider reference, or close one
  that was never honoured. Settlement belongs to an executor holding a provider
  credential; no part of the control plane holds one, and there is no provider
  client in the module.
- **It cannot touch a payment.** So it cannot invent the capture it is refunding
  against, or move the amount that bounds it.
- **It cannot record an observation.** No INSERT on
  `print_job_recovery_resolutions` or on the corrections beside it — the
  connection that can pay somebody cannot manufacture the evidence that a payout
  was justified.

`printing_kiosk_admin_writer` is unchanged in that direction and still holds
nothing on `refunds`. The two halves of the phase gate are two grant lists.

### 1.2 `refund.authorize` — turning an observation into an obligation (R2)

`POST /v1/admin/print-jobs/:printJobId/refund-authorization`

Admin and Technical Admin only, in [refunds.ts](../services/api/src/modules/admin/refunds.ts)
and [refund-routes.ts](../services/api/src/modules/admin/refund-routes.ts) —
separate files from the four actions that cannot cost anything, because a
separation living in one file's control flow is not one.

It records an obligation at `PENDING`. It does not pay anybody, and the response
says so through a Zod literal (`settled: false`) in the same way Phase 3's
resolution response carries `refundAuthorized: false`.

Enforced on every call:

- **The money is computed server-side.** The currency comes from the capture,
  never from the request. The ceiling is what the capture actually took less
  everything already owed on it, from every reason combined — including a
  compensation the payment path raised on its own — re-read inside the writing
  transaction because a webhook can raise one at any moment.
- **The amount is the one number a person supplies.** How much a half-finished
  print owes is a judgement, and an amount the system insisted on would be an
  amount nobody took responsibility for. The UI suggests one; the server bounds
  it. `suggestedRefundMinor` is a shared pure function so the screen and the
  server cannot disagree about what the suggestion means.
- **It must cite evidence.** The effective account of the print — the newest
  correction, or the original observation — must exist and must not say
  `DELIVERED`. A refund authorized against no observation at all is an Admin
  deciding alone that a customer is owed money, which is exactly what splitting
  these two capabilities exists to prevent.
- **Idempotent per print job**, by a unique index rather than a record with a
  TTL, for the reasons Phase 3 §4.1 gives. An identical repeat replays; a
  different amount is a 409.
- **Step-up WebAuthn assertion** required (R2), and its own rate limits, an
  order of magnitude below the operator action limits.
- **Full before/after audit**, including what was captured and what was already
  owed, so the row can be read years later without joining to rows that moved on.
- **404, never 403**, for a job the caller may not see.

The reason code written into `refunds.reason` is `OPERATOR_REQUESTED` — taken
from the vocabulary Phase 7 closed rather than added to it. That list already
reserved a value for a person deciding, and the distinction from `PRINT_FAILED`
matters: the print path raises a `PRINT_FAILED` refund automatically for a job
that settled as failed, so an authorization can never collide with, or be
mistaken for, one of those.

### 1.3 `print.recovery.correct` — putting a mistaken account right (R2)

`POST /v1/admin/print-jobs/:printJobId/recovery-correction`

**Decision 2 — the correction path**, closing Phase 3 §4.3 gap 1.

A new capability, held by Admin and Technical Admin and deliberately **not** by
the Operator role that records observations. It appends a row that supersedes
the earlier account; the original stays exactly as written, and the panel shows
the whole chain. Somebody who could edit their own account of a paid print could
launder a failure into a success.

`supersedesId` names the record the corrector was looking at, and the column is
UNIQUE. That is the entire concurrency story: two people correcting the same
record both name the same predecessor, and the second is refused by the database
rather than silently becoming the truth. Correcting a record that has already
been superseded is a 409 telling the person to reload.

A correction does not withdraw a refund somebody already authorized. It changes
what the queue says is owed; undoing a decision about money is a different act
and does not exist (§4.3).

### 1.4 `document.retention.retry` — asking the worker to try again (R1)

`POST /v1/admin/retention/retry`

A dead-lettered cleanup run means a customer's documents are still in object
storage after this system promised they would be gone, and the only thing
holding the line is a storage lifecycle rule meant to be a backstop. Somebody
must be able to say "the object store is back" without waiting for an approval,
so this is R1 and needs no step-up.

It **appends a request; it does not re-arm anything.** The control plane holds no
privilege on `cleanup_runs` — it may read six columns and write none — so the
worker re-arms its own run. That is what keeps "retry the cleanup" from being a
way to reach into retention state and change something else, and it is why the
response carries `rearmed: false`.

Nothing marks a request as consumed and nothing needs to: the request is unique
per _dead-lettering_, so re-arming makes it stop matching, and a run that fails
its way back to dead-lettered carries a new timestamp and needs a new decision.

### 1.5 Retention learns that a recovery was answered

**Decision 3**, closing Phase 3 §4.3 gap 3.

The worker reads the observation. No signal table, no new grant, and nothing the
control plane writes to make it happen: the resolution already exists and the
retention runner already has the authority, so a mechanism that needs neither is
one that cannot be pointed at the wrong session.

`SessionCleanupRunner.shortenResolvedRecoveryGrace` lets a `RECOVERY_REQUIRED`
session down to the settled grace measured from the moment a person answered,
and never later than the deadline it already had — this only ever shortens. Files
still being written keep their own barriers: `UPLOADING` and `VALIDATING` rows
protect an in-flight PUT that may outlive a resolution recorded seconds after the
session ended, and pulling those forward could let a sweep run underneath a write
this system has already authorized.

### 1.6 The migration owner role — `printing_kiosk_migrator`

**Decision 4**, closing Phase 2's and Phase 3's §4.3 gap 4.

`audit_events` has been append-only since Phase 2, enforced by triggers that
refuse UPDATE and DELETE. The triggers work. The hole was one level up: the
application role _owned_ the table, and an owner can
`ALTER TABLE ... DISABLE TRIGGER ALL` and then rewrite whatever it likes — so
every REVOKE aimed at that role was ineffective, because an owner's rights come
from ownership rather than from a grant.

`pnpm db:admin-owner provision` moves ownership of `audit_events` and the six
`admin_*` identity tables to a role only migrations use, and leaves the
application with exactly the DML it needs: INSERT and SELECT on the audit log,
ordinary CRUD on the admin tables it manages. What it loses is the ability to
drop those tables, alter them, or switch off the triggers that enforce their
invariants.

`verify` checks the ownership, the application's remaining privileges, and that
no trigger on an owned table is disabled. It also checks the thing that decides
whether any of it means anything: **whether the application role is a
superuser**, because a superuser bypasses every privilege check there is. In the
development compose file it is — the application connects as the cluster's
bootstrap superuser — so `verify` reports that as a failure rather than assuming
it away. See §4.3.

### 1.7 Schema

One migration,
[20260811020000_admin_phase4_money_and_corrections](../packages/database/prisma/migrations/20260811020000_admin_phase4_money_and_corrections/migration.sql),
adding three tables and three triggers on `refunds`. Every table is append-only
by trigger, with `ON DELETE RESTRICT` to the job, the session and the acting
account, exactly like the Phase 3 resolution table.

- **`print_job_recovery_corrections`** — `UNIQUE (supersedes_id)` is the
  concurrency boundary. A trigger acts as the foreign key `supersedes_id` cannot
  be (it names a row in one of two tables): the superseded record must be this
  job's own resolution or a correction already made to this job, so a correction
  cannot be attached to another print's evidence.
- **`refund_authorizations`** — `UNIQUE (refund_id)` and `UNIQUE (print_job_id)`.
  A trigger pins every denormalized column to the obligation it explains and
  refuses an authorization that cites an observation belonging to another print.
- **`cleanup_retry_requests`** — `UNIQUE (cleanup_run_id, dead_lettered_at)`. A
  trigger refuses a request for a run that has not given up and pins the failure
  it answers, so the unique index cannot be defeated with a made-up timestamp.

The three triggers on `refunds` are the ones worth reading twice:

1. `refunds_admin_reason` — the refund role may write `OPERATOR_REQUESTED` and
   nothing else. This matters more than it looks:
   `payments_assert_capture_disposition` reads `refunds` for a `LATE_CAPTURE`
   row when it decides whether a capture fulfilled its session, so a control
   plane free to choose the reason code would be one that could reach into that
   decision.
2. `refunds_recovery_bounds` — applied to the reason code rather than to the
   role, so it holds for anything that ever writes one: not more than the
   capture less what is already owed, not in another currency, not against a
   payment that never captured.
3. `refunds_authorization_recorded` — a **deferred** constraint trigger. A
   refund carrying the human reason code cannot survive COMMIT without a row
   naming who authorized it. Deferred because the two rows are written in one
   transaction and the obligation must go first; at COMMIT there is no ordering
   left to excuse a missing row, so "who authorized this payout" is guaranteed
   an answer.

No other table was changed and no existing trigger was touched.

### 1.8 Read side

- **The refund queue** (`GET /v1/admin/refund-queue`) — the prints waiting for a
  money decision, oldest first, each stating what was captured, what is already
  owed and therefore the most that may still be authorized. It closes Phase 3
  §4.3 gap 2: `UNRESOLVABLE` appears here as its own reason rather than dropping
  off every list, because "nobody could tell" is a decision for somebody with
  more authority, not a closed case. A print leaves the queue when a refund is
  authorized against it, or when somebody corrects the record to say the pages
  were delivered.
- **The correction chain** on the print job detail, oldest first, both versions
  readable.
- **Who authorized a refund** on the obligations list. Null for one the payment
  path raised on its own: "the system noticed" and "a named person decided" are
  different claims on the same ledger and the screen does not merge them.

### 1.9 UI

- A queue panel leading the money section, because it is the only thing on that
  page anybody has to act on. It does not poll, deliberately: an Admin part-way
  through typing an amount must not have the row underneath them replaced.
- An authorization form stating the arithmetic and, in as many words, that it
  records an obligation and does not pay anybody.
- A correction form on the print job detail, written as an append rather than an
  edit: it says the record above stays as written, and that it does not withdraw
  a refund already authorized.
- A retry control in the retention panel, on dead-lettered runs only, reporting
  what actually happened — a request was recorded, and the worker will pick it up.

---

## 2. New dependencies

**None.** Phase 4 adds no runtime and no development dependency. The new
external artifacts are two PostgreSQL roles.

---

## 3. Verification

```
pnpm run lint             25/25 tasks
pnpm run typecheck        25/25 tasks
pnpm run test             25/25 tasks
pnpm run format:check     clean
pnpm run test:integration 237/237
pnpm db:admin-reader verify         privilege matrix verified
pnpm db:admin-writer verify         four INSERTs, no UPDATE, no DELETE
pnpm db:admin-refund-writer verify  three INSERTs, no UPDATE, no DELETE
pnpm db:admin-owner verify          see §4.3 — fails by design in development
```

`tests/integration/admin-money.test.ts` is 25 tests and runs **the whole API
through the least-privilege refund role**, so these are statements about the
deployed shape. It proves, among other things:

- The observation connection is refused by PostgreSQL (`42501`) when it tries to
  insert a refund or an authorization; the money connection is refused when it
  tries to record an observation or a correction, settle or delete a refund,
  create or alter a payment, alter a print job, or rewrite the audit log.
- An Operator is refused the money route, and **the refusal is recorded** —
  see §4.2.
- A refund is created at `PENDING` with the capture's own currency, its
  authorization beside it, and an audit row carrying the reason, the amount,
  what was captured, what was already owed, and `NONE → PENDING`.
- The payment, the print job and its result confidence are untouched afterwards.
- More than the capture is refused, and so is more than the capture _less a
  compensation the payment path raised_ — the queue and the server agree on the
  same ceiling.
- A refund against no observation, or against one saying `DELIVERED`, is refused.
- A `OPERATOR_REQUESTED` refund with no authorization row is rejected **at
  COMMIT** by the deferred trigger, written on the application connection which
  holds every grant — so the guarantee does not rest on the order this
  repository's code happens to insert in.
- An Operator cannot correct an observation; an Admin can; the original is
  unchanged; a second correction of an already-superseded record is a 409; and
  the corrected print leaves the refund queue.
- A retry request cannot be made for a run that has not given up, cannot invent
  a dead-lettering, and does not change the run.

The four worker tests added to `cleanup-session.test.ts` cover the other half of
retention: a re-arm happens only when a request matches the current
dead-lettering, and the grace shortens only for files nobody is still writing to.

---

## 4. Security review

### What this phase closes

- **Phase 3 §4.3 item 1 — a mistaken observation cannot be corrected.** Closed by
  §1.3, as an explicit higher-authority action recorded as its own fact.
- **Phase 3 §4.3 item 2 — `UNRESOLVABLE` reaches no worklist.** Closed by §1.8.
- **Phase 3 §4.3 item 3 — resolving does not shorten the retention grace.**
  Closed by §1.5, without granting the write role UPDATE on `print_sessions`.
- **Phase 3 §4.3 item 4 / Phase 2 §7 — `audit_events` write privileges.** Closed
  by §1.6 for deployments where the application is not a superuser; see §4.3.
- **T13 stays closed.** An Operator still cannot cause a payout, now for two
  reasons rather than one: the capability check and the grant list.

### 4.1 Deviations from the plan, stated deliberately

**The refund reason code.** Phase 0 did not name one. `OPERATOR_REQUESTED` was
taken from the vocabulary Phase 7 already closed rather than adding a fifth
value. The name says "operator" in the operational sense while the capability is
Admin and above — mildly misleading read cold, and preferred anyway to widening
a deliberately closed money vocabulary. Who actually decided is on the
authorization row beside it.

**`authorizeAdmin` gained an optional refusal hook.** Capability refusals are
not audited anywhere in the control plane, and mostly should not be: a role that
cannot see a screen is refused its endpoints all day. The money route is the
exception, so `authorizeAdmin` takes an optional callback and only that route
passes one. It is a hook rather than a rule so the choice stays visible at the
route that made it. Failures inside it are swallowed: the request is refused
either way, and a 500 would tell a prober they hit something.

**The provisioning CLIs were refactored, not duplicated.**
`admin-writer.mjs` and `admin-refund-writer.mjs` are thin wrappers over a shared
`admin-append-role.mjs`, so "no UPDATE anywhere in the database" is asserted by
one implementation. Both roles were verified before and after the refactor.

### 4.2 Defects found and fixed in existing code

Two, both found by writing the tests:

1. **The refund role could not write the audit row it is required to write.**
   Its matrix granted INSERT on `audit_events` but no SELECT, and the client
   issues `INSERT ... RETURNING`, so every authorization failed with `42501`
   after the obligation had been prepared. Caught because the test asserts the
   endpoint's success path against the real role rather than the application
   one. The grant list now says why the SELECT is there.
2. **The audit metadata allow-list silently dropped every new key.**
   `sanitizeMetadata` is a closed write allow-list — deliberately, so a new
   field has to be considered — and Phase 4's money vocabulary was not in it. An
   authorization would have been recorded with its reason and no amount. The
   list now names each new key with what it is for.

A third was avoided rather than fixed: `PRINT_FAILED` was the obvious reason
code for an authorized refund and is already written automatically by the print
path for a job that settled as failed. Using it would have made a person's
decision indistinguishable from the system's own compensation and collided with
it under `UNIQUE (payment_id, reason)`.

One test was corrected: an existing App test read the overview's attention list
in the same tick as the shell heading, which is a race it can lose under load.

### 4.3 Known gaps

1. **Ownership separation is ineffective in development, and `verify` says so.**
   The compose file runs the application as the cluster's bootstrap superuser, so
   it can retake ownership and disable any trigger regardless of §1.6. `pnpm
db:admin-owner verify` therefore fails in development by design, naming that
   as the reason. **Production must run the application as an ordinary role**;
   until it does, this phase's audit-integrity work is decorative there too.
2. **The control plane's own evidence tables are still application-owned.**
   `print_job_recovery_resolutions` and the three tables added here keep their
   append-only triggers, but the application role could still disable them. They
   were left out of the ownership transfer on purpose: the integration teardown
   owns the resolutions table specifically so it can suspend those triggers, and
   moving them is a decision with its own consequences rather than a side effect
   of this one.
3. **A correction cannot withdraw an authorized refund.** Correcting an
   observation after money was authorized changes the record and leaves the
   obligation standing. The authorization keeps the outcome it was made against,
   so the discrepancy is visible rather than silent, but reversing a payout
   decision is an R3-shaped act and belongs with Phase 5's approval workflow.
4. **Two transactions writing different reason codes against one payment can
   together exceed the capture.** Each passes the bounds trigger alone. The panel
   cannot cause it — `UNIQUE (payment_id, reason)` permits it exactly one
   authorized refund per payment — and the result is a visible over-obligation
   in the ledger rather than a silent one. A constraint that ruled it out would
   need to serialize against the payment row.
5. **Nothing settles a refund.** As before this phase: obligations accumulate at
   `PENDING` and an executor that talks to the payment provider does not exist
   yet. Phase 4 makes that visible — the queue and the obligations list both
   distinguish raised from settled — but it does not fix it.
6. **The refund queue's page can be short.** Filtering to the effective outcome
   happens after the page is fetched, so a page containing corrected-to-delivered
   prints returns fewer than 50 rows. The totals are exact; only the page length
   varies.
7. **The overview cache is per process** (carried from Phase 2).

### Deliberately absent

No settlement of any kind, no operator or authenticator management, no approval
workflow — those are Phases 4B and 5. And still: no SQL console, no shell, no
arbitrary query builder, no printer command console, no queue or Redis console,
no environment browser, no secrets viewer, no document download, no preview, no
storage URL, no kiosk credential surface.

---

## 5. Printing performance impact

Nothing on the print path changed. The refund pool is separate, capped at two
connections, cancels its own statements after two seconds and gives up a lock
contest after one, exactly as the write pool does. It cannot take a connection
the print path needs and cannot hold a lock against it.

An authorization is one short transaction that reads five rows by primary key,
aggregates the refunds of one payment, and inserts three rows.

The retention runner does two more statements per pass, both against indexed
columns and both no-ops when there is nothing to do. It runs every 30 seconds in
the worker, not in the API.

---

## 6. Setup

A development environment needs the two new roles provisioned once:

```
ADMIN_REFUND_DATABASE_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  pnpm db:admin-refund-writer provision
pnpm db:admin-refund-writer verify

ADMIN_OWNER_DATABASE_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  pnpm db:admin-owner provision
```

Then set `ADMIN_REFUND_DATABASE_URL` and `ADMIN_OWNER_DATABASE_URL` in `.env` to
those roles and passwords.

**The ownership transfer invalidates the other three roles' grants**, because
they were issued by the previous owner. `provision` says so; re-run
`provision` and `verify` for the reader, the writer and the refund writer
immediately afterwards.

**A migration that alters `audit_events` or an `admin_*` table must now run as
the owner role**: `pnpm db:migrate:owner`. Migrations touching only product
tables are unaffected.

Development may leave `ADMIN_REFUND_DATABASE_URL` unset, in which case the
refund route is not registered at all and the API logs why — a safe failure
rather than a silently unprotected one. Production requires it and requires it to
differ from every other connection string.

**Re-run `provision` and `verify` for all three least-privilege roles after every
migration.** A new table is denied by default for the reader and forbidden by
default for both writers. That is the behaviour we want, but only if somebody
notices — `verify` is what notices, and it did during this phase.

---

## 7. What remains

Phase 4's people half — Operator and authenticator management — was split out
rather than dropped. It is UPDATE-shaped work (suspend, resume, revoke a
credential, revoke a session) where everything above is append-only, so it wants
its own role with column-level UPDATE grants and its own review. Nothing in this
phase blocks it.

Before it starts:

1. **Decide whether the people role follows the same shape** — a fifth role
   holding column-level UPDATE on `admin_users.status`, `admin_authenticators`
   and `admin_sessions`, and nothing on any product table. The precedent set
   here says each new power gets its own narrow role.
2. **Decide how an Operator enrols a credential they do not yet have.** An Admin
   cannot enrol somebody else's authenticator: WebAuthn requires the person and
   the device. That means an invitation flow, which is new surface.
3. **Confirm the production database role is not a superuser** (§4.3 item 1).
   Until that is true, this phase's audit-integrity work does not hold there.

Phase 5 (Technical Admin + the R3 approval workflow) is unblocked and inherits
two shapes from this phase: the supersede record, and the deferred trigger that
makes a row's justification a condition of its existence.
