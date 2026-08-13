# Handoff — Admin Control Plane

For the next session. Read this, then `docs/ADMIN_PHASE_0.md` (the threat model
and the phase plan) and `docs/ADMIN_PHASE_5_STATUS.md` (what shipped last).

**State: Phases 0–5 complete, all checks green. The working tree has uncommitted
Phase 5 work awaiting the owner's commit. Phase 6 (hardening) is next and is
described in §8.**

> **Phase 5 was reshaped mid-flight by two owner decisions, and they change how
> to read the older documents.** Admin is the operational authority; Technical
> Admin is a support role and is not a co-approver of anything. And there is one
> Admin, so no workflow may wait for a second one — **nothing is classified R3**,
> and publishing a tariff is R2. `ADMIN_PHASE_0.md` §14, §15, §16, §19, §21, §22
> and §23 have been amended to match. Where an older phase document still
> describes a two-person or three-person approval, the code is right and the
> document is stale.

---

## 1. What this project is

An existing printing-kiosk monorepo (customer uploads from a phone → pays at a
kiosk → prints → documents are destroyed on a schedule). We are building a
separate **admin control plane** on top of it: a dashboard for Operators,
Admins and Technical Admins to see what the system is doing and to take a small,
deliberately constrained set of actions.

The owner is the product owner and makes the calls. The prevailing role for
Claude in this project is Senior Staff Engineer / Security Architect: the design
rationale in the phase docs is as much a deliverable as the code.

### Stack

pnpm + Turbo monorepo, Node ≥24, ESM everywhere, TypeScript 6 with
`exactOptionalPropertyTypes`, Zod 4 for contracts, Fastify 5 API, React 19 +
Vite 8 front ends, Prisma 7.9 + PostgreSQL 17, Redis, MinIO, ClamAV.

```
apps/       admin (the control plane UI), kiosk, mobile-upload
services/   api, worker, document-processor, kiosk-agent
packages/   admin-access, config, contracts, database, domain,
            file-processing, payment-adapters, pricing, printer-adapters
docs/       PHASE_*_STATUS.md (product), ADMIN_PHASE_*.md (control plane)
```

---

## 2. Standing constraints — do not violate, do not "improve"

These came from the owner verbatim across several sessions. They are the point
of the project, not preferences.

**The browser must never reach:** production or kiosk databases, Redis, queues,
printers, OS shells, document storage credentials, cloud provider APIs, payment
provider secrets, infrastructure management systems.

**Admin sees metadata and state, never document contents.** No uploaded document
previews, no raw downloads, no storage URLs, no storage credentials, no bytes.

**Never build:** SQL console, shell console, arbitrary script runner, arbitrary
internal function caller, generic printer/terminal/Redis/queue console,
environment variable browser, secrets viewer.

**Audit:** no document contents, secrets, payment secrets or credentials inside
audit events. Normal Admins cannot delete or rewrite audit history (an
append-only trigger enforces it, and since Phase 4 the application role no
longer owns the table it protects).

**Authorization:** granular capabilities, never `if (role === "admin")`. Default
deny. Frontend visibility is _not_ authorization — the server refuses regardless
of what the UI draws, and every refusal is covered by a test. **No capability
anywhere changes an account's role**, and none may be added: creating an
identity and deciding what it is are CLI acts with a database credential behind
them.

**Blast radius assumption:** an attacker eventually compromises an Operator, an
Admin, and possibly one Technical Admin account. Design so that is survivable.

**Risk classes:** R0 read → R4. R1 safe and idempotent; R2 sensitive, requiring
a fresh WebAuthn assertion, a reason and an audit row with before and after; R4
permanently impossible from the panel.

**R3 means "no single account may do this alone", and nothing is classified R3.**
There is one Admin (§23.5 of `ADMIN_PHASE_0.md`), so such a rule would be a
stoppage rather than a control. The class is kept and `authorizeAdmin` still
refuses every R3 capability outright, so classifying something R3 later fails the
endpoint closed rather than letting one account perform it quietly. Do not
reintroduce a second-approver workflow without the owner asking for one.

**Dependencies:** avoid unnecessary ones, justify every significant one in the
phase doc. The whole control plane has added exactly one runtime dependency so
far (`@simplewebauthn/server`, justified in `ADMIN_PHASE_0.md` §13.1). Phases 3,
4, 4B and 5 added none.

