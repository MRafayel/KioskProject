# Admin control plane — Phase 6 status

Hardening. The first phase that adds no operational surface, and the first whose
deliverable is a set of statements about the whole control plane rather than
about one feature of it.

Phase 0 §22's sixth row asked for an authorization matrix review per endpoint,
IDOR, CSRF, XSS, secret leakage, query performance and audit integrity, gated on
a security test suite being green. All seven were done. The suite is
`tests/integration/admin-security.test.ts`: 52 tests, and most of them are asked
of **every route the application registered** rather than of the routes somebody
remembered to write a test for.

**Four defects were found, and all four were live.** The most serious made the
audit log return a 500 as soon as a failed sign-in appeared on the page being
read. The most embarrassing made the People section stop loading five minutes
after signing in. Neither was hypothetical, both had shipped, and neither would
have been found by reading the code — one needed the route table compared against
the policy, the other needed a database with real history in it. Details in §4.2.

Two owner decisions that had been open since Phase 5 were also closed, and one of
them narrows a role. Details in §1.1.

---

## 1. What was implemented

### 1.1 Two owner decisions, closed

**Technical Admin no longer holds `refund.authorize`.** It was granted in Phase 4,
when the plan still made Technical Admin a co-approver of production change. That
model was removed in Phase 5 and the grant outlived its reason: a support role
that can cause a payout is a second account whose compromise costs money.
Exactly one role in the system can now move money, and
`packages/admin-access/src/capabilities.test.ts` asserts that as a list rather
than as three separate expectations.

The other three capabilities Phase 5 flagged were kept, on the same decision and
for a stated reason rather than by inertia. `print.recovery.correct` and
`document.retention.retry` are recovery work at an hour when there may be no
Admin awake — a dead-lettered cleanup means a customer's documents still exist
after this system said they would not, and putting an Admin between a support
engineer and "try again" protects nothing. `authenticator.manage.operator` is why
the role exists at 03:00 at all. None of the three can cause a payout, which is
the line the decision draws.

**There will be one Admin, permanently.** Phase 5 carried this as open because a
second Admin would have made a two-person rule over the tariff worth reinstating.
It is now settled: nothing in the control plane waits for a second account,
`pricing.publish` stays R2, and the R3 branch in `authorizeAdmin` stays as a
fail-closed backstop rather than as a workflow anybody intends to use.

`ADMIN_PHASE_0.md` §14, §15, §19 and §23 are amended; §23.6 is new.

### 1.2 The authorization matrix, checked against the route table

`capabilities.ts` has been the policy since Phase 1 and the routes have been the
claim since Phase 2. Nothing had ever compared them. The suite now does, and the
mechanism matters more than the result:

```
ENDPOINTS            43 routes, each declared with the capability it names
actualAdminRoutes()  the tree Fastify actually built, parsed from printRoutes
```

The first test asserts those two sets are equal. A route that exists and is not
declared fails the suite; a route declared and not registered fails it too. The
three surfaces that are registered only when their least-privilege role is
configured — money, people, pricing — are declared with the connection they
depend on, so the expected set adjusts rather than the assertion being weakened.

Every other test in §1 of the suite is driven from that same declaration, which
is what makes them exhaustive by construction:

| Property                                                                  | How it is checked                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------- |
| A role is refused every capability it does not hold                       | every route × every role, expecting 403              |
| A role is admitted to every capability it does hold                       | every route × every role, expecting **not** 403      |
| Every R2 route demands a fresh WebAuthn assertion                         | every R2 route × every holder, expecting 401 step-up |
| No R0 or R1 route demands one                                             | the same sweep, inverted                             |
| Every state-changing route refuses a missing CSRF token                   | every non-GET route                                  |
| Every state-changing route refuses another session's CSRF token           | every non-GET route                                  |
| Every route that is not deliberately open refuses an unauthenticated call | every route, expecting 401                           |
| No read is gated by a capability that can change something                | static: every GET names an R0 capability             |
| Nothing that changes the world is reachable by GET                        | static: path shapes                                  |

