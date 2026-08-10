# Admin control plane — Phase 3 status

Operator tools. The control plane can change something for the first time, and
this document is mostly about the boundaries of that.

Phase 3's gate, from `ADMIN_PHASE_0.md` §22: **an Operator cannot move money,
cannot act outside assigned kiosks, and cannot force a job into recovery.** All
three are enforced in more than one layer, and the outermost layer is a
PostgreSQL role rather than a code path.

---

## 1. What was implemented

### 1.1 The write role — `printing_kiosk_admin_writer`

The single most important thing in this phase is not a feature. It is a database
role that holds **INSERT on two tables and no UPDATE or DELETE on anything,
anywhere in the database.**

|            |                                                  |
| ---------- | ------------------------------------------------ |
| may INSERT | `print_job_recovery_resolutions`, `audit_events` |
| may SELECT | 8 tables, 6 of them column-restricted            |
| may UPDATE | nothing                                          |
| may DELETE | nothing                                          |

That shape is the acceptance gate expressed as a privilege:

- It holds nothing at all on `refunds`, `payments`, `payment_attempts` or
  `payment_webhook_inbox` — not even SELECT. **An Operator cannot cause a payout
  because the connection cannot reach the money.**
- It cannot UPDATE `print_jobs` or `print_sessions`, so nothing reachable from
  the panel can move a job into recovery, out of it, or into a success. What the
  device reported stays as reported.
- It cannot UPDATE or DELETE `audit_events` or the resolutions it writes, so it
  cannot erase its own tracks. Triggers refuse this too; the missing grant means
  the refusal does not depend on a trigger surviving.

The policy is data — [admin-writer-matrix.mjs](../packages/database/scripts/admin-writer-matrix.mjs) —
applied and checked by `pnpm db:admin-writer provision|verify`. `verify` asserts
the absence of every mutating privilege across **every table in the database**,
not just the ones the policy mentions, and fails on a table the policy has not
decided about. A future admin action that needs to change operational state has
to add a grant in a file whose diff says exactly what new power the control
plane gained.

There are now three connections with three different sets of grants: the
application pool, the Phase 2 read pool (read-only, column-restricted), and this
one. Production configuration requires all three to differ.

### 1.2 `print.recovery.resolve` — recording what a person saw (R2)

`POST /v1/admin/print-jobs/:printJobId/recovery-resolution`

`RECOVERY_REQUIRED` is the state this system was designed to hand to a human:
the device could not prove whether paper came out, and the domain deliberately
refuses to guess. This is where the human answer goes.

It is **a new fact, not an edit**. `print_jobs` records what the device
reported and triggers refuse to rewrite it, so the observation is stored beside
that record rather than over it — which is also why an operator can never turn
an ambiguous print into a success.

Four outcomes, a closed vocabulary mirrored by a check constraint:

| Outcome               | Money note        |
| --------------------- | ----------------- |
| `DELIVERED`           | none              |
| `PARTIALLY_DELIVERED` | `refundSuggested` |
| `NOT_DELIVERED`       | `refundSuggested` |
| `UNRESOLVABLE`        | none              |

`UNRESOLVABLE` is first-class on purpose. An operator who cannot tell must be
able to say so, because the alternative is that they guess, and a recorded guess
is worse than a recorded uncertainty. The UI gives it the same visual weight as
the other three.

`refundSuggested` is **derived from the outcome on the server** and pinned by a
check constraint, so a client cannot submit "delivered, and also refund it". It
is a note for whoever holds `refund.authorize` — a capability with no endpoint
in this phase. The response carries `refundAuthorized: false` as a Zod literal,
so no code path can produce a response claiming otherwise.

Enforced on every call:

- **Strict eligibility, revalidated inside the writing transaction.** The job's
  status, its session's state and its payment are all re-read at execution time,
  because a job settles asynchronously and the row that was `RECOVERY_REQUIRED`
  when the page rendered may not be.
- **Kiosk scoping re-read from the database**, not taken from the session. An
  assignment revoked after sign-in takes effect on the next action.
- **Mandatory reason**, 8–280 characters, validated at both layers.
- **Idempotent per print job**, by a unique index rather than a record with a
  TTL. An identical repeat replays; a contradictory one is a 409.
- **Step-up WebAuthn assertion** required (R2).
- **Full before/after audit**, including what the device said next to what the
  person said.
- **404, never 403**, for a job the caller may not see.

### 1.3 `incident.acknowledge` — saying somebody is on it (R1)

`POST /v1/admin/incidents/acknowledge`

The lowest-risk thing the panel can do: it changes no operational state and
exists so two operators do not both walk to the same kiosk.

It is stored as an audit event rather than as a row, because that is genuinely
all it is — a record that a named person saw something at a time. There is no
state to keep in sync, nothing to clear, and nothing to go stale: it ages out
with the window it was made in. The error centre annotates each group with the
most recent acknowledgement, plus `recurredSinceAcknowledgement`, which is the
case where "somebody is on it" stops being reassuring.