**The UI is temporary and will be replaced.** Keep panel work minimal and
functional; do not invest in visual polish, layout refinement or reusable UI
architecture. Put the effort into backend behaviour, permissions, security
boundaries, auditability and tests, and keep the panels simple enough to replace
without losing business logic.

**Break-glass codes are never written to a file.** Print, seal, store offline.
Do not put one in a doc, a commit, a test fixture, or this handoff.

### Decisions already made

Three gating decisions in §23 of `ADMIN_PHASE_0.md`: self-hosted WebAuthn/FIDO2
only; kiosk credential management excluded from the dashboard entirely;
`print.recovery.resolve` is Operator+ but split from `refund.authorize`.

Four more taken before Phase 4, recorded with their cost in
`ADMIN_PHASE_4_STATUS.md` §1: a fourth INSERT-only role for money; a chained
correction table; retention reads the observation rather than being signalled;
and a migration owner role for `audit_events` and the `admin_*` tables.

Three more before Phase 4B, in `ADMIN_PHASE_4B_STATUS.md` §1: a fifth role with
column-level UPDATE for people; a dashboard-issued enrolment ticket rather than
reusing break-glass; and kiosk assignment in the panel rather than the CLI. One
of them reverses a Phase 0 decision — Technical Admin holds
`authenticator.manage.operator` — and §14 and §19 were amended in Phase 5 to
match.

Two more during Phase 5, now in `ADMIN_PHASE_0.md` §23.4 and §23.5, and they
reach backwards further than any decision before them:

- **Admin is the operational authority. Technical Admin is support** —
  diagnostics, troubleshooting, recovery. Not a second operator, not a
  co-approver. Nothing routine requires both roles.
- **There is one Admin, so nothing may require two.** Nothing is classified R3.
  Publishing a tariff is R2: preview, confirm with a step-up assertion, execute
  atomically, record. Protection moved from prevention to evidence, and the
  evidence is enforced by the database. Reasoning and the accepted residual risk
  in `ADMIN_PHASE_5_STATUS.md` §4.1.

---

## 3. Architecture of the control plane

**`packages/admin-access`** — the shared contract package, the single source of
truth for both sides:

- `capabilities.ts` — `ADMIN_ROLES`, the flat `ADMIN_CAPABILITIES` list, and
  `ROLE_CAPABILITIES` (the whole authorization policy, as a table).
- `contracts.ts`, `observability.ts`, `operations.ts`, `sessions.ts`,
  `authenticators.ts`, `changes.ts` — Zod schemas for every request and
  response. `changes.ts` also holds `canonicalPricingPublishText`, which has a
  byte-identical twin in SQL: if they ever disagree, publishing fails closed.

**`services/api/src/modules/admin/`** — the server:

- `webauthn.ts`, `crypto.ts`, `service.ts` — enrolment, assertion, sessions,
  step-up, break-glass.
- `authorize.ts` — capability enforcement and Operator kiosk scoping.
- `audit.ts` — append-only audit writes, and the closed metadata allow-list.
- `read-database.ts`, `write-database.ts`, `refund-database.ts`,
  `people-database.ts`, `pricing-database.ts` — one narrowed pool each.
- `operations.ts` + `operations-routes.ts` — the four actions that cost nothing.
- `refunds.ts` + `refund-routes.ts` — the one that costs money, kept apart.
- `people.ts` + `people-routes.ts` — the five that change a person, kept apart
  again.
- `changes.ts` + `change-routes.ts` — the one that changes every future price.

**Five PostgreSQL roles for the panel, plus an owner role. All provisioned by
CLI, all verified by CLI:**

| Role                                  | URL                          | Privileges                                                         |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| application                           | `DATABASE_URL`               | the product                                                        |
| `printing_kiosk_admin_reader`         | `ADMIN_READ_DATABASE_URL`    | SELECT on an explicit allow-list                                   |
| `printing_kiosk_admin_writer`         | `ADMIN_WRITE_DATABASE_URL`   | INSERT on four tables, no UPDATE or DELETE anywhere                |
| `printing_kiosk_admin_refund_writer`  | `ADMIN_REFUND_DATABASE_URL`  | INSERT on `refunds`, its authorization record, and `audit_events`  |
| `printing_kiosk_admin_people_writer`  | `ADMIN_PEOPLE_DATABASE_URL`  | UPDATE on 9 named columns; never `admin_users.role`; no DELETE     |
| `printing_kiosk_admin_pricing_writer` | `ADMIN_PRICING_DATABASE_URL` | UPDATE on 3 columns of `pricing_rule_sets`; cannot read a quote    |
| `printing_kiosk_migrator`             | `ADMIN_OWNER_DATABASE_URL`   | owns `audit_events` and `admin_*`; runs migrations that alter them |