The step-up sweep is the one worth calling out. Risk class is a property of a
capability, and until now "R2 means a fresh assertion" was true because
`authorizeAdmin` says so and because individual phases tested their own routes.
It is now asserted as observable behaviour on all of them at once: an R2 route
that somehow bypassed the gate would show up as a 4xx that is not
`ADMIN_STEP_UP_REQUIRED`.

**Four capabilities gate no endpoint and widen no response.**
`kiosk.liveness.read`, `kiosk.maintenance_mode`, `payment.mismatch.read` and
`pricing.read` were declared in Phase 0 ahead of features that were never built.
They grant nothing — but a reviewer reading `ROLE_CAPABILITIES` sees an Admin
holding `pricing.read` and reasonably assumes something is gated on it. They are
now enumerated with a reason each, asserted in both directions: a new capability
that gates nothing has to be added to that list deliberately, and one of these
acquiring an endpoint has to be removed from it just as deliberately. Whether to
delete them is §7's first question for the owner.

**Admin can reach every route.** Stated in the suite rather than left to be
noticed: Admin holds every capability that gates an endpoint, so the refusal
sweep is empty for it. The separation from Technical Admin survives in what each
can _see_ — `print.diagnostics.read` widens the print job detail and gates no
route — which means "no role is a superset" is true of the capability table and
not true of the route table. That is the role model working as designed, and it
is better written down than inferred.

### 1.3 IDOR

An Operator scoped to one kiosk, pointed at another kiosk's real records.

The property under test is not "is it refused" but "is it refused **the same way
an unknown identifier is refused**". A 403 on an out-of-scope identifier confirms
the identifier names something real, which is the entire mechanism of an
enumeration attack. Session detail, timeline, documents and print job detail all
answer `404 ADMIN_NOT_FOUND` for another kiosk's records, byte for byte what they
answer for an identifier that names nothing — and the control that makes this
non-vacuous is there too: the same reads against the Operator's own kiosk answer 200.

Also asserted: naming another kiosk in a query filter yields an empty page rather
than an override, acting on another kiosk's print job is a 404, an Operator's
audit log contains only its own actions, `authenticator.manage.self` names no
target so there is no parameter to point at a colleague, and the people roster
returns Operators only — a screen listing Admins with the controls greyed out
would be a screen naming the accounts worth attacking.

### 1.4 What leaves the process

Every readable route is called against records that exist, and the response is
walked recursively for two things: a field name from a deny-list of twenty-four
(`publicKey`, `credentialId`, `tokenDigest`, `objectKey`, `contentSha256`,
`fileName`, `previewUrl`, …), and a value containing a secret.

The values are the part worth describing. A customer's filename and content
digest are seeded as **canaries** into a real uploaded file, and the process's
own peppers and connection string are read from the environment the test is
running with. A response containing any of them fails. That is stronger than
asserting a schema shape: it would catch a leak through a field nobody thought
to deny.

Error bodies are checked separately — `{error: {code, message, requestId}}` and
nothing else, with no stack, no SQL fragment and no internal string — and the
route table is asserted to contain no path that could serve bytes.

### 1.5 Response hygiene, and the XSS question

Nothing in the control plane renders. The honest form of "check for XSS" here is
therefore three properties, and all three are asserted: every response is
`application/json` with `x-content-type-options: nosniff`, so a browser cannot be
talked into treating one as a document; every response is `cache-control:
no-store`, so a shared cache or a back button after sign-out cannot reproduce
one; and no caller-supplied text is reflected back into any response, checked by
pushing `<script>alert(1)</script>` through five different query parameters and a
nonexistent path and asserting it never appears in the body.

The origin hook is tested for what it was written for: a foreign `Origin` is
refused, and so is a same-host request carrying a customer application's fetch
context — an XSS in the kiosk or upload app must not be able to make a
credentialed admin request through a shared dev proxy.

The remaining XSS surface is the admin app's own CSP, which is a property of
whatever serves the built bundle in production. That is unchanged and still open;
see §7.

### 1.6 Audit integrity, end to end