**The group is confirmed to exist before the event is written.** Without that,
this endpoint would be a way to write caller-chosen strings into a permanent,
append-only log that operators read back.

An Operator may only acknowledge a group that names a kiosk they are assigned
to. A group with no kiosk is a system-wide failure and acknowledging one is for
a role whose view is not scoped.

### 1.4 Schema

One table, `print_job_recovery_resolutions`
([migration](../packages/database/prisma/migrations/20260811010000_admin_phase3_recovery_resolutions/migration.sql)),
matching §21 item 6 of the Phase 0 plan. Its invariants live in the database:

- `UNIQUE (print_job_id)` — the idempotency boundary.
- A `BEFORE INSERT` trigger that reads the job's own status and **refuses any
  resolution for a job not in `RECOVERY_REQUIRED`**, and pins the denormalized
  session and kiosk to the job's own. Those two columns are what the read side
  scopes an Operator by, so a wrong value would be a way to see another kiosk's
  work.
- Append-only triggers: no UPDATE, no DELETE, no TRUNCATE, by anyone.
- Check constraints deriving `refund_suggested` from the outcome, requiring a
  reason of real length, and refusing a sheet count that contradicts the outcome.
- `ON DELETE RESTRICT` to the job, the session and the acting account.

No other table was changed, and no trigger on any other table was touched.

### 1.5 Read side

- `recoveryResolved` on every print job in the list, so "which of these still
  needs me" is answerable without opening each one.
- The full observation on the job detail, visible to everyone who can see the
  job.
- `printing.recoveryUnresolved` on the overview, and the `PRINT_RECOVERY_REQUIRED`
  worklist entry now counts **unresolved** jobs. Somebody who records what they
  saw has to watch the number they are working through go down, or they stop
  believing it.
- Acknowledgements on error groups.

### 1.6 UI

- A recovery form on the print job detail, gated on `print.recovery.resolve`,
  written to make the honest answer the easy one: outcomes as full sentences
  rather than codes, the device's own count shown alongside, and the consequence
  of each choice stated before the operator commits. It says in as many words
  that it does not refund anything.
- An inline acknowledgement control in the error centre.
- One `useAdminAction` hook behind both, handling step-up-and-retry,
  double-submit prevention, cross-tab identity confirmation, and reporting a 409
  as information rather than as a failure to retry past.

---

## 2. New dependencies

**None.** Phase 3 adds no runtime and no development dependency. The only new
external artifact is a PostgreSQL role.

---

## 3. Verification

```
pnpm run lint            25/25 tasks
pnpm run typecheck       25/25 tasks
pnpm run test            25/25 tasks
pnpm run format:check    clean
pnpm run test:integration 212/212, twice consecutively
pnpm db:admin-reader verify   privilege matrix verified
pnpm db:admin-writer verify   two INSERTs, no UPDATE, no DELETE
```

`tests/integration/admin-operations.test.ts` is 35 tests and runs **the whole
API through the least-privilege writer role**, so these are statements about the
deployed shape rather than a convenient one. It proves, among other things:

- The observation records, and `refunds` and `payments` are untouched.
- The write connection is refused by PostgreSQL (`42501`) when it tries to
  insert a refund, update a payment, update a print job or session, delete an
  audit event, issue an agent command, or read a filename, a manifest or a
  credential digest.
- A job that is not in recovery is refused by the application (409) **and** by
  the trigger, tested separately.
- A resolution attributed to the wrong kiosk is refused by the trigger.
- After a resolution, the job is still `RECOVERY_REQUIRED` / `UNCONFIRMED` with
  no `completedAt`.
- An Operator gets 404 — not 403 — for another kiosk's job, and again after
  their assignment is revoked mid-session.
- The refusal is audited even though nothing was written.
- Step-up is required for the R2 action and not for the R1 one.
- Idempotency: replay on an identical repeat, 409 on a contradictory one, one
  row either way.
- Acknowledging an invented failure code is refused and recorded as `DENIED`.

---

## 4. Security review

### What this phase closes

- **Phase 2 §7 item 1 — the write-path pool.** Decided and built: a third pool
  with its own role, its own grants and a boot-time assertion.
- **Phase 2 §7 item 2 — idempotency for admin actions.** Done, keyed per job by
  a unique index. See §4.1 for the deviation from the plan.
- **Phase 2 §7 item 3 — session-keyed rate limiting.** Done, for reads and
  actions both.
- **T13 (an Operator causes a payout).** Closed at the database.

### 4.1 Deviation from the plan, stated deliberately

Phase 0 §14.1 says recovery resolution should be "idempotent per print job via
`IdempotencyRecord`". It is idempotent per print job, but via a **unique index
on the resolution itself** rather than through `IdempotencyRecord`.

