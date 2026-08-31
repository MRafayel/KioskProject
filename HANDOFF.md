# Handoff — Admin Control Plane

For the next session. Read this, then `docs/ADMIN_PHASE_0.md` (the threat model
and the phase plan) and `docs/ADMIN_PHASE_7_STATUS.md` (what shipped last).

**State: Phases 0–7 complete, all checks green. The working tree has uncommitted
Phase 6 and Phase 7 work awaiting the owner's commit. Every phase in the plan is
built; what comes next is a choice rather than a queue — see §8.**

> **Phase 7 replaced how people sign in, and it invalidates the identity half of
> every earlier document.** Authentication is now **username + Argon2id password
> for everybody, plus a WebAuthn key as a second factor for Admin and Technical
> Admin**. Inactivity **locks** a session rather than destroying it. Accounts are
> created by **invitation** from the panel, and recovered by an
> **administrator-issued reset code**. The Technical Admin device-bound key rule
> is **gone**, which is what ends the Touch ID problem below. Enrolment tickets
> are gone, subsumed by invitations. Where an older document says "WebAuthn is
> the only factor", the code is right and the document is stale —
> `ADMIN_PHASE_7_STATUS.md` is the current account.
>
> **Existing accounts have no password and cannot sign in until one is issued.**
> See `ADMIN_PHASE_7_STATUS.md` §6 before doing anything else with a deployment.

> **Two owner decisions in Phase 5 changed how to read the older documents.**
> Admin is the operational authority; Technical Admin is a support role and is
> not a co-approver of anything. And there is one Admin, so no workflow may wait
> for a second one — **nothing is classified R3**, and publishing a tariff is R2.
> `ADMIN_PHASE_0.md` §14, §15, §16, §19, §21, §22 and §23 have been amended to
> match. Where an older phase document still describes a two-person or
> three-person approval, the code is right and the document is stale.
>
> **Two more were taken in Phase 6, and one of them narrows a role.** Technical
> Admin no longer holds `refund.authorize` — exactly one role can move money now.
> And there will be one Admin permanently, which closes the last question Phase 5
> left open. `ADMIN_PHASE_0.md` §23.6 is new.

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
anywhere changes an account's role**, and none may be added.

Phase 7 narrowed that last sentence rather than breaking it. Creating an
identity is now a panel act — an invitation, behind `invitation.manage`, a
step-up ceremony and a role matrix that stops an Admin minting a peer. Deciding
what an existing account _is_ remains impossible from anywhere: no connection
reachable from a browser holds UPDATE on `admin_users.role`, and an invitation
fixes the role at creation.

**Since Phase 6, two rules about routes are enforced by a test rather than by
review.** Every admin route must appear in the `ENDPOINTS` table in
`tests/integration/admin-security.test.ts` with the capability it names — adding
a route without classifying it fails the suite. And **every GET must name an R0
capability**: gating a read on a capability that can change something imports its
step-up ceremony, which is how the People section came to demand a security key
to display a list.

**Blast radius assumption:** an attacker eventually compromises an Operator, an
Admin, and possibly one Technical Admin account. Design so that is survivable.

**Risk classes:** R0 read → R4. R1 safe and idempotent; R2 sensitive, requiring
a fresh strong reauthentication, a reason and an audit row with before and
after; R4 permanently impossible from the panel. Since Phase 7 "strong" follows
the role: a WebAuthn assertion for Admin and Technical Admin, the password for
an Operator, who holds nothing stronger. A privileged account cannot satisfy a
step-up with its password.

**R3 means "no single account may do this alone", and nothing is classified R3.**
There is one Admin (§23.5 of `ADMIN_PHASE_0.md`), so such a rule would be a
stoppage rather than a control. The class is kept and `authorizeAdmin` still
refuses every R3 capability outright, so classifying something R3 later fails the
endpoint closed rather than letting one account perform it quietly. Do not
reintroduce a second-approver workflow without the owner asking for one.

