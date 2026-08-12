# Admin control plane — Phase 4B status

The people half of Phase 4. Everything shipped before it appends; this is the
first surface that changes a row somebody's access depends on, and this document
is mostly about the distance kept between that and everything else a person could
want to change.

Phase 4B's gate, inherited from `ADMIN_PHASE_0.md` §22's fourth row: **Operator
and authenticator management, with reason plus before/after audited.** The
separation is not a code convention. It is a fifth PostgreSQL role holding UPDATE
on nine named _columns_, and the column it does not hold — `admin_users.role` —
is what makes "nothing reachable from a browser promotes anybody" a fact about
the database rather than a claim about this repository.

The three decisions §7 of the Phase 4 document said had to be made first were
taken by the owner before any code was written. Each one is recorded in §1 with
what it cost.

---

## 1. What was implemented

### 1.1 The people role — `printing_kiosk_admin_people_writer`

**Decision 1 — does the people half follow the same pattern?** Yes: a fifth
PostgreSQL role, and the first in the control plane that holds UPDATE at all.

|                     |                                                                  |
| ------------------- | ---------------------------------------------------------------- |
| may UPDATE (column) | `admin_users` (status, suspended_at, disabled_at, updated_at)    |
|                     | `admin_authenticators` (revoked_at, revoked_reason)              |
|                     | `admin_sessions` (revoked_at, revoked_reason)                    |
|                     | `admin_kiosk_scopes` (revoked_at)                                |
| may INSERT          | `admin_kiosk_scopes`, `admin_enrollment_tickets`, `audit_events` |
| may SELECT          | 7 tables, 5 of them column-restricted                            |
| may DELETE          | nothing                                                          |

The alternative was widening `printing_kiosk_admin_writer`, and it was rejected
for the reason Phase 4 §1.1 gives about money: that role is _defined_ by holding
no UPDATE anywhere, so widening it would have discarded the property two previous
phases were built to establish. The question keeps a one-line answer:

> Which connection can change whether somebody may sign in?
> `printing_kiosk_admin_people_writer`, and only it.

Four absences in that shape are load-bearing. Each is asserted at boot by
[`assertAdminPeopleClientIsBounded`](../packages/database/src/index.ts) and again
by `pnpm db:admin-people-writer verify`:

- **It cannot change anybody's role.** `admin_users.role` is absent from the
  updatable list, so no path through this connection turns an Operator into an
  Admin, and a compromised Admin account cannot make itself a Technical Admin.
  That is the single most valuable column in the database and this role does not
  hold it. Because the role _does_ hold UPDATE on the same table, the boot check
  asks about the column rather than the table — `has_column_privilege`, not
  `has_table_privilege`.
- **It cannot enrol an authenticator.** No INSERT on `admin_authenticators`; it
  may only set `revoked_at` on one that exists. Enrolment needs a WebAuthn
  ceremony on the application connection, so this role can end a key's life and
  never start one.
- **It cannot read a credential, a session token or a ticket digest.**
  Column-level SELECT stops short of `credential_id`, `public_key`,
  `user_handle`, `token_digest`, `csrf_digest` and
  `admin_enrollment_tickets.secret_digest`. It revokes sessions it cannot
  recognise, and mints tickets it structurally cannot redeem.
- **It holds nothing at all on any product table.** Not a print job, not a
  payment, not a refund, not a document. `verify` asserts the absence explicitly
  rather than inferring it from an empty grant list.

`printing_kiosk_admin_writer` and `printing_kiosk_admin_refund_writer` are
unchanged, and both are refused the new tables by name.

**What this role cost, stated plainly.** The shared `admin-append-role.mjs`
runner asserts "no UPDATE anywhere, on any table" — the sentence that made the
previous three roles reviewable in one line. This role cannot use it, so
[`admin-people-writer.mjs`](../packages/database/scripts/admin-people-writer.mjs)
is a second provisioning implementation. It holds itself to a stricter standard
in exchange: `verify` walks every column of every table in the database and fails
on any UPDATE grant the matrix does not name, on any table-level UPDATE at all
(including on the four tables it does hold columns in), and on any DELETE
anywhere.

**It also needs two connections.** The admin tables have been owned by
`printing_kiosk_migrator` since Phase 4, and only an owner may grant on what it
owns — but that role is deliberately `NOCREATEROLE`, because a role-creating
migrator would be a second path to manufacturing a privileged connection. So
`provision` does role management on `DATABASE_URL` and every GRANT on
`ADMIN_OWNER_DATABASE_URL`. `verify` needs neither.

