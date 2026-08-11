# Handoff — Admin Control Plane

For the next session. Read this, then `docs/ADMIN_PHASE_0.md` (the threat model
and the phase plan) and `docs/ADMIN_PHASE_4_STATUS.md` (what shipped last).

**State: Phases 0–4A complete, working tree has uncommitted Phase 4A work, all
checks green. Phase 4B (people management) is next and is described in §8.**

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
of what the UI draws, and every refusal is covered by a test.

**Blast radius assumption:** an attacker eventually compromises an Operator, an
Admin, and possibly one Technical Admin account. Design so that is survivable.

**Risk classes:** R0 read → R4. R3 = Technical Admin A proposes, a _different_
Technical Admin B approves, then an Admin approves. R4 is permanently impossible
from the panel.

**Dependencies:** avoid unnecessary ones, justify every significant one in the
phase doc. The whole control plane has added exactly one runtime dependency so
far (`@simplewebauthn/server`, justified in `ADMIN_PHASE_0.md` §13.1). Phases 3
and 4 added none.

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

---

## 3. Architecture of the control plane

**`packages/admin-access`** — the shared contract package, the single source of
truth for both sides:

- `capabilities.ts` — `ADMIN_ROLES`, the flat `ADMIN_CAPABILITIES` list, and
  `ROLE_CAPABILITIES` (the whole authorization policy, as a table).
- `contracts.ts`, `observability.ts`, `operations.ts`, `sessions.ts`,
  `authenticators.ts` — Zod schemas for every request and response.

**`services/api/src/modules/admin/`** — the server:

- `webauthn.ts`, `crypto.ts`, `service.ts` — enrolment, assertion, sessions,
  step-up, break-glass.
- `authorize.ts` — capability enforcement and Operator kiosk scoping.
- `audit.ts` — append-only audit writes, and the closed metadata allow-list.
- `read-database.ts` / `write-database.ts` / `refund-database.ts` — three pools.
- `operations.ts` + `operations-routes.ts` — the four actions that cost nothing.
- `refunds.ts` + `refund-routes.ts` — the one that costs money, kept apart.

**Four PostgreSQL roles for the panel, plus an owner role. All provisioned by
CLI, all verified by CLI:**

| Role                                 | URL                         | Privileges                                                         |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------ |
| application                          | `DATABASE_URL`              | the product                                                        |
| `printing_kiosk_admin_reader`        | `ADMIN_READ_DATABASE_URL`   | SELECT on an explicit allow-list                                   |
| `printing_kiosk_admin_writer`        | `ADMIN_WRITE_DATABASE_URL`  | INSERT on four tables, no UPDATE or DELETE anywhere                |
| `printing_kiosk_admin_refund_writer` | `ADMIN_REFUND_DATABASE_URL` | INSERT on `refunds`, its authorization record, and `audit_events`  |
| `printing_kiosk_migrator`            | `ADMIN_OWNER_DATABASE_URL`  | owns `audit_events` and `admin_*`; runs migrations that alter them |

The writer role is the outermost enforcement layer for Phase 3's gate, and the
refund role is Phase 4's: an Operator cannot move money because _their
connection has no grant on the money tables_, and the money connection cannot
manufacture its own justification because _it has no grant to record an
observation_. Preserve both properties.

> **Re-run `provision` and `verify` for the reader, the writer and the refund
> writer after every migration.** New tables are denied by default; `verify` is
> the thing that notices, and it has caught real regressions twice.

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

---

## 5. Files worth knowing

