# Handoff — Admin Control Plane

For the next session. Read this, then `docs/ADMIN_PHASE_0.md` (the threat model
and the phase plan) and `docs/ADMIN_PHASE_6_STATUS.md` (what shipped last).

**State: Phases 0–6 complete, all checks green. The working tree has uncommitted
Phase 6 work awaiting the owner's commit. Every phase in the plan is now built;
what comes next is a choice rather than a queue — see §8.**

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
anywhere changes an account's role**, and none may be added: creating an
identity and deciding what it is are CLI acts with a database credential behind
them.

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
4, 4B, 5 and 6 added none.

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
`cleanup_retry_requests` — thirteen tables in all. The application keeps SELECT
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
| issue an enrolment ticket              | `authenticator.manage.operator` | Admin + TA | a 15-minute single-use authorisation |

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
already.

Account CLI: `pnpm db:admin <create|list|break-glass|revoke-break-glass|suspend|resume|disable>`.
Role CLIs: `pnpm db:admin-reader`, `db:admin-writer`, `db:admin-refund-writer`,
`db:admin-people-writer`, `db:admin-pricing-writer` (each
`provision|verify|disable`) and `pnpm db:admin-owner <provision|verify>`.
Migrations that alter a migrator-owned table: `pnpm db:migrate:owner`.
Read performance: `pnpm db:admin-benchmark <seed|measure|clean>` — development
only, refuses a non-loopback database, and `clean` cannot remove the audit rows
it wrote because the log is append-only for everybody.

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

Two small improvements were offered in an earlier session and never approved —
take them or drop them: a test that clicks an attention row and asserts the
outgoing query string, and better break-glass failure copy ("This code has
already been used…" / "The code was spent but no key was enrolled.").

---

## 8. Do this next

**The phase plan is finished.** `ADMIN_PHASE_0.md` §22 had six rows and all six
are built. There is no next phase queued, so the next session starts with a
choice rather than a list — which makes it the first session where "what should
we do" is a real question and not a formality. Put it to the owner before
building anything.

The honest ranking, with the reason each earns its place:

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

Whatever is chosen, follow the established rhythm: implement, prove the gate with
integration tests, write `docs/ADMIN_PHASE_7_STATUS.md` in the same voice (what
was built, new dependencies and their justification, verification, security
review including deviations and known gaps, printing performance impact, setup,
what remains), and **let the owner make the commit** — that is the convention
here, one commit per phase.

### Two traps worth knowing before touching the database

Every migration invalidates every role. `verify` fails on any table it has no
decision for, so after a migration each of the five least-privilege roles must be
re-provisioned before deploy. That is the mechanism working, not a nuisance — but
it does mean `pnpm db:migrate:owner` is never the last step.

And **the migrator now owns thirteen tables, not nine.** Any migration that
alters `print_job_recovery_resolutions`, `print_job_recovery_corrections`,
`refund_authorizations` or `cleanup_retry_requests` has to run as the owner too,
and a role script that grants on one of them needs the owner connection — which
is the defect Phase 5 found in `admin-append-role.mjs` and Phase 6 found again in
`admin-reader.mjs`. If a third script is ever written, check which connection it
issues its GRANTs on before anything else.

And a migration must be applied as the owning role
(`ADMIN_OWNER_DATABASE_URL=... pnpm db:migrate:owner`). Applying it on the
application connection creates the tables with the wrong owner and no
`_prisma_migrations` row, and unpicking that by hand is an hour nobody enjoys.