`audit_events` has been append-only by trigger since Phase 2 and migrator-owned
since Phase 4. The gap Phase 4 recorded and left open was that **the control
plane's own evidence tables were still application-owned** — so the role whose
credential the triggers exist to protect against could have disabled them.

Four tables moved to `printing_kiosk_migrator`:

```
print_job_recovery_resolutions    what an operator saw at a tray
print_job_recovery_corrections    the later account that superseded one
refund_authorizations             who authorized a payout, and why
cleanup_retry_requests            who asked retention to try again
```

They keep **SELECT and nothing else** for the application, which is narrower than
the `admin_*` tables above them in `admin-owner.mjs`. The application does read
two of them — retention shortens a resolved recovery's grace by reading the
observation, and the re-arm joins the retry requests — and it writes none of
them: every insert comes from an admin role on its own connection.

The suite asserts ownership of all thirteen migrator-owned tables directly from
`pg_tables`, asserts no trigger on any of them is disabled, and then proves the
guarantee against rows that exist rather than against empty tables — it performs
a real resolution, a real correction and a real refund authorization through the
real routes on the real least-privilege roles, and then tries to rewrite and
delete each one on the application's own credential. That chain doubles as this
phase's most important regression check: three writing roles were re-granted by a
new owner, and an admin action that stopped working would surface here rather
than in production.

### 1.7 The production superuser gate, closed after four phases

Every ownership separation in the control plane rests on one assumption: that the
credential the product runs with cannot take back what was taken from it. A
superuser can — it can re-own `audit_events`, `ALTER TABLE ... DISABLE TRIGGER
ALL`, and erase the record of having done so. Under that credential Phase 4's
transfer, Phase 5's publication trigger and this phase's evidence tables are all
decoration.

This has been a standing deployment gate since Phase 4 and nothing enforced it,
which is a gate in the same sense that an unlocked door is a lock.
`assertApplicationRoleIsNotPrivileged` now asks PostgreSQL, of the connection the
process actually opened, at the moment it opens it — and in production the API
and the worker both **refuse to start** if the answer is `rolsuper` or
`rolbypassrls`. The message names the finding and the fix.

Development is exempt, because the compose image runs the application as the
cluster's bootstrap superuser and refusing to boot over that would be an outage
in exchange for nothing. That is the same reasoning the write-pool assertions
already use for an unconfigured role, and it is why `pnpm db:admin-owner verify`
still reports two failures locally by design.

### 1.8 Query performance, measured

`pnpm db:admin-benchmark` — seed, measure, clean. It builds the real
`AdminObservabilityService` on the real admin read pool, so every timing is the
query the API issues, planned by the same role under the same statement timeout.
There is no reimplementation of the SQL to drift from what runs.

The seed writes a plausible year of trading through the product's own ordering,
and that ordering is an invariant rather than a convenience:
`print_sessions_one_active_per_kiosk_idx` permits one non-terminal session per
kiosk and `print_jobs_require_capture` refuses a print job whose session is not
`PAID`, so a print job can only exist while its session is the live one on its
kiosk. Seeding around either would have produced rows the product could never
make, and a benchmark against impossible data measures nothing.

Numbers in §5. The short version: at 50,000 sessions the slowest read is 12.5ms
at p95, against a 5-second statement timeout.

---

## 2. New dependencies

**None.** Phase 6 adds no runtime and no development dependency. The control
plane still has exactly one in total (`@simplewebauthn/server`, justified in
`ADMIN_PHASE_0.md` §13.1). It adds one capability — `operator.read`, and it
exists to fix a defect rather than to permit anything new; see §4.2 — and no new
database role.

---

## 3. Verification

```
pnpm lint             25 tasks, clean
pnpm typecheck        25 tasks, clean
pnpm test             25 packages — API 103, admin-access 118, config 67, admin 29
pnpm test:integration 14 files, 338 tests
pnpm format:check     clean
```

`tests/integration/admin-security.test.ts` — 52 tests. Route counts below are
what the suite exercised with all five least-privilege roles configured.

- the declared matrix equals the 43 routes Fastify registered;
- every capability a route names exists, and every declared capability either
  gates a route or is on the annotated list of seven that do not;