**Dependencies:** avoid unnecessary ones, justify every significant one in the
phase doc. The whole control plane has added exactly one runtime dependency so
far (`@simplewebauthn/server`, justified in `ADMIN_PHASE_0.md` §13.1). Phases 3
through 7 added none — Phase 7's Argon2id is `node:crypto` in Node 24, which is
why password hashing cost nothing.

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

Two more in Phase 6, in `ADMIN_PHASE_0.md` §23.5 and §23.6:

- **Technical Admin cannot move money.** `refund.authorize` was removed from it —
  granted in Phase 4 under the co-approver model that no longer exists. The other
  three capabilities Phase 5 flagged were kept deliberately: correcting an
  observation and retrying retention are recovery work that must not wait for an
  Admin at 03:00, and none of the three can cause a payout.
- **One Admin, permanently.** The question Phase 5 left open is now closed rather
  than carried. Nothing waits for a second account; the R3 branch stays as a
  fail-closed backstop rather than as a workflow anybody intends to use.

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

| Role                                  | URL                          | Privileges                                                        |
| ------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| application                           | `DATABASE_URL`               | the product                                                       |
| `printing_kiosk_admin_reader`         | `ADMIN_READ_DATABASE_URL`    | SELECT on an explicit allow-list                                  |
| `printing_kiosk_admin_writer`         | `ADMIN_WRITE_DATABASE_URL`   | INSERT on four tables, no UPDATE or DELETE anywhere               |
| `printing_kiosk_admin_refund_writer`  | `ADMIN_REFUND_DATABASE_URL`  | INSERT on `refunds`, its authorization record, and `audit_events` |
| `printing_kiosk_admin_people_writer`  | `ADMIN_PEOPLE_DATABASE_URL`  | UPDATE on 9 named columns; never `admin_users.role`; no DELETE    |
| `printing_kiosk_admin_pricing_writer` | `ADMIN_PRICING_DATABASE_URL` | UPDATE on 3 columns of `pricing_rule_sets`; cannot read a quote   |
| `printing_kiosk_migrator`             | `ADMIN_OWNER_DATABASE_URL`   | owns `audit_events`, `admin_*` and the four evidence tables       |

Each role is the outermost enforcement layer for one phase's gate: an Operator
cannot move money because _their connection has no grant on the money tables_;
the money connection cannot manufacture its own justification because _it has no
grant to record an observation_; nothing reachable from a browser promotes
anybody because _no connection holds UPDATE on `admin_users.role`_; and a tariff
cannot commit that no record accounts for because _a deferred trigger recomputes
its digest from the rows written and refuses at COMMIT_. Preserve all four.

Since Phase 6 the migrator also owns `print_job_recovery_resolutions`,
`print_job_recovery_corrections`, `refund_authorizations` and
`cleanup_retry_requests`; Phase 7 added `admin_passwords`, `admin_invitations`
and `admin_password_resets`, and retired `admin_enrollment_tickets` — fifteen
tables in all. The application keeps SELECT
on those four and nothing else, so the credential the append-only triggers exist
to constrain can no longer switch them off. **In production the API and worker
now refuse to start if the application role is a superuser**, because under that
credential none of this holds.

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
| `refund.authorize`         | R2   | **Admin** | an obligation at PENDING, on its own role |

Plus: the refund queue (which surfaces `UNRESOLVABLE` rather than dropping it),
the correction chain on the job detail, who authorized each obligation, and a
retention runner that shortens a resolved recovery's grace and re-arms runs a
person asked it to retry.

Nothing settles a refund. There is no provider credential anywhere in the panel.
`refund.authorize` was Admin **and** Technical Admin until Phase 6; it is now
Admin only, and exactly one role in the system can cause a payout.

**Phase 4B — people.** Five more actions, all R2, all on the people role:

| Action                                 | Capability                      | Who        | What it writes                       |
| -------------------------------------- | ------------------------------- | ---------- | ------------------------------------ |
| suspend / resume / disable an Operator | `operator.manage`               | Admin      | a status, and every session revoked  |
| assign or withdraw a kiosk             | `operator.manage`               | Admin      | `revoked_at`, never a delete         |
| sign an Operator out everywhere        | `operator.manage`               | Admin      | session revocations                  |
| retire an Operator's key               | `authenticator.manage.operator` | Admin + TA | a revocation, refused at the minimum |

Plus `GET /v1/admin/people` on the read pool — gated on `authenticator.manage.
operator` until Phase 6 found that this made a screen demand a security key, and
on `operator.read` since — an **I have an enrolment code** panel on the sign-in
screen, and the Phase 4A styling gap closed.

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

**Phase 7 — authentication.** How somebody signs in, rebuilt. Full account in
`ADMIN_PHASE_7_STATUS.md`; the short version:

| Was                                  | Is                                                        |
| ------------------------------------ | --------------------------------------------------------- |
| WebAuthn only, no username           | username + Argon2id password; key as 2FA for Admin and TA |
| 15-minute idle → session destroyed   | idle **locks**; 6h/2h/1h by role, reopened by one reauth  |
| 4-hour absolute, all roles           | 30d/14d/7d by role — the only thing that ends a session   |
| TA keys must be device-bound roaming | any authenticator; Touch ID works and persists            |
| accounts by CLI, keys by ticket      | invitations from the panel, role matrix, audited          |
| lost key → sealed break-glass        | lost password → admin-issued reset; break-glass unchanged |

Three new tables (`admin_passwords`, `admin_invitations`,
`admin_password_resets`), all migrator-owned. Argon2id is `node:crypto` in Node
24, so **no new dependency**. `tests/integration/admin-authentication.test.ts`
is the phase gate: 17 tests, including the one that would have caught the
original defect — logging out leaves every credential exactly where it was.

**Phase 6 — hardening.** No new operational surface. What it produced instead:

- `tests/integration/admin-security.test.ts`, the phase gate. 52 tests, most of
  them asked of **every route the app registered** rather than of a sample. It
  declares all 43 admin routes with the capability each names and asserts that
  set equals Fastify's own route table, then drives the authorization, step-up,
  CSRF and authentication sweeps from that one declaration.
- The four evidence tables moved to the migrator role (§3), closing the gap
  Phase 4 left open.
- A production boot check: the API and worker refuse to start if the application
  role is a superuser. That gate had been documented and unenforced for four
  phases.
- `pnpm db:admin-benchmark`, and the first measurement of the admin reads at
  volume: 50,000 sessions, slowest read 12.5ms at p95 against a 5s timeout.
- Four defects fixed, all live. `ADMIN_PHASE_6_STATUS.md` §4.2.

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
| [admin-owner.mjs](packages/database/scripts/admin-owner.mjs)                                                         | who owns the evidence, and the superuser check    |
| [admin-security.test.ts](tests/integration/admin-security.test.ts)                                                   | the authorization matrix, and the Phase 6 gate    |
| [authentication.ts](packages/admin-access/src/authentication.ts)                                                     | which roles need a key, who may invite and reset  |
| [passwords.ts](services/api/src/modules/admin/passwords.ts)                                                          | Argon2id on the runtime's own implementation      |
| [admin-authentication.test.ts](tests/integration/admin-authentication.test.ts)                                       | the Phase 7 gate: login, lock, unlock, step-up    |
| [migration.sql](packages/database/prisma/migrations/20260824010000_admin_password_authentication/migration.sql)      | passwords, invitations, resets, and what retired  |
| [admin-read-benchmark.ts](services/api/scripts/admin-read-benchmark.ts)                                              | what the dashboard costs at volume                |
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
already. Phase 7's session-window and one-time-grant settings all have defaults
(`ADMIN_PHASE_7_STATUS.md` §6); `ADMIN_SESSION_IDLE_MINUTES` and
`ADMIN_SESSION_ABSOLUTE_MINUTES` no longer exist.