The reason: `IdempotencyRecord` expires. A TTL is right for a kiosk retrying a
request over a flaky link; it is wrong for "this print has already been
answered", which must hold forever. The unique index gives the same replay and
conflict semantics — the request digest is stored on the row — without a TTL,
without a second table, and without a client-supplied header to get wrong. It
also means the writer role needs no DELETE grant to reclaim expired records,
which is what keeps §1.1's shape as clean as it is.

### 4.2 Defects found and fixed in existing code

Two, both found by writing the tests:

1. **The error centre listed successful kiosk commands as failures.** A settled
   `AgentCommand` records `failureCode ?? status`, so a command that simply
   worked carries the result code `COMPLETED`. The Phase 2 query grouped every
   non-null result code, so every successful print appeared in the error centre.
   Noise on its own; worse once an operator can acknowledge a group as an
   incident. Now filtered to `FAILED` and `EXPIRED`.
2. **Two rate limiters shared one bucket.** Every limiter in the process shares
   one store keyed by whatever its key generator returns, so two limits with
   different ceilings and the same key are one limit with the lower ceiling.
   Reading the dashboard would have spent the much smaller allowance reserved
   for operator actions, and an operator would have been told to slow down for
   having looked at a screen. Each family of routes now names its own bucket.

A third was avoided rather than fixed: the audit metadata key for the recovery
outcome is `recoveryOutcome`, not `outcome`, because an audit row already has an
`outcome` column meaning SUCCESS or DENIED — and two fields of that name on one
screen is how a log gets misread during the incident it was kept for.

### 4.3 Known gaps

1. **A mistaken observation cannot be corrected.** One per job, append-only, and
   there is no supersede path. This is the right default — somebody who could
   rewrite their own account of a paid print could launder a failure into a
   success — but it is a real operational constraint. The damage is bounded:
   `refundSuggested` is only a suggestion, so a wrong observation creates work
   rather than money. Correction belongs in Phase 4 as an explicit, higher-
   authority action recorded as its own fact.
2. **`UNRESOLVABLE` does not reach a worklist.** It suggests no refund and drops
   off the recovery queue, so "nobody could tell" currently ends there. Phase
   4's refund queue should surface it separately: it is a decision for somebody
   with more authority, not a closed case.
3. **Resolving does not shorten the retention grace.** A resolved session keeps
   the longer `RECOVERY_REQUIRED` grace, so documents that could now be
   destroyed wait out the full window. Fixing it means the write role gaining
   UPDATE on `print_sessions`, which is exactly the grant this phase is built
   around not having. It wants a different mechanism — a signal to the worker,
   not a row edit.
4. **`audit_events` write privileges are still held by the application role**
   (carried over from Phase 2). The append-only trigger is the real control and
   it works; the `REVOKE` that would add defence in depth is ineffective while
   the application role owns the tables. Fixing it properly needs a separate
   migration owner role, which is a deployment change.
5. **The overview cache is per process** (carried over from Phase 2). Two
   operators can see counts up to five seconds apart.

### Deliberately absent

No refund endpoint of any kind, no retention retry, no operator or authenticator
management, no approval workflow — those are Phases 4 and 5. And still: no SQL
console, no shell, no arbitrary query builder, no printer command console, no
queue or Redis console, no environment browser, no secrets viewer, no document
download, no preview, no storage URL, no kiosk credential surface.

---

## 5. Printing performance impact

Nothing on the print path changed. The write pool is separate, capped at two
connections, cancels its own statements after two seconds and gives up a lock
contest after one. It cannot take a connection the print path needs and cannot
hold a lock against it.

An operator action is one short transaction that reads four rows by primary key
and inserts two.

---

## 6. Setup

A development environment needs the writer role provisioned once:

```
ADMIN_WRITE_DATABASE_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  pnpm db:admin-writer provision
pnpm db:admin-writer verify
```

Then set `ADMIN_WRITE_DATABASE_URL` in `.env` to that role and password.
Development may leave it unset and share the application role; the API logs a
warning at boot saying the database is no longer the thing enforcing the limits.
Production requires it and requires it to differ from both other URLs.

**Re-run `provision` and `verify` for both roles after every migration.** A new
table is denied by default for the reader and forbidden by default for the
writer. That is the behaviour we want, but only if somebody notices — `verify`
is what notices, and it did during this phase.

---

## 7. What remains

Phase 4 (Admin tools: `refund.authorize`, `document.retention.retry`, operator
and authenticator management) is unblocked. Before it starts:

1. **Decide how a refund authorization reaches the money tables.** It cannot be
   a grant added to the writer role without discarding the property §1.1 is
   built on. The likely answer is a fourth role whose only privilege is on
   `refunds`, held by a path that requires `refund.authorize` — which keeps
   "can this connection pay somebody" answerable by reading a grant list.
2. **Design the correction path** for a mistaken observation (gap 1), since it
   is the same shape as the supersede record Phase 5 will need.
3. **Decide how retention learns a recovery was resolved** (gap 3).
4. **A separate migration owner role** (gap 4), still outstanding from Phase 2.