- 3 roles × every route they lack → `403 ADMIN_FORBIDDEN`, with no exceptions;
- 3 roles × every route they hold → never `ADMIN_FORBIDDEN`;
- 25 role/route pairs at R2 → `401 ADMIN_STEP_UP_REQUIRED`, every one;
- no R0 or R1 route asks for a step-up;
- every GET names an R0 capability;
- every mutating route refuses a missing CSRF token, another session's token, and
  a duplicated header;
- every non-open route refuses an unauthenticated caller;
- no recovery or enrolment ceremony issues a session cookie;
- a foreign `Origin` and a customer application's fetch context are both refused;
- an Operator gets 404 for another kiosk's session, timeline, documents and print
  job — identical to an identifier naming nothing — and 200 for its own;
- an Operator cannot widen its scope through a query filter, act on another
  kiosk's job, read anybody else's audit rows, or retire a colleague's key;
- no readable route returns a forbidden field, a pepper, a connection string, a
  customer's filename or a content digest;
- the documents route returns no document identity at all;
- error bodies carry a code, a message and a request id, and nothing else;
- every admin response is `no-store` and `application/json` with `nosniff`;
- nothing reflects caller text;
- all 13 evidence tables are migrator-owned with no disabled trigger;
- a real resolution, correction and refund authorization are written through the
  real routes, and then cannot be rewritten, deleted or truncated on the
  application's own credential;
- the read connection cannot write anything at all;
- a refusal is audited with the actor, the capability and the outcome;
- no audit row this suite wrote contains a document identity or free text;
- the audit log still reads when the page contains an unauthenticated event.

Role provisioning after the ownership transfer:

```
printing_kiosk_admin_reader:         privilege matrix verified.
printing_kiosk_admin_writer:         4 INSERT(s), no UPDATE, no DELETE.
printing_kiosk_admin_refund_writer:  3 INSERT(s), no UPDATE, no DELETE.
printing_kiosk_admin_people_writer:  9 updatable column(s) across 4 tables.
printing_kiosk_admin_pricing_writer: 3 updatable column(s) across 1 table.
printing_kiosk_migrator:             owns 13 tables (was 9).
```

`pnpm db:admin-owner verify` still reports the two known development failures —
the application role is a superuser and holds `BYPASSRLS` — which are properties
of the local Docker image and are now enforced against in production by §1.7.

---

## 4. Security review

### What this phase closes

The authorization policy and the route table are checked against each other, by
the route table rather than by a reading of the source. Every R2 endpoint is
proved to require a fresh assertion. Every mutating endpoint is proved to require
a CSRF token bound to its own session. An out-of-scope identifier is proved
indistinguishable from an absent one. No response carries a credential, a secret
or a customer's document, proved against canaries rather than against schemas.
The control plane's evidence tables can no longer have their triggers disabled by
the credential those triggers exist to constrain. And a production deployment
that would make all of that decoration now refuses to start.

### 4.1 Deviations, and what was deliberately not done

**No feature was added, and one capability was.** `operator.read` exists because
the roster's gate was an R2 capability, which is a defect rather than a design
(§4.2). Nothing else was built. This phase was the first where the temptation was
to find something to build instead of doing the review, and the review was the
work.

**The four dead capabilities were kept.** Deleting `kiosk.liveness.read`,
`kiosk.maintenance_mode`, `payment.mismatch.read` and `pricing.read` would change
the `capabilities` array every signed-in panel receives, which is shipped
behaviour, and Phase 0 named two of them as placeholders for features that were
planned. They are documented and asserted instead. §7 asks the owner.

**Admin is not separated from any route.** §1.2 states it rather than fixing it:
Admin holds every endpoint-gating capability, so the "no role is a superset"
property holds over capabilities and not over routes. Narrowing that would mean
inventing a capability an Admin does not hold, which would be a control invented
to satisfy a test.

**The XSS review is about the API, not the panel.** The control plane serves
JSON and renders nothing, so reflected XSS is tested as an absence of reflection
and of any content type that could be rendered. The admin app's CSP in production
is a property of whatever serves the built bundle, is unchanged, and is still the
open item §7 item 9 of the handoff describes.