Each role is the outermost enforcement layer for one phase's gate: an Operator
cannot move money because _their connection has no grant on the money tables_;
the money connection cannot manufacture its own justification because _it has no
grant to record an observation_; nothing reachable from a browser promotes
anybody because _no connection holds UPDATE on `admin_users.role`_; and a tariff
cannot commit that no record accounts for because _a deferred trigger recomputes
its digest from the rows written and refuses at COMMIT_. Preserve all four.

The people and pricing roles are the only ones holding UPDATE at all, and both
hold it per _column_. They share `admin-column-role.mjs` for exactly that reason
— the shared `admin-append-role.mjs` asserts "no UPDATE anywhere", which is the
sentence the other roles are defined by. `provision` needs two connections:
`DATABASE_URL` can create a role and the migrator cannot, the migrator owns the
admin tables and the application no longer does.

> **Re-run `provision` and `verify` for all five least-privilege roles after
> every migration.** New tables are denied by default; `verify` is the thing
> that notices, and it has caught real regressions four times — including when
> re-applying the 4B migration dropped `admin_enrollment_tickets` and took the
> reader's grants with it.

**`apps/admin/`** — React 19, no router library. `App.tsx` holds an
`AdminDestination` in state and renders one section at a time;
`features/navigation.ts` is the navigation contract.

---

## 4. What is implemented

**Phase 1 — identity.** WebAuthn registration and assertion, multi-authenticator
enrolment, revocation, break-glass, revocable sessions, step-up, capability
enforcement, Operator kiosk scoping, audit immutability, the UI shell.

**Phase 2 — read-only observability.** Overview, kiosks, sessions + timeline,
printing, payments, documents/retention, error centre.

**Phase 3 — Operator tools.** `incident.acknowledge` (R1) and
`print.recovery.resolve` (R2): kiosk-scoped, eligibility revalidated
server-side, step-up required, the job id is the idempotency key, append-only.

**Phase 4A — money, corrections, retention.** Five actions exist in total now:

| Action                     | Risk | Who       | What it writes                            |
| -------------------------- | ---- | --------- | ----------------------------------------- |
| `incident.acknowledge`     | R1   | Operator+ | an audit event                            |
| `document.retention.retry` | R1   | Admin+    | a request the worker acts on              |
| `print.recovery.resolve`   | R2   | Operator+ | an observation                            |
| `print.recovery.correct`   | R2   | Admin+    | a correction superseding one              |
| `refund.authorize`         | R2   | Admin+    | an obligation at PENDING, on its own role |

Plus: the refund queue (which surfaces `UNRESOLVABLE` rather than dropping it),
the correction chain on the job detail, who authorized each obligation, and a
retention runner that shortens a resolved recovery's grace and re-arms runs a
person asked it to retry.

Nothing settles a refund. There is no provider credential anywhere in the panel.

**Phase 4B — people.** Five more actions, all R2, all on the people role:

| Action                                 | Capability                      | Who        | What it writes                       |
| -------------------------------------- | ------------------------------- | ---------- | ------------------------------------ |
| suspend / resume / disable an Operator | `operator.manage`               | Admin      | a status, and every session revoked  |
| assign or withdraw a kiosk             | `operator.manage`               | Admin      | `revoked_at`, never a delete         |
| sign an Operator out everywhere        | `operator.manage`               | Admin      | session revocations                  |
| retire an Operator's key               | `authenticator.manage.operator` | Admin + TA | a revocation, refused at the minimum |
| issue an enrolment ticket              | `authenticator.manage.operator` | Admin + TA | a 15-minute single-use authorisation |

Plus `GET /v1/admin/people` on the read pool, an **I have an enrolment code**
panel on the sign-in screen, and the Phase 4A styling gap closed.

Nothing here creates an account or changes a role — both stay CLI. A ticket can
only name an Operator that is still `PROVISIONING` with no usable key, which is
what stops it being a way to add a key to somebody's working identity.