### 1.2 `operator.manage` — status, kiosks and sessions (R2)

Three routes, in [people.ts](../services/api/src/modules/admin/people.ts) and
[people-routes.ts](../services/api/src/modules/admin/people-routes.ts), separate
files from money and from the four actions that cost nothing.

```
POST /v1/admin/people/:adminUserId/status            suspend, resume, disable
POST /v1/admin/people/:adminUserId/kiosks            assign a kiosk, or take one back
POST /v1/admin/people/:adminUserId/sessions/revoke   sign somebody out everywhere
```

Enforced on every call:

- **Every action targets an Operator, and nothing else.** A target that is not an
  Operator answers **404, never 403**, exactly as an unknown one does — so the
  panel cannot be used to discover who the Admins and Technical Admins are. It
  also means an Admin cannot suspend a peer, which is what stops two compromised
  Admin accounts from being able to lock each other's colleagues out.
- **The owner row is locked first**, matching every identity mutation since Phase
  1, so a status change, a key revocation and a ticket issuance racing each other
  serialise on one row.
- **Every write is conditional.** `people-database.ts` exposes `updateMany` and
  not `update`, so each change carries the predicate it was authorized against —
  "suspend this account _if it is still ACTIVE and still an Operator_" — and the
  row count is the answer to whether the world was still what the caller decided
  about. A request that raced a suspension loses rather than wins.
- **Status transitions are one rule stated three times.** `evaluateStatusTransition`
  in `@printing-kiosk/admin-access` is shared with the panel; the account CLI has
  enforced the same rule since Phase 1; and a database trigger enforces it again.
  `DISABLED` is terminal, `PROVISIONING` is never a destination, and an account
  that never activated cannot be resumed into `ACTIVE`.
- **Anything but resuming ends every live session**, in the same transaction, and
  the response says how many. Suspending somebody whose browser tab keeps working
  is not suspending them.
- **Step-up WebAuthn assertion** required on all five routes. There is no R1
  people action: the cheapest thing on the page still ends somebody's ability to
  do their job.
- **Full before/after audit**, including the target's role beside the actor's own.

### 1.3 Kiosk assignment stops being a `DELETE`

Nothing wrote `admin_kiosk_scopes` outside integration tests before this phase,
so a real Operator could act on no kiosk at all. That is now a panel action, and
the shape it took is the phase's one schema decision worth arguing about.

`admin_kiosk_scopes` gains `revoked_at`. Taking a kiosk back sets it; giving the
kiosk back clears it on the row that already exists. The primary key is still
`(person, kiosk)`, so the pair can never accumulate two rows disagreeing about
whether the assignment is live, and **who could act on kiosk 4 last March stays
answerable** — from the audit log, and from a row that was not destroyed.

The alternative was a DELETE grant, which would have been the first anywhere in
the control plane and would have erased its own subject. A trigger refuses to
re-point an assignment at a different person or kiosk, so the only thing that can
change about one is whether it is live.

**A withdrawal bites on the next action, not the next sign-in.** Three reads had
to learn about the new column: the session resolver, the scope load at sign-in,
and `mayActOnKiosk`, which already re-read assignments inside the writing
transaction for exactly this reason. An integration test asserts an Operator's
scope list emptying under a live session.

### 1.4 `authenticator.manage.operator` — keys and enrolment tickets (R2)

```
POST /v1/admin/people/:adminUserId/authenticators/:authenticatorId/revoke
POST /v1/admin/people/:adminUserId/enrollment-ticket
```

**Decision 3 — how far the Technical Admin widening goes.** The owner decided
that Admins _and Technical Admins_ may get an Operator onto a key, which reverses
part of a Phase 0 decision. It is recorded as a deviation in §4.1 with the
residual risk; `operator.manage` stays Admin-only, so a Technical Admin still
cannot decide whether an Operator may work, or where.

Retiring a key is refused when it would take an ACTIVE account below its role's
minimum — the replacement is enrolled first. A trigger refuses the same thing, so
this check exists to produce a message a person can act on rather than to make
the rule true. There is no password in this system, so a revocation that leaves
nothing behind is a lockout rather than a cleanup.

### 1.5 Enrollment tickets — the largest unknown, answered