**`services/api/scripts/` got a tsconfig of its own.** The benchmark is
TypeScript because it imports the real observability service, and the package's
own config emits `dist/` from `src/` with `rootDir` there — so the script was in
no project, which meant `pnpm typecheck` and `pnpm lint` both silently skipped
it. A TypeScript file nothing checks is worse than a `.mjs` one, because it looks
checked. Six lines of config, wired into both commands, and it found three real
errors in the script the first time it ran.

**The integration teardown still depends on the development superuser.** Deleting
from an append-only table needs its triggers suspended, which needs ownership or
superuser — and after this phase the application owns none of these tables. The
suites pass in development because the compose file runs the application as the
cluster's bootstrap superuser. That was already true of `admin_change_executions`
from Phase 5; it is now true of four more. It is not a production concern, since
tests do not run there, but it does mean the teardown is not a demonstration that
the application could clean up after itself.

**The benchmark leaves its audit rows behind.** By design and unavoidably: it
writes one audit row per seeded session so that the audit read is measured
against a log the size a year of operation would make it, and `audit_events` is
append-only for every role in this system including its owner. `clean` says so
rather than pretending otherwise. Removing them means suspending the trigger as a
superuser, which is a deliberate act and is written out in §6.

### 4.2 Defects found and fixed

**The audit log returned a 500 whenever a failed sign-in was on the page.**
`observability.audit()` collects the actor ids of `ADMIN_USER` rows and looks
them up in `admin_users` to put a name beside each. But an admin event written
before anybody was authenticated — a failed sign-in, a consumed break-glass code
— carries `ANONYMOUS_ADMIN_ACTOR_ID`, the literal string `anonymous`, and
`admin_users.id` is a UUID column. PostgreSQL refuses the whole query with
`22P02`, so one such row made the entire audit page fail.

Read the failure mode rather than the fix: **the audit log became unreadable
exactly when something worth investigating had just happened.** An attacker
probing sign-in would have blinded the screen kept to notice them, without
touching a single row.

It survived four phases because every test seeded its own clean audit rows and no
page in a suite ever contained an anonymous one. It was found by the Phase 6
benchmark, which was the first thing to read this table with real accumulated
history in it. Fixed by filtering to actor ids that are UUIDs before asking the
accounts table about them; the row still displays, with no name, which is what it
is. Regression test in the security suite.

**The People section stopped loading five minutes after sign-in.**
`GET /v1/admin/people` was gated on `authenticator.manage.operator`, which is
**R2** — so `authorizeAdmin` demanded a fresh WebAuthn assertion to read a
screen. Signing in stamps `lastStepUpAt`, and `ADMIN_STEP_UP_TTL_SECONDS`
defaults to 300, so the roster worked for five minutes and then answered
`401 ADMIN_STEP_UP_REQUIRED` — and `useAdminData` has no step-up branch, so the
panel rendered "Confirm with your security key to continue." as a dead end with
no roster and no way forward.

Phase 4B chose that capability deliberately and correctly for _who_ may see the
roster; what was not noticed is that risk class travels with a capability, so
reusing a mutating one to gate a read imported its ceremony. Fixed by adding
`operator.read` at R0, held by the same two roles, so the access boundary is
unchanged and the ceremony is gone. The general rule is now a test: **every GET
names an R0 capability**, which would have caught this the day it shipped.

**`admin-reader.mjs` granted on migrator-owned tables using the application
connection.** The same defect Phase 5 found and fixed in `admin-append-role.mjs`,
still present in the reader's own runner because it was written before the
ownership split and never revisited. GRANT requires ownership, the reader needs
SELECT on seven migrator-owned tables, and this worked only because development
runs the application as a superuser — so `pnpm db:admin-reader provision` would
have failed at deployment time in production, where the standing gate says that
role must **not** be a superuser. Fixed the same way: role management on
`DATABASE_URL`, every GRANT and REVOKE on `ADMIN_OWNER_DATABASE_URL`.