**Phase 5 — the tariff.** One action, and the widest-reaching one in the panel:

| Action           | Capability        | Who   | What it writes                                                              |
| ---------------- | ----------------- | ----- | --------------------------------------------------------------------------- |
| publish a tariff | `pricing.publish` | Admin | a new tariff, the old one archived, and an append-only record of who did it |

Plus `POST /v1/admin/changes/preview` (writes nothing, prices four real jobs with
the same function the kiosk quotes with) and `GET /v1/admin/changes` (the log,
readable by Technical Admin too — diagnostics).

The guarantee is not a second signature. It is that a tariff cannot commit unless
a record accounts for it byte for byte: a deferred constraint trigger recomputes
the tariff's canonical digest from the rows actually written and refuses at
COMMIT. The record takes no UPDATE and no DELETE from any role, its own owner
included. Publishing requires echoing the digest the preview returned, so what is
published is what was reviewed.

---

## 5. Files worth knowing

| File                                                                                                                 | Why                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [capabilities.ts](packages/admin-access/src/capabilities.ts)                                                         | the authorization policy in full                  |
| [authorize.ts](services/api/src/modules/admin/authorize.ts)                                                          | where it is enforced                              |
| [operations.ts](services/api/src/modules/admin/operations.ts)                                                        | the four actions that cost nothing                |
| [refunds.ts](services/api/src/modules/admin/refunds.ts)                                                              | the one that costs money                          |
| [people.ts](services/api/src/modules/admin/people.ts)                                                                | the five that change a person                     |
| [changes.ts](services/api/src/modules/admin/changes.ts)                                                              | the one that changes every price                  |
| [changes.ts](packages/admin-access/src/changes.ts)                                                                   | the canonical digest, and why it is shaped so     |
| [admin-refund-writer-matrix.mjs](packages/database/scripts/admin-refund-writer-matrix.mjs)                           | why the money role is separate, as data           |
| [admin-people-writer-matrix.mjs](packages/database/scripts/admin-people-writer-matrix.mjs)                           | what may be changed about a person, as data       |
| [admin-pricing-writer-matrix.mjs](packages/database/scripts/admin-pricing-writer-matrix.mjs)                         | the only connection that can change a price       |
| [admin-owner.mjs](packages/database/scripts/admin-owner.mjs)                                                         | the audit log's owner, and the superuser check    |
| [migration.sql](packages/database/prisma/migrations/20260811020000_admin_phase4_money_and_corrections/migration.sql) | the deferred authorization trigger                |
| [migration.sql](packages/database/prisma/migrations/20260811030000_admin_phase4b_people_management/migration.sql)    | who an enrolment ticket may ever name             |
| [migration.sql](packages/database/prisma/migrations/20260812010000_admin_phase5_pricing_publication/migration.sql)   | the digest recomputed in SQL, checked at COMMIT   |
| [cleanup-session.ts](services/worker/src/jobs/cleanup-session.ts)                                                    | re-arm and grace shortening                       |
| [navigation.ts](apps/admin/src/features/navigation.ts)                                                               | sections, capabilities, drill-down destinations   |
| [api.ts](apps/admin/src/features/auth/api.ts)                                                                        | CSRF, timeouts, the two refusals, runtime parsing |
| [styles.css](apps/admin/src/styles.css)                                                                              | the whole design system                           |

**Design language:** warm orange accent on near-black / off-white, rounded
cards, dark left navigation rail, large light-weight numbers. The accent is
reserved for "somebody has to do something" — do not tint standing facts like
role names with it. `--accent-strong` is `#b04416`, chosen to clear WCAG AA
(4.5:1) against `--accent-soft` and the card background; check contrast before
changing it.

> Phase 4B closed the styling gap Phase 4A left, and added `.people*` and
> `.enrollment-ticket__code` in the same voice. The one new judgement worth
> knowing: a status pill is a standing fact and carries no accent, except
> "awaiting keys", which is somebody's job to finish.
>
> **Phase 5 deliberately did not extend the design system.** The owner has
> signalled that this UI is temporary and will be replaced, so `ChangesPanel.tsx`
> is a form and two tables with one new CSS rule. Two behaviours in it are
> business logic rather than styling and must survive the replacement: publishing
> is unavailable until the change has been priced out, and editing any field
> clears the preview.