| File                                                                                                                 | Why                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [capabilities.ts](packages/admin-access/src/capabilities.ts)                                                         | the authorization policy in full                  |
| [authorize.ts](services/api/src/modules/admin/authorize.ts)                                                          | where it is enforced                              |
| [operations.ts](services/api/src/modules/admin/operations.ts)                                                        | the four actions that cost nothing                |
| [refunds.ts](services/api/src/modules/admin/refunds.ts)                                                              | the one that costs money                          |
| [admin-refund-writer-matrix.mjs](packages/database/scripts/admin-refund-writer-matrix.mjs)                           | why the money role is separate, as data           |
| [admin-owner.mjs](packages/database/scripts/admin-owner.mjs)                                                         | the audit log's owner, and the superuser check    |
| [migration.sql](packages/database/prisma/migrations/20260811020000_admin_phase4_money_and_corrections/migration.sql) | the deferred authorization trigger                |
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

> Phase 4A added markup that has no styling yet: `.refund-queue`,
> `.refund-queue__item`, `.refund-queue__account`, `.refund-queue__money`,
> `.resolution__correction`, `.resolution__superseded`, `.inline-form` and
> `.button-quiet`. They render and are usable, but they are unstyled — worth a
> pass in the same voice as the rest of the sheet.

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
`ADMIN_REFUND_DATABASE_URL`, `ADMIN_OWNER_DATABASE_URL`. All five roles are
provisioned in the local database already.

Account CLI: `pnpm db:admin <create|list|break-glass|revoke-break-glass|suspend|resume|disable>`.
Role CLIs: `pnpm db:admin-reader`, `db:admin-writer`, `db:admin-refund-writer`
(each `provision|verify|disable`) and `pnpm db:admin-owner <provision|verify>`.
Migrations that alter `audit_events` or `admin_*`: `pnpm db:migrate:owner`.

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

Full detail in `docs/ADMIN_PHASE_4_STATUS.md` §4.3. The ones that will bite:

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
   the obligation stands. Reversing a money decision is R3-shaped and belongs
   with Phase 5.
4. **Nothing settles a refund.** Obligations accumulate at `PENDING`; the
   executor that talks to the payment provider does not exist.
5. **The refund queue's page can be short** — filtering to the effective outcome
   happens after the page is fetched. Totals are exact; page length varies.
6. **The overview cache is per process.** Two operators can see counts up to five
   seconds apart.
7. **Production has an unfixed 304 blind spot.** In dev this was a real bug: the
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

## 8. Do this next — Phase 4B

**Phase 4B = the people half of Phase 4: Operator management and authenticator
management.** It was split out of Phase 4 rather than dropped, because it is
UPDATE-shaped work — suspend, resume, revoke a credential, revoke a session —
where everything shipped so far is append-only, and it deserves its own review
rather than riding along with money.

Three questions to settle first, listed with the shape the last phase suggests:

1. **Does the people role follow the same pattern?** A fifth role holding
   column-level UPDATE on `admin_users.status`, `admin_authenticators` and
   `admin_sessions`, and nothing at all on any product table. The precedent set
   in Phase 4 is that each new power gets its own narrow role, and column-level
   grants would keep "what can this connection change about a person" a grant
   list. Note this is the first role that would hold UPDATE at all.
2. **How does an Operator enrol a credential they do not yet have?** An Admin
   cannot enrol somebody else's authenticator — WebAuthn requires the person and
   the device — so `authenticator.manage.operator` needs an invitation flow, and
   that is new surface with its own threat model. It is the largest unknown in
   the phase.
3. **Is the production application role a superuser?** (§7 item 1.) Until that is
   answered, Phase 4's audit-integrity work does not hold in production, and
   4B's people tables are protected by the same mechanism.

Then follow the established rhythm: implement, prove the gate with integration
tests, write `docs/ADMIN_PHASE_4B_STATUS.md` in the same voice as Phase 4 (what
was built, new dependencies and their justification, verification, security
review including deviations and known gaps, printing performance impact, setup,
what remains), and **let the owner make the commit** — that is the convention
here, one commit per phase.

Phase 5 (Technical Admin + the R3 approval workflow) is also unblocked, and
inherits two shapes from Phase 4: the supersede record, and the deferred trigger
that makes a row's justification a condition of its existence.