**Decision 2 — how an Operator enrols a credential they do not yet have.** The
gap: an account with no authenticator cannot sign in, and nobody can enrol one on
its behalf, because WebAuthn requires the person and their device in the same
place. The owner chose a dashboard-issued ticket over reusing the sealed
break-glass path, with four constraints, all of which are implemented and tested.

A ticket authorises **one enrolment ceremony, for fifteen minutes, on one named
account**, and it is deliberately _not_ a second break-glass. The difference is
enforced by the target's state rather than by convention:

|                  | break-glass                         | enrollment ticket                      |
| ---------------- | ----------------------------------- | -------------------------------------- |
| for              | somebody who lost the keys they had | somebody who never had one             |
| eligible target  | `PROVISIONING` **or** `ACTIVE`      | `PROVISIONING`, and zero usable keys   |
| issued by        | CLI, sealed offline                 | the panel, by Admin or Technical Admin |
| ceremony purpose | `BREAK_GLASS_REGISTRATION`          | `ENROLLMENT_TICKET_REGISTRATION`       |
| grants a session | no                                  | no                                     |

The properties that make it something other than an impersonation tool:

- **It can only name an account that has never had a key.** A trigger checks
  `OPERATOR`, `PROVISIONING` and zero usable authenticators while holding the
  owner row, so it cannot be minted against a working identity and cannot race an
  enrolment. The route checks the same things first, to produce a message.
- **The issuer is never the target** — a `CHECK` constraint, so this can never
  become a way for its holder to add a key to their own account.
- **Only an ACTIVE Admin or Technical Admin can be the issuer**, checked by the
  same trigger, so the grant means nothing to a connection that acquires it later.
- **Single use, and consumed when it authorises the ceremony** rather than when
  the ceremony succeeds — the same choice break-glass makes, for the same reason:
  a failed attempt must still burn the code or it is retryable by anyone who saw
  it. The cost is much lower here, because a burnt ticket is replaced in seconds
  where a burnt recovery code is a sealed envelope somebody has to fetch.
- **Both halves are audited.** `admin.people.enrollment.issue` names who issued
  it and for whom; `admin.enrollment.redeem` names the account that spent it.
  Neither row contains the code, and the digest is peppered.
- **The panel shows every outstanding ticket** on the account it belongs to, to
  anybody who can see the section, because a ticket sitting on an account is
  exactly what a second pair of eyes should notice.
- **Every failure says the same thing.** Wrong code, expired code, spent code,
  account already enrolled, account suspended — one message, because the
  differences between them are what somebody holding a stolen code would like to
  learn.

The code is 256 bits, returned once, and never stored in readable form. It shares
the break-glass pepper deliberately — they are the same kind of artifact — with a
domain-separating purpose string, so neither can be presented to the other's
endpoint.

### 1.6 Schema

One migration,
[20260811030000_admin_phase4b_people_management](../packages/database/prisma/migrations/20260811030000_admin_phase4b_people_management/migration.sql),
adding one column, one table, four triggers and one widened check constraint. It
alters owner-owned tables, so it runs as `pnpm db:migrate:owner`.

- **`admin_kiosk_scopes.revoked_at`** plus an immutability trigger: an assignment
  may change in exactly one direction, and cannot be re-pointed.
- **`admin_enrollment_tickets`** — `UNIQUE (secret_digest)`, `ON DELETE RESTRICT`
  to both accounts it names, and the two triggers described in §1.5.
- **`admin_webauthn_challenges_purpose_check`** gains
  `ENROLLMENT_TICKET_REGISTRATION`. The vocabulary stays closed, so a bug that
  wrote a purpose nobody reviewed is a failed insert rather than a ceremony with
  no rules.

Deliberately **not** a delete-refusing trigger on `admin_kiosk_scopes`: the table
cascades from account and kiosk deletion, and the property actually needed — that
the control plane cannot destroy an assignment — is the missing grant, which is
the outermost layer anyway.

### 1.7 Read side

`GET /v1/admin/people` returns the Operators, each with status, key count and
minimum, key labels and last-used times, live session count, kiosk assignments,
and outstanding tickets. It runs on the **read** pool like every other list: the
people actions need their own least-privilege role, but a roster is a read, and
routing it elsewhere would have given the connection that suspends people a
reason to be able to enumerate them.