---

## 6. Running it locally

```bash
pnpm infra:up                              # Postgres, Redis, MinIO, ClamAV, document-processor
pnpm --filter @printing-kiosk/api dev      # API on :3000
pnpm --filter @printing-kiosk/admin dev    # admin panel on :5175 (proxies /v1 to the API)
```

Docker infra was left up at the end of the last session; no Node process was
left running. To stop the panel: `lsof -ti tcp:5175 | xargs kill`.

`.env` (gitignored) needs `ADMIN_ORIGIN`, `ADMIN_SESSION_PEPPER`,
`ADMIN_BREAK_GLASS_PEPPER` (must differ), `ADMIN_WEBAUTHN_RP_ID=localhost`,
`ADMIN_WEBAUTHN_RP_NAME`, `ADMIN_READ_DATABASE_URL`, `ADMIN_WRITE_DATABASE_URL`,
`ADMIN_REFUND_DATABASE_URL`, `ADMIN_PEOPLE_DATABASE_URL`,
`ADMIN_OWNER_DATABASE_URL`. All six roles are provisioned in the local database
already.

Account CLI: `pnpm db:admin <create|list|break-glass|revoke-break-glass|suspend|resume|disable>`.
Role CLIs: `pnpm db:admin-reader`, `db:admin-writer`, `db:admin-refund-writer`,
`db:admin-people-writer` (each `provision|verify|disable`) and
`pnpm db:admin-owner <provision|verify>`.
Migrations that alter `audit_events` or `admin_*`: `pnpm db:migrate:owner`.

Onboarding an Operator end to end: `pnpm db:admin create --role OPERATOR ...`,
then **People → Issue an enrolment code** in the panel (read it out, do not send
it), then the person enters it at sign-in twice for two keys, then **People →
Kiosks**. The panel cannot create an account and cannot change a role.

Checks before any commit: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`,
plus `pnpm test:integration` for anything touching the admin plane.

### The Touch ID situation — expect this question again

The owner's account (`Raf`) is `TECHNICAL_ADMIN`. That role requires
**cross-platform, non-backup-eligible** authenticators, which Touch ID is not.
With no hardware FIDO2 key on this Mac, the only thing that satisfies it is a
Chrome DevTools **virtual authenticator**, which is destroyed when DevTools or
the browser closes — so every browser session costs one break-glass code. Four
codes have been burned this way; one unconsumed code (labelled "virtual key E")
is held by the owner offline and is valid ~90 days from 2026-08-09.

Note the failure mode that burned one: break-glass **consumes the code at the
start** of the ceremony, so if `navigator.credentials.create()` never completes
(no virtual authenticator present), the code is spent with nothing enrolled.

The durable fix is a second **`ADMIN`** account, where Touch ID is acceptable
and persists. This has been offered and not taken up; offer it once, then drop it.

---

## 7. Known bugs and gaps

Full detail in `docs/ADMIN_PHASE_4_STATUS.md` §4.3 and
`docs/ADMIN_PHASE_4B_STATUS.md` §4.3. The ones that will bite:

1. **The application role is a superuser in development**, so Phase 4's
   ownership separation is ineffective there and `pnpm db:admin-owner verify`
   fails by design saying exactly that. **Production must run the application as
   an ordinary role** or the audit-integrity work does not hold there either.
2. **The control plane's own evidence tables are still application-owned.**
   `print_job_recovery_resolutions` and the three Phase 4 tables keep their
   append-only triggers, but the application role could disable them. Left out
   of the transfer deliberately — the integration teardown suspends those
   triggers — and worth revisiting with the teardown.
3. **A correction cannot withdraw an authorized refund.** The record changes and
   the obligation stands. Phase 5 was expected to solve this with an approval
   workflow; there is no such workflow now, so it is simply open — reversing an
   authorized obligation needs a design of its own.
4. **Nothing settles a refund.** Obligations accumulate at `PENDING`; the
   executor that talks to the payment provider does not exist.
5. **The refund queue's page can be short** — filtering to the effective outcome
   happens after the page is fetched. Totals are exact; page length varies.
6. **The overview cache is per process.** Two operators can see counts up to five
   seconds apart.
7. **A Technical Admin can now act as an Operator it onboarded.** New in 4B and
   the owner's explicit call: it holds `authenticator.manage.operator`, so it can
   put a key it controls on a provisioning Operator account. It gains no
   capability by doing so and still cannot suspend anybody or move a kiosk
   assignment, but it gains a second name to act under. Both halves are audited
   and outstanding tickets are visible on the roster.
8. **An enrolment ticket cannot be withdrawn.** Issued by mistake, it expires in
   fifteen minutes and there is no button. A `revoked_at` column and a fourth
   route away if that turns out to matter.
9. **Production has an unfixed 304 blind spot.** In dev this was a real bug: the
   CSP header was set via `server.headers`, which Vite does not apply to `304 Not