**The control plane's evidence tables were application-owned.** Carried as a
known gap since Phase 4 (§7 item 2 of the handoff) rather than discovered here,
and closed in §1.6.

### 4.3 Known gaps

**The panel has no step-up prompt on a read path.** `useAdminAction` handles
`ADMIN_STEP_UP_REQUIRED` and re-runs the action; `useAdminData` does not, and now
does not need to, because no read requires a step-up. If a future read is ever
gated on an R2 capability the panel will show a dead end again — which is why the
rule is a test rather than a note.

**Rate limits are asserted to exist, not to hold under contention.** The suite
exercises the limiter's key separation implicitly by making several hundred
requests without tripping the wrong bucket, but there is no test that a stolen
session exhausts its own allowance and not a colleague's. That property is
argued for in `http.ts` and unproven.

**The benchmark measures a single client against an idle database.** It answers
"are these queries fast" and not "what do they cost the print path while a kiosk
is quoting". The second question needs concurrent load from both sides, and the
honest thing is to say that this measured the first one. The mitigations for the
second — a separate pool of four connections, `statement_timeout=5s`,
`lock_timeout=2s` — are unchanged and untested under contention.

**Nothing tests the production superuser gate.** It refuses to start when
`NODE_ENV=production` and the role is privileged, and asserting that would mean
either running the suite in production mode against a superuser database or
creating an ordinary role in the test environment. Both are more machinery than
the branch is worth; the branch is four lines and fails closed.

### Deliberately absent

No new operational surface. No capability that reaches a document, a credential,
a shell or a kiosk secret. No second-approver workflow. No change to the session
state machine, the print settlement table, the cleanup checkpoint order, the
agent pull model or any existing trigger.

---

## 5. Printing performance impact

**None on the print path.** Nothing in this phase touches the kiosk, the agent,
the quote path or the application's connection. The production boot check is one
`pg_roles` query at startup.

The measurement Phase 0 §17 asked for, taken at 50,074 sessions, 50,005 print
jobs, 200,754 session events and 120,347 audit rows — roughly a year of six
kiosks at forty sessions a day. Twenty runs each, on the admin read role:

| Read             | Admin p50 | Admin p95  | Operator p50 | Operator p95 |
| ---------------- | --------- | ---------- | ------------ | ------------ |
| overview         | 5.3ms     | 7.3ms      | 2.7ms        | 3.3ms        |
| kiosks           | 1.9ms     | 2.8ms      | 1.1ms        | 1.3ms        |
| sessions         | 9.8ms     | 10.7ms     | 1.3ms        | 1.5ms        |
| session detail   | 1.3ms     | 3.4ms      | 0.3ms        | 0.4ms        |
| timeline         | 0.6ms     | 3.1ms      | 0.3ms        | 0.3ms        |
| documents        | 0.6ms     | 2.0ms      | 0.3ms        | 0.3ms        |
| print jobs       | 7.3ms     | 8.9ms      | 1.0ms        | 1.9ms        |
| print job detail | 1.4ms     | 2.3ms      | 0.6ms        | 0.8ms        |
| payments         | 11.2ms    | **12.5ms** | 8.1ms        | 10.2ms       |
| refunds          | 1.0ms     | 1.1ms      | 1.0ms        | 1.3ms        |
| refund queue     | 2.9ms     | 7.3ms      | 3.2ms        | 3.5ms        |
| retention        | 3.8ms     | 9.0ms      | 4.1ms        | 4.6ms        |
| errors (24h)     | 5.6ms     | 7.9ms      | 5.2ms        | 6.8ms        |
| errors (168h)    | 6.0ms     | 7.2ms      | 5.8ms        | 7.7ms        |
| audit            | 4.2ms     | 4.5ms      | 6.6ms        | 7.3ms        |

The slowest read in the panel is 12.5ms at p95 against a 5-second statement
timeout — three orders of magnitude of headroom, and Phase 2's bounds are doing
what they were written to do.