That required widening the reader matrix. `admin_authenticators` and
`admin_sessions` moved from denied-entirely to column-restricted, and
`admin_enrollment_tickets` was added the same way. The columns that made them
denied in the first place stay denied: `credential_id`, `public_key`,
`sign_count`, `transports`, `aaguid`, `token_digest`, `csrf_digest`,
`secret_digest`.

The endpoint is gated on `authenticator.manage.operator` — the looser of the two
capabilities — so a Technical Admin can see who it would be issuing a ticket to.

### 1.8 UI

- A **People** section, drawn from `authenticator.manage.operator` and with its
  status and kiosk controls drawn from `operator.manage`, so a Technical Admin
  finds the section present and half the controls absent rather than a door onto
  a refusal.
- A status form that states the consequence before the button: which sessions end,
  and that disabling cannot be undone.
- A kiosk panel that says a withdrawal bites at the next action rather than the
  next sign-in.
- A ticket panel that shows the code once, large and selectable, next to the
  instruction to read it out rather than send it, and the expiry.
- A retire control that is disabled, with a reason, when it would leave an active
  account unable to sign in.
- On the sign-in screen, an **I have an enrolment code** panel below recovery,
  worded to keep the two apart — confusing them is expensive in one direction,
  because somebody being onboarded who reaches for a sealed envelope has burnt a
  recovery code for nothing.

The design-system gap Phase 4A left is also closed: `.refund-queue`,
`.resolution__correction`, `.resolution__superseded`, `.inline-form` and
`.button-quiet` are styled in the same voice as the rest of the sheet, with the
accent still reserved for "somebody has to do something".

---

## 2. New dependencies

**None.** Phase 4B adds no runtime and no development dependency. The new
external artifact is one PostgreSQL role. The control plane still has exactly one
runtime dependency in total (`@simplewebauthn/server`, justified in
`ADMIN_PHASE_0.md` §13.1).

---

## 3. Verification

```
pnpm run lint             25/25 tasks
pnpm run typecheck        25/25 tasks
pnpm run test             25/25 tasks
pnpm run format:check     clean
pnpm run test:integration 265/265   (28 new, in admin-people.test.ts)
pnpm db:admin-reader verify         privilege matrix verified
pnpm db:admin-writer verify         four INSERTs, no UPDATE, no DELETE
pnpm db:admin-refund-writer verify  three INSERTs, no UPDATE, no DELETE
pnpm db:admin-people-writer verify  nine updatable columns, no table-level UPDATE
pnpm db:admin-owner verify          see §4.3 — fails by design in development
```

`tests/integration/admin-people.test.ts` runs **the whole API through the
least-privilege people role**, so these are statements about the deployed shape.
It proves, among other things:

- The people connection is refused by PostgreSQL (`42501`) when it tries to
  change anybody's role, create an account, a credential or a session, read a
  credential or a session token or a ticket digest, delete a row from any of the
  six tables it touches, rewrite the audit log, or read a print job, a payment, a
  refund, an uploaded file or a cleanup run.
- An Operator is refused all four people routes and **every refusal is recorded**.
- A Technical Admin is refused a suspension and a kiosk assignment, and allowed a
  ticket and a key revocation.
- A people action against a non-Operator answers 404, and the roster contains no
  account that is not an Operator.
- Suspension ends both live sessions, records `ACTIVE → SUSPENDED` with the
  reason and the session count, and leaves the role untouched.
- `DISABLED` cannot be reopened; an account that never activated cannot be
  resumed.
- A kiosk assignment survives its own revocation as a row, re-assignment reuses
  it rather than adding one, a repeat is reported as no change, and a withdrawal
  empties a live session's scope list on the next request.
- A revocation that would leave an ACTIVE account below its minimum is a 409; one
  with a spare left leaves the retired row in place.
- A ticket is single use, expires, cannot be minted for an account that already
  holds a key or for a suspended one, cannot name a Technical Admin (a
  `23514` check violation at the database, not just a 404 at the route), cannot
  be issued to oneself, and audits both its issue and its redemption without the
  code appearing in either row.
- Every people route is refused without a fresh WebAuthn assertion.

Two front-end tests cover the visibility split: a Technical Admin sees the
section and the ticket control but not the status or kiosk controls, and an
Operator does not see the section at all.

---

## 4. Security review

### What this phase closes

- **Phase 4 §7 item 1 — does the people half get its own role?** Closed by §1.1,
  as a fifth role with column-level UPDATE and a `verify` that checks it column
  by column.