Modified`, and `index.html`'s ETag never changes when only a header changes —
   so Chrome served a stale policy through reloads and browser restarts, and the
   dashboard rendered unstyled. Fixed by moving headers into middleware
   (`alwaysSendSecurityHeaders`) so they land on every status. **Whatever serves
   the built admin app in production will have the same bug** if its headers are
   attached to the static-file handler rather than set unconditionally. Decide
   this before deploying.

Two small improvements were offered in an earlier session and never approved —
take them or drop them: a test that clicks an attention row and asserts the
outgoing query string, and better break-glass failure copy ("This code has
already been used…" / "The code was spent but no key was enrolled.").

---

## 8. Do this next — Phase 6

**Phase 6 = hardening.** `ADMIN_PHASE_0.md` §22 row 6, and its gate is that a
security test suite is green: authorization matrix review per endpoint, IDOR,
CSRF, XSS, secret leakage, query performance, audit integrity.

Every operational surface the plan called for now exists. Phase 6 is the first
one that adds no feature, which makes it the first where the temptation is to
find something to build instead. Resist that: the list above is the work.

Where to start, in the order that finds the most:

1. **The authorization matrix, endpoint by endpoint.** There are six capability
   families and roughly forty routes. The question for each is not "does it call
   `authorizeAdmin`" — they all do — but "is the capability it names the one a
   reader would expect from the URL", and "does anything it returns exceed what
   that capability is for". `capabilities.ts` is the policy; the routes are the
   claim; nothing has yet checked them against each other systematically.
2. **Audit integrity end to end.** `audit_events` rejects UPDATE and DELETE by
   trigger and is migrator-owned. The gap in §7 item 2 is the rest: the control
   plane's own evidence tables are still application-owned, so an application
   role that is a superuser could disable their triggers. Same root cause as
   item 1, and worth closing together.
3. **The superuser question in §7 item 1.** Open for four phases. Until it is
   answered every ownership separation in the control plane is decoration in
   production — including Phase 5's publication record.
4. **Query performance under the admin read role.** Phase 2 bounded every query
   and Phase 0 §17 promised it would not degrade printing. Nothing has measured
   it against a database with realistic volume.

Two owner decisions are waiting, both in `ADMIN_PHASE_5_STATUS.md` §4.1:

- **Four Technical Admin capabilities** — `refund.authorize`,
  `print.recovery.correct`, `document.retention.retry`,
  `authenticator.manage.operator` — are operational rather than diagnostic and
  sit oddly with the support-role model. They were left unchanged because
  narrowing them changes shipped, tested behaviour. `refund.authorize` is the one
  worth removing: it moves money, and the support role's reason to hold it was
  the co-approver model that no longer exists.
- **Whether a second Admin account will ever exist.** If so, publishing a tariff
  is the one capability worth making a two-person act, and the digest machinery
  it would need is already in place.

Then follow the established rhythm: implement, prove the gate with integration
tests, write `docs/ADMIN_PHASE_6_STATUS.md` in the same voice as Phase 5 (what
was built, new dependencies and their justification, verification, security
review including deviations and known gaps, printing performance impact, setup,
what remains), and **let the owner make the commit** — that is the convention
here, one commit per phase.

### One trap worth knowing before touching the database

Every migration invalidates every role. `verify` fails on any table it has no
decision for, so after a migration each of the five least-privilege roles must be
re-provisioned before deploy. That is the mechanism working, not a nuisance — but
it does mean `pnpm db:migrate:owner` is never the last step.

And a migration must be applied as the owning role
(`ADMIN_OWNER_DATABASE_URL=... pnpm db:migrate:owner`). Applying it on the
application connection creates the tables with the wrong owner and no
`_prisma_migrations` row, and unpicking that by hand is an hour nobody enjoys.