Two observations worth recording rather than acting on. **Kiosk scoping is a
large win everywhere except payments**, where an Operator's read costs almost as
much as an Admin's (8.1ms against 11.2ms) because the scope reaches the kiosk
through a join on the session rather than through a column on the row. Every
other scoped read is five to thirty times cheaper. And **the error centre barely
notices its window**: 24 hours and 168 hours cost the same, because the window is
an index range and the ceiling on groups is what bounds the work.

Nothing here justifies an index. A payments read at 12.5ms performed by five
people is not a cost worth adding a write-path burden to reduce.

---

## 6. Setup

Nothing new is required to run the control plane. Two operator actions apply the
phase's database change, and both are the existing commands:

```bash
# 1. Move the evidence tables to the migrator role.
#    Run as a connection that can reassign ownership — the application role
#    while it still owns them, or a superuser.
ADMIN_OWNER_DATABASE_URL=$DATABASE_URL \
ADMIN_OWNER_DATABASE_PASSWORD=<the migrator's existing password> \
  pnpm db:admin-owner provision

# 2. Re-provision every least-privilege role. Their grants were issued by the
#    previous owner, and `verify` is what notices if one did not survive.
pnpm db:admin-reader provision        && pnpm db:admin-reader verify
pnpm db:admin-writer provision        && pnpm db:admin-writer verify
pnpm db:admin-refund-writer provision && pnpm db:admin-refund-writer verify
pnpm db:admin-people-writer provision && pnpm db:admin-people-writer verify
pnpm db:admin-pricing-writer provision && pnpm db:admin-pricing-writer verify
```

There is no migration in this phase: nothing about the schema changed, only who
owns four tables and what the application may do to them.

The benchmark, which is optional and development-only:

```bash
pnpm db:admin-benchmark seed --sessions 50000 --kiosks 6   # ~1 minute
pnpm db:admin-benchmark measure --iterations 20
pnpm db:admin-benchmark clean
```

`clean` removes every row it wrote except the audit events, which are append-only
for every role. To remove those as well, as a superuser and deliberately:

```sql
ALTER TABLE "audit_events" DISABLE TRIGGER USER;
DELETE FROM "audit_events" WHERE "actor_id" LIKE 'kiosk_bench_%';
ALTER TABLE "audit_events" ENABLE TRIGGER USER;
```

### Standing deployment gates

- **The production application role must not be a superuser.** Now enforced: the
  API and the worker refuse to start. This is no longer a note.
- **`ADMIN_PRICING_DATABASE_URL`, `ADMIN_REFUND_DATABASE_URL` and
  `ADMIN_PEOPLE_DATABASE_URL` are required in production**, unchanged. Without
  one the routes are not registered and the section is absent rather than broken.
- **`verify` fails on any undecided table**, so every migration forces every role
  to be re-provisioned before deploy. That is the mechanism, not a nuisance.
- **The admin app's production CSP is still undecided.** Handoff §7 item 9.

---

## 7. What remains

**For the owner.**

1. **The four capabilities that grant nothing.** `kiosk.liveness.read`,
   `kiosk.maintenance_mode`, `payment.mismatch.read` and `pricing.read`. Removing
   them shrinks the policy a reviewer has to hold in their head; keeping them
   documents an intent. Either is defensible and both are cheap — the test that
   enumerates them makes the decision explicit rather than urgent.
2. **How the built admin app is served in production**, and whether its security
   headers land on a `304`. Unchanged since Phase 4B and the one XSS-adjacent
   question this phase could not answer from the API side.

**For a later phase.**

3. **Concurrent load.** The benchmark measures the dashboard alone. "Does the
   dashboard degrade printing" is a two-sided question and only one side has been
   measured.
4. **A refund executor.** Obligations still accumulate at `PENDING`; nothing
   settles one, and no provider credential exists anywhere in the control plane.
   Unchanged since Phase 4A and now the largest missing piece of the money story.
5. **Withdrawing an authorized refund.** A correction changes the record and the
   obligation stands. Still open, still needs a design of its own.
6. **The panel replacement.** The business logic to preserve is in
   `ADMIN_PHASE_5_STATUS.md` §1.7, and this phase adds one more: no read may be
   gated on a capability that can change something.