- **Phase 4 §7 item 2 — how does an Operator enrol a credential they do not have?**
  Closed by §1.5, as a ticket confined to an account that has never had a key.
- **A gap nobody had listed: kiosk assignment had no writer at all.** Closed by
  §1.3. Before this phase a real Operator could act on no kiosk, and the only
  thing that had ever written `admin_kiosk_scopes` was an integration test.
- **T16 stays closed and does not widen.** Multiple mandatory enrolments and the
  sealed break-glass path are unchanged. The ticket is a third path _in_, and it
  is the narrowest of the three: it works only where no key has ever existed.

### 4.1 Deviations from the plan, stated deliberately

**Technical Admin now holds a capability over people.** `ADMIN_PHASE_0.md` §14
marks `operator.manage` ❌ for Technical Admin, and `capabilities.ts` described
the role as holding no capability over people at all. The owner decided that a
Technical Admin may issue an enrolment ticket and retire an Operator's key, so
that onboarding does not have to wait for an Admin at three in the morning.

I raised the conflict before implementing it and offered a narrower alternative —
a new `operator.enrollment.invite` capability covering only the ticket. The owner
chose the wider option: `authenticator.manage.operator` in full.

The residual risk, stated rather than hidden: **a compromised Technical Admin can
put a key it controls on a provisioning Operator account and act as that person.**
It gains no capability by doing so — every Operator capability is already in the
Technical Admin list — but it gains a second name to act under, which is
attribution laundering. What bounds it: the account must be one that has never
signed in, both halves of the ceremony are audited, the panel shows outstanding
tickets to everyone who can see the section, and `operator.manage` stays
Admin-only so the same account still cannot suspend anybody or move a kiosk
assignment. `ADMIN_PHASE_0.md` §14 and §19 should be amended to match; this
document is the record until they are.

**A second provisioning implementation.** Phase 4 consolidated the append-only
roles into one shared runner specifically so "no UPDATE anywhere" would be
asserted by one implementation. This role cannot use it. The cost is real and is
described in §1.1; the mitigation is that the new runner checks strictly more.

**The per-address rate limit on people routes is generous.** 120/minute by source
address, against 20/minute per signed-in session. Behind a reverse proxy every
Admin shares one address, and onboarding a shift of Operators is a legitimate
burst — the same argument `routes.ts` already makes about break-glass. The
meaningful bound is the per-session one, because that is what a stolen session
can spend.

**`updateMany` instead of `update`, everywhere.** Unusual-looking, and load
bearing: it is what makes every people write carry the predicate it was
authorized against. `people-database.ts` omits `update` and `upsert` from the
type so the choice cannot be quietly reversed.

### 4.2 Defects found and fixed in existing code

One, found by writing the tests, and it was a real hole rather than a
Phase 4B-only one:

**A revoked kiosk assignment would still have authorized.** Three code paths read
`admin_kiosk_scopes` without a `revokedAt` filter — the session resolver, the
scope load at sign-in, and `mayActOnKiosk`'s in-transaction revalidation. Adding
the column without them would have made "take a kiosk back" a no-op for anybody
with a live session, and worse, a silent one. All three now filter, and the
integration suite asserts the scope list emptying under a live session.

Two things were avoided rather than fixed. A `DELETE` grant on
`admin_kiosk_scopes` was the obvious way to model withdrawal and would have been
the control plane's first; `revoked_at` costs one column and keeps the history.
And ageing a ticket in a test by disabling triggers does not work, because
`expires_at > created_at` is a `CHECK` constraint rather than a trigger — which
is the right outcome, and the test moves both timestamps instead.

### 4.3 Known gaps

1. **Ownership separation is still ineffective in development, and `verify` says
   so.** Unchanged from Phase 4 §4.3 item 1: the compose file runs the
   application as the cluster's bootstrap superuser. **Production must run the
   application as an ordinary role.** The owner's answer to the standing question
   was "not deployed yet — record as a gate", so it is recorded here as a
   deployment prerequisite: run `pnpm db:admin-owner verify` against production
   before trusting any of the audit-integrity work, in this phase or in Phase 4.
2. **An enrolment ticket is not revocable.** An Admin who issues one by mistake
   waits fifteen minutes for it to expire; there is no button to withdraw it. The
   panel makes an outstanding ticket visible to everybody who can see the
   section, which is the mitigation, and revocation is a `revoked_at` column and
   a fourth route away if it turns out to matter.