The role provisioning scripts read a password from a `*_PASSWORD` variable
rather than from the connection URL — `ADMIN_OWNER_DATABASE_PASSWORD`,
`ADMIN_READ_DATABASE_PASSWORD` and so on. They are not in `.env`; extract them
from the matching URL when re-provisioning. `admin-owner.mjs provision` also has
to run on a connection that may `ALTER ROLE`, which the migrator itself may not,
so point `ADMIN_OWNER_DATABASE_URL` at `DATABASE_URL` for that one command.

Account CLI: `pnpm db:admin <bootstrap-technical-admin|create|invite|reset-password|
set-username|list|break-glass|revoke-break-glass|suspend|resume|disable>`.
Role CLIs: `pnpm db:admin-reader`, `db:admin-writer`, `db:admin-refund-writer`,
`db:admin-people-writer`, `db:admin-pricing-writer` (each
`provision|verify|disable`) and `pnpm db:admin-owner <provision|verify>`.
Migrations that alter a migrator-owned table: `pnpm db:migrate:owner`.
Read performance: `pnpm db:admin-benchmark <seed|measure|clean>` — development
only, refuses a non-loopback database, and `clean` cannot remove the audit rows
it wrote because the log is append-only for everybody.

Onboarding an Operator end to end, since Phase 7: **People → Invite somebody**
in the panel — name, username, role, reason — then hand over the code it shows
once (read it out, do not send it). They enter it at sign-in under "I have an
invitation code", set a password, and are active. Then **People → Kiosks**.
A privileged invitation adds one step: they enrol a security key before the
account activates. The panel still cannot change a role; nothing anywhere can.

The CLI does the same for a system with nobody in it yet:
`pnpm db:admin bootstrap-technical-admin --name "Ada" --username ada`, which
refuses to run while a working Technical Admin exists.

Checks before any commit: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`,
plus `pnpm test:integration` for anything touching the admin plane.

### The Touch ID situation — resolved in Phase 7

**This is fixed and the question should not come back.** The Technical Admin
device-bound key rule is gone: with a password as the first factor, Touch ID is
an acceptable second factor for every role, and it persists across browser
restarts. No more virtual authenticators, and no more break-glass codes spent on
what were effectively browser restarts.

Kept for the record, because it explains four spent envelopes: the role used to
require **cross-platform, non-backup-eligible** authenticators, which Touch ID is
not, so on a Mac with no hardware FIDO2 key the only thing satisfying it was a
Chrome DevTools virtual authenticator — destroyed when the browser closed. One
unconsumed code (labelled "virtual key E") is held by the owner offline and is
valid ~90 days from 2026-08-09; it still works, for its actual purpose, which is
an account that has lost every key.

Note the failure mode that burned one, because break-glass still behaves this
way: it **consumes the code at the start** of the ceremony, so if
`navigator.credentials.create()` never completes the code is spent with nothing
enrolled. Invitations deliberately do not — see `ADMIN_PHASE_7_STATUS.md` §1.5.

---

## 7. Known bugs and gaps

Full detail in `docs/ADMIN_PHASE_6_STATUS.md` §4.3, `ADMIN_PHASE_4_STATUS.md`
§4.3 and `ADMIN_PHASE_4B_STATUS.md` §4.3. The ones that will bite:

1. ~~The application role is a superuser in development.~~ **Closed in Phase 6**
   as far as code can close it. It is still a superuser locally — that is the
   Docker image, and `pnpm db:admin-owner verify` still reports it by design —
   but the API and the worker now **refuse to start in production** if the role
   they connect as holds `rolsuper` or `rolbypassrls`. The gate is enforced
   rather than documented.
2. ~~The control plane's evidence tables are application-owned.~~ **Closed in
   Phase 6.** All four moved to the migrator role; the application keeps SELECT
   and nothing else. Note the consequence: the integration teardowns suspend
   those triggers to delete, which now works only because development runs the
   application as a superuser. That is not a production concern — tests do not
   run there — but the teardown is no longer a demonstration that the
   application could clean up after itself.
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
8. ~~An enrolment ticket cannot be withdrawn.~~ **Closed in Phase 7** by
   deleting the feature. Invitations replaced tickets and are revocable from the
   panel, as are password resets; issuing a fresh invitation revokes the
   outstanding one in the same transaction.
9. **Production has an unfixed 304 blind spot.** In dev this was a real bug: the
   CSP header was set via `server.headers`, which Vite does not apply to `304 Not