3. **Several live tickets can exist for one account.** Each is single use and
   short-lived, and issuing a new one does not invalidate the last. Preventing
   that needs either a partial unique index (which cannot reference `now()`) or a
   supersede column, and neither buys much against a fifteen-minute window.
4. **Nothing here creates an account.** `pnpm db:admin create` is still the only
   way, deliberately: creating an identity is the act that decides what role it
   holds, and no capability in this system can decide that. Onboarding is
   therefore two steps — CLI, then a ticket from the panel.
5. **A Technical Admin can act as an Operator it onboarded.** §4.1, stated in
   full there.
6. **The people roster is unpaginated**, bounded at 200 accounts and 200 kiosks.
   An installation past either number needs a cursor, and will find one missing
   rather than find a slow query.
7. **The overview cache is per process** (carried from Phase 2).

### Deliberately absent

No account creation, no role change, no self-service anything, no approval
workflow — the last is Phase 5. And still: no SQL console, no shell, no arbitrary
query builder, no printer command console, no queue or Redis console, no
environment browser, no secrets viewer, no document download, no preview, no
storage URL, no kiosk credential surface.

---

## 5. Printing performance impact

Nothing on the print path changed. The people pool is separate, capped at two
connections, cancels its own statements after two seconds and gives up a lock
contest after one, exactly as the write and refund pools do. It cannot take a
connection the print path needs and cannot hold a lock against it — and it holds
no privilege on any print table, so it cannot contend for one at all.

A people action is one short transaction touching between two and five rows by
primary key. The roster read is five bounded queries against indexed columns,
issued in parallel, and runs on the read pool with its existing timeouts.

The one change on a hot path is the kiosk-scope filter: `revokedAt: null` on
three reads, two of which run per admin request. It is covered by the new
`(admin_user_id, revoked_at)` index and touches no customer-facing path.

---

## 6. Setup

A development environment needs the new role provisioned once, **after** running
the migration:

```
pnpm db:migrate:owner                       # alters owner-owned admin tables

ADMIN_PEOPLE_DATABASE_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  pnpm db:admin-people-writer provision
pnpm db:admin-people-writer verify
```

Then set `ADMIN_PEOPLE_DATABASE_URL` in `.env` to that role and password.
`provision` needs a connection that can create a role (`DATABASE_URL`) _and_ the
owner connection (`ADMIN_OWNER_DATABASE_URL`) to issue the grants; `verify` needs
neither.

**Re-run `provision` and `verify` for all four least-privilege roles after this
migration.** It adds a table, and a new table is denied by default for the reader
and forbidden by default for the writers — that is the behaviour we want, but
only if somebody notices. `verify` is what notices, and it did during this phase:
re-applying the migration dropped and recreated `admin_enrollment_tickets`, which
took the reader's grants with it and turned the roster into a 500 until the roles
were re-provisioned.

Development may leave `ADMIN_PEOPLE_DATABASE_URL` unset, in which case the people
routes are not registered at all and the API logs why — a safe failure rather than
a silently unprotected one. Production requires it and requires it to differ from
every other connection string.

Onboarding a new Operator, end to end:

```
pnpm db:admin create --role OPERATOR --display-name "Sam"
# then, in the panel: People → Issue an enrolment code → read it to them
# they enter it at sign-in under "I have an enrolment code", twice, for two keys
# then: People → Kiosks → assign the kiosks they cover
```

---

## 7. What remains

Phase 5 — Technical Admin and the R3 approval workflow — is unblocked and
inherits three shapes now: the supersede record and the deferred trigger from
Phase 4, and from this phase the pattern of a role whose power is a column list.

Before it starts:

1. **Amend `ADMIN_PHASE_0.md` §14 and §19** to record the Technical Admin
   widening in §4.1 above, so the threat model and the capability table agree
   with `capabilities.ts`.
2. **Decide whether an enrolment ticket should be revocable** (§4.3 item 2). It
   is a column and a route, and the answer depends on whether fifteen minutes is
   short enough to live with.
3. **Confirm the production application role is not a superuser** (§4.3 item 1).
   Still open, now for the third phase running.

Two items from Phase 4 remain untouched and are still worth their entries there:
a correction cannot withdraw an authorized refund (R3-shaped, Phase 5), and
nothing settles a refund.