Modified`, and `index.html`'s ETag never changes when only a header changes —
   so Chrome served a stale policy through reloads and browser restarts, and the
   dashboard rendered unstyled. Fixed by moving headers into middleware
   (`alwaysSendSecurityHeaders`) so they land on every status. **Whatever serves
   the built admin app in production will have the same bug** if its headers are
   attached to the static-file handler rather than set unconditionally. Decide
   this before deploying. Phase 6 tested the API's own headers and could not
   answer this one; it is the last XSS-adjacent question open.
10. **Four capabilities grant nothing.** `kiosk.liveness.read`,
    `kiosk.maintenance_mode`, `payment.mismatch.read` and `pricing.read` gate no
    endpoint and widen no response — Phase 0 declared them ahead of features
    nobody built. Harmless, and misleading to a reviewer reading
    `ROLE_CAPABILITIES`. They are enumerated with a reason each in
    `admin-security.test.ts`, asserted in both directions. Delete or implement;
    the owner's call.
11. **The read benchmark measures one client against an idle database.** It
    answers "are these queries fast" (they are — 12.5ms at p95 on 50,000
    sessions) and not "what do they cost the print path while a kiosk is
    quoting". The second question needs load from both sides at once.
12. **Six device-plane integration tests fail, and did before Phase 7.**
    `device-plane.test.ts`, all about `approvedQueues`. Verified by stashing the
    Phase 7 work and re-running: identical failures on a clean checkout. They
    belong to the uncommitted device work, not to the control plane.
13. **`pnpm format:check` fails on 25 files nobody in Phase 7 touched** — the
    device, telemetry and kiosk-agent work. Phase 7's own files are formatted.
    Run Prettier over the rest when that work is picked up.
14. **Existing admin accounts have no password after the Phase 7 migration**, so
    nobody can sign in until one is issued. `ADMIN_PHASE_7_STATUS.md` §6 is the
    procedure. This is the first thing to do on any deployment.

Two small improvements were offered in an earlier session and never approved —
take them or drop them: a test that clicks an attention row and asserts the
outgoing query string, and better break-glass failure copy ("This code has
already been used…" / "The code was spent but no key was enrolled.").

---

## 8. Do this next

**The phase plan is finished, and Phase 7 was the first phase from outside it** —
the owner asked for it directly rather than it coming off `ADMIN_PHASE_0.md` §22.
Expect the same again: the next session starts with a choice, not a list. Put it
to the owner before building anything.

**Before anything else, give the existing accounts passwords** (§7 item 14). It
is not a phase, it is five minutes with the CLI, and nobody can sign in until it
is done.

The honest ranking of what is left, with the reason each earns its place:

1. **Nothing settles a refund** (§7 item 4). This is the largest hole left in the
   product, not just in the control plane: obligations have been accumulating at
   `PENDING` since Phase 4A and there is no executor. It needs a provider
   credential, which nothing in the admin plane has or should have — so it is a
   worker, not a panel, and its design is a phase of its own. Note what it
   unblocks: §7 item 3, withdrawing an authorized refund, is easier to reason
   about once something can settle one.
2. **Decide how the built admin app is served** (§7 item 9). The last
   security question this repository cannot answer for itself, and the only one
   that blocks a deployment rather than a feature.
3. **Concurrent load** (§7 item 11). Phase 6 proved the dashboard is fast; Phase 0
   §17's promise was that it would not degrade printing, and only one side of
   that has been measured.
4. **The panel replacement** the owner has signalled. The business logic to
   preserve is in `ADMIN_PHASE_5_STATUS.md` §1.7, plus one rule Phase 6 added: no
   read may be gated on a capability that can change something.
5. **The four dead capabilities** (§7 item 10). Small, and worth doing while
   somebody is holding the authorization model in their head.
6. **Two questions Phase 7 left open rather than answered.** Whether an Operator
   should be able to enrol a security key at all — they can, and it does nothing
   for their sign-in — and whether break-glass should stop burning its code when
   the ceremony fails, which invitations now demonstrate is possible.

Whatever is chosen, follow the established rhythm: implement, prove the gate with
integration tests, write `docs/ADMIN_PHASE_8_STATUS.md` in the same voice (what
was built, new dependencies and their justification, verification, security
review including deviations and known gaps, printing performance impact, setup,
what remains), and **let the owner make the commit** — that is the convention
here, one commit per phase.

### The kiosk paper estimate is a count, not a ledger

It used to be `kiosk_paper_events`: every refill, correction and confirmed print
deduction appended a row, and the estimate was the sum of their signed deltas,
derived by an insert trigger under a per-kiosk advisory lock. Reading it meant
two queries and an aggregate over a table that only grew.

It is now one row per kiosk in `kiosk_paper_inventory` holding one number.
Reading it is a primary-key lookup. A refill increments it, a correction sets
it, a confirmed print subtracts from it under the row's own lock. There is no
trigger, no advisory lock and no history.

Three things about it are load-bearing and easy to undo by accident:

- **No row means untracked, and untracked is not zero.** A kiosk nobody has
  recorded paper for prints exactly as it did before this feature existed. The
  terminal, the admin panel and the API all have to keep telling those apart —
  reporting an untracked kiosk as zero would refuse customers at a full machine.
  This is why the application role holds `UPDATE` but **not** `INSERT` on the
  table: starting to track a kiosk is a person's decision.
- **`kiosk_paper_requests` is not history.** It records applied refill and
  correction keys so a retried request is not applied twice, and nothing reads
  it to work out the count. Rows are safe to prune by age. The admin reader is
  denied it outright.
- **Who changed the estimate lives in `audit_events`**, as it does for every
  other admin action. That is the only record now, so the audit write in
  `recordKioskPaperChange` is not optional bookkeeping.

The admin writer role gained a column-scoped `UPDATE` on that one table — the
number and the last refill printed beside it, not `kiosk_id` and not
`created_at`. It is the same shape of grant the people and pricing writers
already use, and `pnpm db:admin-writer verify` prints exactly which columns.

### Two traps worth knowing before touching the database

Every migration invalidates every role. `verify` fails on any table it has no
decision for, so after a migration each of the five least-privilege roles must be
re-provisioned before deploy. That is the mechanism working, not a nuisance — but
it does mean `pnpm db:migrate:owner` is never the last step.

And **the migrator now owns seventeen tables, not nine.** Any migration that
alters `print_job_recovery_resolutions`, `print_job_recovery_corrections`,
`refund_authorizations`, `cleanup_retry_requests`, `admin_passwords`,
`admin_invitations`, `admin_password_resets`, `kiosk_paper_inventory` or
`kiosk_paper_requests` has to run as the owner too,
and a role script that grants on one of them needs the owner connection — which
is the defect Phase 5 found in `admin-append-role.mjs` and Phase 6 found again in
`admin-reader.mjs`. If a third script is ever written, check which connection it
issues its GRANTs on before anything else.

And a migration must be applied as the owning role
(`ADMIN_OWNER_DATABASE_URL=... pnpm db:migrate:owner`). Applying it on the
application connection creates the tables with the wrong owner and no
`_prisma_migrations` row, and unpicking that by hand is an hour nobody enjoys.
