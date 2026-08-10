# Admin Control Plane — Phase 0: discovery, analysis, and threat model

Status: analysis only. No implementation changes were made.

This document records what the repository actually contains as of commit
`28bba22`, traced from source rather than from the build plan. Where the build
plan and the code disagree, the code is reported. Proposals are marked as
proposals and are not implemented.

---

## 1. Actual architecture

### 1.1 Repository shape

A pnpm/Turbo TypeScript monorepo (Node ≥24, ESM, TypeScript 6, Zod 4) with
three tiers:

| Path                          | Runtime                                | Role                                                                                                                                                   |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/kiosk`                  | React 19 + Vite, port 5173             | Touchscreen UI. Talks to the local agent and the API.                                                                                                  |
| `apps/mobile-upload`          | React 19 + Vite, port 5174             | Phone upload page reached from the QR link.                                                                                                            |
| `services/api`                | Fastify 5, port 3000                   | The control plane. Owns PostgreSQL, owns the private bucket, owns all business rules.                                                                  |
| `services/worker`             | Node, no HTTP surface                  | Six background runners (§8).                                                                                                                           |
| `services/document-processor` | Fastify, port 3200, container-isolated | Malware scan, validation, normalization, previews. No network egress.                                                                                  |
| `services/kiosk-agent`        | Fastify, port 3100, **loopback-only**  | On-kiosk process. Owns the printer and the local spool.                                                                                                |
| `packages/*`                  | libraries                              | `config`, `contracts` (Zod), `database` (Prisma), `domain` (pure state machines), `file-processing`, `payment-adapters`, `pricing`, `printer-adapters` |

### 1.2 Infrastructure (`infrastructure/compose/dev.yml`)

PostgreSQL 17, Redis 7, MinIO (private, versioning suspended, lifecycle
backstop), ClamAV + a separate signature-freshness updater, the document
processor on an `internal: true` network, and a 60-line TCP gateway that exists
solely so the processor never gets an egress-capable interface.

Object storage uses **two separate credentials with distinct IAM policies**:
the API may `PutObject` only under `quarantine/v1/` and `GetObject` only under
`previews/v1/` and `normalized/v1/`; the worker may write normalized/previews
and delete under all three roots. Neither can read outside the three prefixes.

### 1.3 Deployment posture

Development-only today. There is no production deployment, no CI deploy
pipeline, no secret manager, no OIDC, and no telemetry stack. Secrets come from
a root `.env` validated by `packages/config` — which does enforce, in
production mode, that every secret is non-default and mutually distinct, that
origins are HTTPS, that Redis is TLS, that remote Postgres uses
`sslmode=verify-full`, and that the processor image is pinned by digest.

---

## 2. Actual print-session workflow

State machine: `packages/domain/src/session.ts`. Twelve states, transitions
guarded by an allow-list plus optimistic `stateVersion`.

```
CREATED → WAITING_FOR_UPLOAD → FILES_UPLOADED ⇄ CONFIGURING → AWAITING_PAYMENT → PAID → PRINTING
                                     ↑                              |
                                     └──────────────────────────────┘  (payment timeout)
                                                                    ↓
                                            COMPLETED | FAILED | RECOVERY_REQUIRED
```

`CANCELED` and `EXPIRED` are reachable from every pre-`PAID` state. Once `PAID`,
the only exit is `PRINTING`, and from `PRINTING` only the three settled states.
All five terminal states are `[]` — nothing leaves them. **A session is never
reopened, and no admin action can or should change that.**

Every transition writes a `SessionEvent` (sequenced per session) and an
`OutboxEvent`, in the same transaction as the state change.

---

## 3. Actual terminal / phone QR workflow

1. Kiosk `POST /v1/sessions` (scope `sessions:create`, `Idempotency-Key`
   required) → session plus a one-time upload grant.
2. Only digests are stored: `SessionUploadGrant.tokenDigest` and
   `shortCodeDigest`, peppered with `UPLOAD_TOKEN_PEPPER`. The raw token is
   returned once and lives only in the QR URL fragment.
3. Phone opens the link, `POST` exchanges the fragment token for a signed,
   `HttpOnly`, `SameSite` cookie bound to a `MobileClient` row
   (`cookieDigest`, `clientNonceDigest`). Grant is marked claimed —
   `@@unique([claimedClientId, sessionId])` makes it single-use.
4. Per-IP throttle on the exchange (`maxMobileExchangesPerMinute`).
5. Kiosk cancellation is pushed to the claimed phone over an authenticated
   stream; PostgreSQL stays authoritative and the phone re-reads state.

The phone never sees the kiosk credential. The kiosk never sees the phone
cookie. Neither is recoverable from the database.

---

## 4. Actual upload and processing flow

`UploadedFile.status`: `UPLOADING → QUARANTINED → VALIDATING → READY`, or
`REJECTED`; then `DELETE_PENDING → DELETING → DELETED`.

Upload streams into `quarantine/v1/<sessionId>/…` under a random key — **no
customer filename ever appears in an object key**. `displayName` is stored in
the row only.

Processing (`services/worker/src/jobs/process-document.ts` →
`services/document-processor`) leases a file row via
`processingClaimToken` / `processingLeaseExpiresAt`, then in the isolated
container: ClamAV scan → bounded validation → one-page-at-a-time normalization
to monochrome A4 PDF → WebP previews. Results land as `FileDerivative` rows
(`NORMALIZED_PDF`, `PAGE_PREVIEW`) plus `FilePage` rows. Only a fully verified
document becomes `READY`.

Concurrency is pinned to 1 by config (`DOCUMENT_PROCESSING_CONCURRENCY` max 1)
with an explicit comment that raising it before horizontal processor routing
exists only converts work into `PROCESSOR_BUSY` retries.

Failure surfaces as `processingErrorCode` (VarChar 80, a code — not a message,
not a stack) with `processingAttempts` and exponential `processingAvailableAt`.

---

## 5. Actual payment flow

Simulated end to end. `MockPaymentProvider`; no card data enters this system;
no money moves.

```
quote (immutable, TTL, manifestHash)
  → POST payment against one exact quote
  → Payment{status: PENDING}
  → signed provider callback (HMAC, timestamp tolerance)
  → PaymentWebhookInbox row written BEFORE acting
  → capture → session PAID
```

Guarantees that already exist, enforced in PostgreSQL, not just in TypeScript:

- `payments_match_their_quote` — a payment cannot exist for a price the control
  plane did not issue.
- `payments_status_is_monotonic` — status cannot go backwards.
- `payments_identity_is_immutable`.
- `payment_attempts_no_update` — append-only ledger.
- `payment_webhook_inbox_immutable_evidence` + `@@unique([provider, providerEventId])`
  — a duplicate delivery is acknowledged and ignored, never captured twice.
- `Payment.appliedToSession` distinguishes "this capture moved the session to
  PAID" from "captured late, therefore owed back."
- `Refund` is a compensation record with `@@unique([paymentId, reason])`; it
  never rewrites the capture.

`PaymentReconciler` (worker, 5s) settles payments past their deadline to
`TIMED_OUT` and returns the session to `CONFIGURING` with its price still live.
It explicitly **never invents a capture**: an intent the provider still reports
as live is left alone and recorded for an operator. That last clause is the
single clearest statement in the codebase that an operator surface is missing.

---

## 6. Actual printing flow

`PrintJob` is created only from a paid session, and the database enforces it
(`print_jobs_require_capture`). At most one per session
(`print_jobs_one_per_session_idx`). The manifest, counts, and money are frozen
at creation (`print_jobs_immutable_snapshot`); status is monotonic
(`print_jobs_status_is_monotonic`).

Dispatch is pull-based. The kiosk **opens no inbound port**. The agent polls
`POST /v1/agent/commands/claim` (scope `print-jobs:agent`), leases an
`AgentCommand` with a stable `operationId`, fetches the normalized PDF via
`GET /v1/agent/print-jobs/:id/documents/:docId` — which requires a _live lease
on that exact job_, verifies the manifest is the allow-list, checks size, MIME,
and prefix, and returns a `x-document-sha256` the agent verifies before
anything reaches a device — prints, then reports progress and result.

Settlement is `packages/domain/src/print-job.ts`, and it is the most important
piece of domain logic in the repository for operations:

| Device says                    | Confidence    | Sheets | Outcome             | Refund owed |
| ------------------------------ | ------------- | ------ | ------------------- | ----------- |
| COMPLETED                      | CONFIRMED     | >0     | `COMPLETED`         | no          |
| COMPLETED                      | anything else | —      | `RECOVERY_REQUIRED` | no          |
| NOT_SUBMITTED                  | CONFIRMED     | 0      | `FAILED`            | **yes**     |
| FAILED                         | CONFIRMED     | 0      | `FAILED`            | **yes**     |
| FAILED                         | UNCONFIRMED   | any    | `RECOVERY_REQUIRED` | no          |
| CANCELED                       | CONFIRMED     | 0      | `CANCELED`          | **yes**     |
| SUBMITTED / PRINTING / UNKNOWN | —             | —      | `RECOVERY_REQUIRED` | no          |

`RECOVERY_REQUIRED` means _a person must decide_. There is currently no person
surface. This is the primary operational gap the dashboard exists to fill.

---

## 7. Actual deletion / retention flow

Policy is pure and single-sourced: `packages/domain/src/retention.ts`.

Grace: `CANCELED`/`EXPIRED` = 0ms. `COMPLETED`/`FAILED` = 300s.
`RECOVERY_REQUIRED` = 900s.

`CleanupRun` is a resumable, leased workflow, not a row update. Ordered
checkpoints:

```
SCHEDULED → ACCESS_REVOKED → ARTIFACTS_DELETED → STORAGE_RECONCILED → METADATA_SCRUBBED → COMPLETED
```

Order is deliberate and documented: revoke access first so no new copy appears
behind the run; delete known artifacts before sweeping the prefix; scrub
relational metadata **last**, because a scrubbed row can no longer tell anyone
which object to delete.

Backstops:

- `print_sessions_documents_are_removed` — a trigger refuses to set
  `filesDeletedAt` unless the artifact ledger proves nothing is left.
- Retries with jittered exponential backoff, capped at 15 min, max 8 attempts.
- On exhaustion the run is **dead-lettered, never closed quietly** — the code
  says explicitly that the documents are still there and only the bucket
  lifecycle rule is still holding the line.
- `StorageReconciler` sweeps orphaned objects older than
  `RETENTION_ORPHAN_GRACE_SECONDS`, which config validation forces to exceed
  the longest possible session lifetime plus the longest grace.
- Redaction triggers strip per-document digests from
  `PrintSettingRevision.selections` and `PrintJob.jobManifest` once terminal,
  keeping the hash and the outcome as evidence while dropping which files it
  was.

`CleanupRun.status = DEAD_LETTER` and `PrintSession.cleanupStatus = DEAD_LETTER`
are written by the worker and **read by nobody**. There is no alert, no query,
no surface. Documented in `PHASE_9_STATUS.md:327` as intentional for the phase.

---

## 8. Background jobs and queues

Redis/BullMQ exists but is used narrowly. Most runners are `setInterval` loops
over PostgreSQL with `FOR UPDATE SKIP LOCKED` row leasing.

| Runner                          | Location        | Cadence               | Purpose                                                                                      |
| ------------------------------- | --------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `OutboxPublisher`               | worker          | continuous            | Transactional outbox → realtime                                                              |
| `DocumentProcessingCoordinator` | worker          | BullMQ, concurrency 1 | Processing                                                                                   |
| `PaymentReconciler`             | worker          | 5s                    | Settle expired payment windows                                                               |
| `PrintDispatcher`               | worker          | continuous            | Lease/redeliver print commands, deadline settlement                                          |
| `SessionCleanupRunner`          | worker          | 30s                   | Retention checkpoints                                                                        |
| `StorageReconciler`             | worker          | periodic              | Orphan object sweep                                                                          |
| `FileJanitor`                   | **API process** | interval              | Expire sessions, quotes, mobile clients; mark interrupted uploads; purge idempotency records |

Note `FileJanitor` runs inside the API, not the worker. Session expiry is
therefore coupled to API replicas.

---

## 9. Existing error handling

Errors are **codes, not messages**. `ApiError(statusCode, code, message)` with a
fixed safe message; the client never receives an internal string. The Fastify
error handler maps Zod, multipart, and rate-limit failures to stable codes and
falls through to a bare `INTERNAL_ERROR` with a `requestId`.

Logging redacts `authorization`, `cookie`, `x-csrf-token`, `idempotency-key`,
`x-print-claim-token`, and `set-cookie`. `getSafeErrorCodes` extracts only an
error code and a database code — never a message or stack.

Persisted failure information is uniformly a short code column:
`processingErrorCode`, `rejectionCode`, `failureCode`, `warningCode`,
`lastErrorCode`, `cleanupErrorCode`, `terminalReason`, `invalidationReason`.
**This is exactly the right shape for a role-aware error centre and requires no
new capture mechanism.**

---

## 10. Existing authentication and authorization

This is the largest finding.

| Principal          | Mechanism                                                 | Where                      |
| ------------------ | --------------------------------------------------------- | -------------------------- |
| Kiosk terminal     | Bearer secret → `sha256` → `KioskCredential.secretDigest` | `modules/sessions/auth.ts` |
| Kiosk agent        | Same credential, distinct scope `print-jobs:agent`        | same                       |
| Phone              | Signed `HttpOnly` cookie + nonce digest                   | `modules/mobile-access`    |
| Document processor | Static bearer token                                       | config                     |
| Payment provider   | HMAC-signed callback + timestamp tolerance                | `payment-adapters`         |

**There is no human identity anywhere in this system.** No `admin_users` table,
no OIDC, no password, no MFA, no human session, no CSRF token for a human UI.
`AuditEvent.actorType` values in use are `KIOSK`, `KIOSK_AGENT`, `MOBILE`,
`PROVIDER`, `SYSTEM` — there is no human actor type.

Authorization today is a scope array on `KioskCredential` checked with
`scopes.includes(requiredScope)`. Twelve scopes exist
(`sessions:create/read/cancel`, `files:read/delete`, `settings:write`,
`quotes:create/read`, `payments:create/write/read`,
`print-jobs:create/read/write/agent`). This is a per-device model. It is a
reasonable pattern to mirror, but it cannot be reused as-is: a kiosk credential
is a shared device secret, not a person.

Rate limiting is per-credential and per-IP, with one shared failed-auth
throttle across every kiosk route so an attacker cannot get a fresh allowance
by switching paths.

---

## 11. Current security boundaries

Genuinely strong, and worth preserving unchanged:

1. **Kiosk opens no inbound port.** All device work is pull-based over the
   agent's own outbound connection.
2. **Kiosk agent binds loopback and rejects non-loopback IPs** in an
   `onRequest` hook.
3. **Document processor has no network egress** (`internal: true`), runs
   read-only, non-root, `cap_drop: ALL`, `no-new-privileges`, pids/mem/cpu
   capped, tmpfs scratch.
4. **Split object-storage credentials** with prefix-scoped IAM policies.
5. **Business invariants enforced in PostgreSQL triggers**, not only in
   application code — 24 functions, 24 triggers.
6. **No customer filename in any object key.**
7. **Only digests persisted** for every token, cookie, and credential.
8. **Test-outcome routes are refused twice** — config validation rejects them
   in production, and `app.ts` checks `NODE_ENV` again independently.
9. **Development seed refuses any non-loopback, non-development target.**

### Weaknesses relevant to an admin plane

- **`audit_events` is not append-only.** `payment_attempts`,
  `print_job_events`, and `print_setting_revisions` all have
  `..._no_update` triggers. `audit_events` has none, and nothing prevents
  `DELETE`. Any actor with the application's database credential can rewrite
  audit history.
- **`AuditEvent.kioskId` / `sessionId` are `onDelete: SetNull`** — deleting a
  kiosk silently detaches its audit trail from its subject.
- **One database role for everything.** The API, worker, and migrations share
  `DATABASE_URL`. There is no read-only role, so an admin read path would
  inherit write capability by default.
- **`Kiosk.lastSeenAt` exists and is indexed but is never written.** Nothing in
  the codebase assigns it; only `KioskCredential.lastUsedAt` (throttled to once
  per minute) and `MobileClient.lastSeenAt` are maintained. "Which kiosks are
  online" is therefore **not currently answerable from the intended column**.
- **Kiosk credential management is equivalent to document access** (see §12).

---

## 12. Sensitive-data inventory

| Data                               | Location                          | Exposure risk                                |
| ---------------------------------- | --------------------------------- | -------------------------------------------- |
| Original document bytes            | `quarantine/v1/`                  | Highest                                      |
| Normalized print-ready PDF         | `normalized/v1/`                  | Highest                                      |
| Rendered page previews (WebP)      | `previews/v1/`                    | **Highest — these are readable page images** |
| Original filename                  | `UploadedFile.displayName`        | High; identifies content                     |
| Content digest                     | `contentSha256`, manifest digests | Medium; confirms a known file                |
| Page count, size, MIME, dimensions | `UploadedFile`, `FilePage`        | Low — safe for operations                    |
| Money, quotes, refunds             | `Payment`, `PriceQuote`, `Refund` | Medium; no card data exists                  |
| Kiosk credential secret            | digest only                       | Secret                                       |
| Peppers / signing keys             | `.env`                            | Secret                                       |

### The escalation path that matters most

Two existing endpoints serve document content to any holder of a kiosk
credential:

- `GET /v1/sessions/:sessionId/files/:fileId/pages/:n/preview` — scope
  `files:read`, returns a **rendered page image**.
- `GET /v1/agent/print-jobs/:id/documents/:docId` — scope `print-jobs:agent`,
  returns the **full normalized PDF**, gated additionally by a live lease.

Therefore: **an admin who can create, rotate, or read back a kiosk credential
has document access, regardless of what the admin API itself exposes.** Any
capability model that grants credential management to a normal Admin silently
grants document access. This must be designed around, not documented around.

**Resolved (§23.2): kiosk-credential management is excluded from the dashboard
entirely, at every role and every risk level.** It stays an operator-run CLI
with its own audit trail. This removes the escalation path rather than
mitigating it — see T4 in §19.

`docs/adr/0001-platform-boundaries.md` decision 9 already states that customer
document bytes and names "do not enter logs, administration, ordinary backups,
analytics, or crash reporting," and `BUILD_PLAN.md:2109` says administrators see
operational metadata only and explicitly says to **avoid a support
document-access feature**. The proposal below honours both.

---

## 13. Dependencies that can be reused

The dashboard needs essentially nothing new on the backend:

| Need                 | Existing capability                                         |
| -------------------- | ----------------------------------------------------------- |
| HTTP, routing, hooks | Fastify 5                                                   |
| Validation           | Zod 4 + `packages/contracts`                                |
| Database             | Prisma + PostgreSQL                                         |
| AuthZ pattern        | scope-array check in `sessions/auth.ts`                     |
| Rate limiting        | `@fastify/rate-limit`, already per-actor                    |
| Cookies              | `@fastify/cookie` (signed)                                  |
| Headers/CSP          | `@fastify/helmet`                                           |
| CORS                 | `@fastify/cors`, origin allow-list                          |
| Audit                | `AuditEvent`                                                |
| Idempotency          | `IdempotencyRecord`                                         |
| Realtime             | existing SSE / Socket.IO + outbox                           |
| Frontend             | React 19, Vite, TanStack Query — same stack as `apps/kiosk` |
| Charts               | none needed initially; see §18                              |

### 13.1 The one unavoidable new dependency — DECIDED

**Decision: self-hosted WebAuthn / FIDO2. No third-party identity provider.**

Rationale accepted from the owner: the system must not acquire a _runtime_
dependency on an external IdP. An OIDC outage would otherwise lock every
operator out of the control plane at exactly the moment — a kiosk incident —
when it is needed. Self-hosting keeps the failure domain inside infrastructure
this project already runs.

Binding requirements for Phase 1:

- **WebAuthn is the only authentication factor.** No password, no TOTP, no
  email link, no SMS. Any such fallback would become the weakest path and
  defeat the choice; the absence of one is the point.
- **Device-bound FIDO2 hardware security keys for Technical Admins.**
  Enforced via authenticator attachment and, where the authenticator reports
  it, attestation — not merely requested.
- **Multiple enrolled authenticators are mandatory on every privileged
  account.** A privileged account with one authenticator is not considered
  fully provisioned. Losing one key must be a replacement, not a recovery.
- **Enrollment, revocation, replacement, and break-glass are designed and
  documented before authentication is called complete** — not deferred. This
  directly answers the objection I raised against WebAuthn-only; the objection
  is resolved by the multi-authenticator requirement plus an explicit
  break-glass procedure, not by a weaker fallback factor.
- **Step-up WebAuthn assertion is required for every R2 and R3 action** and for
  any change to authenticator enrollment itself. A live session is never
  sufficient on its own for a sensitive action.
- **Use a mature WebAuthn server library.** The protocol involves CBOR
  decoding, COSE key parsing, attestation-statement verification, and signature
  counter handling; hand-rolling it would be exactly the "greater risk
  implemented internally" case the dependency policy exists to prevent.

**Dependency: `@simplewebauthn/server`.**

```
Why necessary          WebAuthn registration/assertion verification is
                       cryptographic protocol code. Implementing it correctly
                       (CBOR, COSE, attestation formats, RP ID hashing,
                       challenge and counter handling) is not reasonable to
                       own.
What it solves         Server-side verification of registration and
                       authentication ceremonies.
Why existing is not    Node's crypto provides primitives, not the WebAuthn
enough                 protocol. Nothing in the current stack speaks CBOR/COSE.
Security implications  Reduces risk versus hand-rolling. It handles verified
                       assertions only; session issuance, capability checks,
                       and audit remain this codebase's own code.
Maintenance            Actively maintained, narrow scope, no transitive
                       framework pull-in. To be re-verified at install time.
Alternative considered Hand-written verification (rejected: cryptographic
                       protocol code), managed OIDC (rejected by the owner:
                       runtime third-party dependency).
```

Break-glass, to be designed in Phase 1 and recorded before sign-off: an
offline, sealed, single-use recovery credential held out-of-band, usable only
to enroll a new authenticator, never to perform an R2/R3 action directly, and
emitting an unmissable audit event and alert when consumed.

---

## 14. Proposed capability model

Derived from the routes and state machines that actually exist. Server-side,
default-deny, checked per request. Capabilities — not roles — are checked at the
endpoint; roles are only bundles.

```
dashboard.read

kiosk.read
kiosk.liveness.read

session.read
session.timeline.read

document.metadata.read          # counts, size, MIME, state, timestamps — never bytes
document.retention.read         # cleanup run state, dead letters, overdue
document.retention.retry        # re-arm a dead-lettered CleanupRun

print.read
print.diagnostics.read          # sanitized failureCode/warningCode/event ledger
print.recovery.resolve          # record a recovery outcome — no money moves
                                # (constrained R2; see §14.1)

payment.read
payment.reconcile.read
payment.mismatch.read
refund.obligation.read
refund.authorize                # money-moving. Admin+ only. Never Operator.

error.read
incident.acknowledge

audit.read

pricing.read
pricing.publish.request         # R3 — publishing a tariff is a money change

kiosk.maintenance_mode          # only if a mechanism is built for it

change.propose
change.approve.technical
change.approve.admin

operator.manage                 # Admin manages Operator access only
authenticator.manage            # enrollment/revocation; step-up always required
```

**Deliberately absent by owner decision: any kiosk-credential capability.**
Issuing, rotating, or revoking a `KioskCredential` is not reachable from the
dashboard in any role, at any risk level. It remains an operator-run CLI with
its own audit trail. This _removes_ threat T4 (§19) rather than mitigating it:
no compromised dashboard account of any level can reach customer documents by
minting a device credential.

Deliberately absent, and to remain absent: any capability naming SQL, shell,
script, printer command, terminal command, environment, secret, or document
content.

### Role bundles

|                                                              | Operator      | Admin           | Technical Admin              |
| ------------------------------------------------------------ | ------------- | --------------- | ---------------------------- |
| `dashboard.read`, `kiosk.read`, `session.read`, `print.read` | ✅            | ✅              | ✅                           |
| `document.metadata.read`                                     | ✅            | ✅              | ✅                           |
| `document.retention.read`                                    | ✅            | ✅              | ✅                           |
| `payment.read`                                               | summary only  | ✅              | ✅                           |
| `error.read`                                                 | operator view | admin view      | technical view               |
| `incident.acknowledge`                                       | ✅            | ✅              | ✅                           |
| `audit.read`                                                 | own actions   | ✅              | ✅                           |
| `print.recovery.resolve`                                     | ✅ own kiosks | ✅              | ✅                           |
| `refund.authorize`                                           | ❌            | ✅              | ✅                           |
| `document.retention.retry`                                   | ❌            | ✅              | ✅                           |
| `print.diagnostics.read`                                     | ❌            | limited         | ✅                           |
| `operator.manage`                                            | ❌            | ✅              | ❌                           |
| `authenticator.manage`                                       | own only      | Operators + own | own only                     |
| `change.propose`                                             | ❌            | ❌              | ✅                           |
| `change.approve.technical`                                   | ❌            | ❌              | ✅ (different identity)      |
| `change.approve.admin`                                       | ❌            | ✅              | ❌                           |
| kiosk credentials                                            | ❌            | ❌              | ❌ (not in dashboard at all) |
| document contents                                            | ❌            | ❌              | ❌                           |

Note the deliberate asymmetry: **Technical Admin cannot manage Operator
accounts, and Admin cannot propose technical changes.** Neither role is a
superset of the other, which is what makes a single compromise survivable.

### 14.1 `print.recovery.resolve` — constrained, and separated from money

`RECOVERY_REQUIRED` is the state the system was explicitly designed to hand to a
person, so this is the dashboard's reason to exist. Operators are the people
physically standing at the kiosk who can see whether paper came out, so per the
owner's decision they hold this capability — but under strict constraints, and
**it is separated from refund authority.**

The split, which is the important part:

- `print.recovery.resolve` (Operator and above) **records an observation**:
  what the person saw at the tray. It can record that a paid print appears to
  need recovery and that a refund may be owed. **It cannot move money.**
- `refund.authorize` (Admin and Technical Admin only) is what actually creates
  or settles a monetary obligation, and follows the existing payment/refund
  rules and triggers.

An Operator can therefore surface and document a problem, but cannot
unilaterally cause a payout. Compromising an Operator account yields a stream
of false observations that an Admin must still act on — not free money.

Constraints on `print.recovery.resolve`, all enforced server-side:

- **Strict eligibility.** Only a print job whose _current_ state genuinely
  qualifies, revalidated inside the transaction: the job's status, its
  payment's capture state, and its session's state are all re-read and checked
  at execution time. An Operator cannot force an arbitrary job into a recovery
  state — the operation resolves jobs already there, it does not put them
  there.
- **Kiosk scoping.** An Operator may act only on jobs belonging to kiosks they
  are assigned to. This is a contextual restriction, enforced by the query, not
  by the UI.
- **Mandatory reason string**, validated and length-bounded, stored in the
  audit event.
- **Idempotent per print job** via `IdempotencyRecord`, so a double-submit or a
  retried request cannot record two conflicting observations.
- **Step-up WebAuthn assertion** required (§13.1).
- **Full before/after audit**: previous state, requested operation, resulting
  state, actor, capability used, correlation ID.
- It writes only through `packages/domain/src/print-job.ts` semantics and can
  never mark a job `COMPLETED` — the device-reported outcome stays as recorded,
  which the existing `print_jobs_immutable_snapshot` and
  `print_jobs_status_is_monotonic` triggers enforce independently of this code.

This needs a small schema addition (a resolution record, not a column
mutation), flagged in §21.

---

## 15. Proposed risk classification

**R0 — read only.** Everything in §14 ending `.read`. Requires capability +
authenticated session. Bounded, paginated, cached.

**R1 — safe operational action.** `incident.acknowledge`,
`document.retention.retry` (re-arms an existing dead-lettered run through the
same checkpointed worker — idempotent by construction, since the whole cleanup
design is "safe to run three times"). Capability + validation + audit + rate
limit.

**R2 — sensitive, reversible or compensable.** `print.recovery.resolve`
(constrained; Operator and above — §14.1), `refund.authorize` (Admin and above;
moves money), `authenticator.manage`. Confirmation + mandatory reason + step-up
WebAuthn + current-state revalidation + idempotency key + audit with
before/after. Operator-held R2 is additionally kiosk-scoped.

**R3 — serious production change.** Requires proposer + a _different_ Technical
Admin + an Admin. Allow-listed operations only:

- publish a new `PricingRuleSet` version (money);
- change a kiosk's `status` or `capabilities`;
- adjust retention grace configuration.

**R4 — impossible from the dashboard, permanently.** Arbitrary SQL; shell;
arbitrary code; reading document bytes, previews, or `displayName`; retrieving
any secret or storage credential; **issuing, rotating, or revoking a
`KioskCredential`**; disabling or deleting audit; reopening a terminal session;
forcing a session to `PAID`; creating a `PrintJob` without a capture; arbitrary
printer or terminal commands; editing a published tariff in place (the database
refuses it anyway); authenticating without a WebAuthn assertion.

---

## 16. Proposed dashboard structure

Only sections the codebase can actually fill:

```
Overview            kiosk liveness, active sessions, stuck workflows,
                    RECOVERY_REQUIRED count, cleanup dead letters,
                    unsettled refund obligations
Kiosks              status, last seen, active session, recent failures
Sessions            list + per-session timeline from SessionEvent
Printing            active / failed / recovery-required jobs, event ledger
Payments            state, timed-out intents, payment↔print mismatches,
                    refund obligations and their settlement
Documents           processing state, retention health, dead letters,
                    overdue-past-retention alarm      (never contents)
Errors              grouped by code × subsystem × kiosk, role-aware detail
Audit               append-only, filterable
Changes             R3 requests, approvals, execution history   (phase 5)
```

No Analytics section initially. Session volume over time is a real question,
but it is answerable later from the same indexes and should not be built before
the operational sections earn their keep.

---

## 17. Proposed database and connection strategy

```
Admin browser → Admin UI (React/Vite) → Admin API routes (same Fastify app,
   /v1/admin/*) → human auth → capability check → operational services → Prisma
```

The browser never touches PostgreSQL, Redis, MinIO, the payment provider, the
processor, or a kiosk. There is no admin-side S3 client at all — the admin plane
has **no object-storage credential**, which is the cleanest possible guarantee
that it cannot serve document bytes.

Recommendation on database access: reuse the existing Prisma client and
`DATABASE_URL` for now, but **add a second, read-only PostgreSQL role for admin
read paths.** That is a small, high-value change: it makes "an admin read
endpoint cannot write" a property of the connection rather than of code review.
No replica, no reporting database, no analytics infrastructure — the query
volume from five people does not justify any of it, and §30 of the prompt's own
principle (printing beats dashboard freshness) is better served by bounded
queries and short-TTL caching of the overview aggregates.

Realtime: **poll on a 10–15s interval to start.** The existing outbox and
Socket.IO could feed the dashboard, but reusing them means giving admin
sockets a subscription path into per-session event streams, which widens the
surface for no operational gain at this scale. Polling a cached aggregate is
strictly safer and can be upgraded later if a real need appears.

---

## 18. Proposed visualization strategy

Start with none. Numbers, state badges, and timelines answer every question in
§15 of the prompt. The one visual that genuinely helps is the **per-session
workflow timeline**, and that is a styled ordered list of `SessionEvent` rows
with durations — no charting library.

If time-series charts are later justified, they should be inline SVG or a
single small library chosen then, not now. Adding a charting dependency in
Phase 2 to draw a sparkline nobody asked for would violate §3 of the brief.

---

## 19. Threat model

| #   | Threat                                                 | Existing control                                 | Gap                                                                                                                                           |
| --- | ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Attacker gets an Operator account                      | —                                                | No human auth exists yet                                                                                                                      |
| T2  | Attacker gets an Admin account                         | —                                                | Must not reach documents (§12)                                                                                                                |
| T3  | Attacker gets one Technical Admin account              | —                                                | Must not execute R3 alone                                                                                                                     |
| T4  | Admin reads customer documents via credential issuance | —                                                | **Closed by decision**: no kiosk-credential capability exists in the dashboard at any level (§14)                                             |
| T5  | Admin rewrites audit history                           | none                                             | `audit_events` lacks an update/delete trigger                                                                                                 |
| T6  | Dashboard queries degrade printing                     | good indexes                                     | Needs bounded queries, timeouts, read-only role                                                                                               |
| T7  | Session fixation / CSRF on admin UI                    | cookie plugin present                            | No human session or CSRF token yet                                                                                                            |
| T8  | IDOR across kiosks/sessions                            | kiosk-scoped queries today                       | Admin queries are cross-tenant by design; needs explicit object-level checks + non-enumerable IDs. Operator R2 is kiosk-scoped (§14.1)        |
| T9  | Forced session reopen / free print                     | domain state machine + DB triggers               | Already impossible; keep it that way                                                                                                          |
| T10 | Retention disabled to preserve documents               | policy is pure and shared                        | Retention config must be R3, never editable inline                                                                                            |
| T11 | Stolen admin session replayed                          | —                                                | Short TTL + server-side revocation + step-up WebAuthn on every R2/R3, so a stolen cookie alone cannot act                                     |
| T12 | Compromised admin _backend_                            | split S3 creds, DB triggers, processor isolation | Triggers and IAM still bound the damage; secrets remain the weak point until a secret manager exists                                          |
| T13 | Compromised Operator manufactures refund obligations   | —                                                | **Closed by decision**: `print.recovery.resolve` records observations only; `refund.authorize` is Admin+ (§14.1)                              |
| T14 | Operator forces arbitrary jobs into recovery           | —                                                | Server-side eligibility revalidation inside the transaction; the operation resolves jobs already eligible, it cannot create the state (§14.1) |
| T15 | Phishing of an admin authenticator                     | —                                                | WebAuthn origin binding makes credential phishing ineffective; this is the main reason the owner chose it over a shared-secret factor         |
| T16 | Loss of all authenticators for a privileged account    | —                                                | Multiple mandatory enrollments + documented sealed break-glass that can only enroll, never act (§13.1)                                        |

---

## 20. What exists / reuse / do not change / genuinely missing

**Already exists and is good:** the entire domain model; DB-enforced
invariants; retention workflow; print settlement semantics; error-code
discipline; audit table; idempotency; rate limiting; realtime; split storage
credentials; processor isolation.

**Reuse directly:** Fastify app and error handler, Zod contracts, Prisma,
`AuditEvent`, `IdempotencyRecord`, the scope-check pattern, React/Vite/TanStack
Query, existing indexes (`[state, idleExpiresAt]`, `[cleanupStatus,
cleanupDueAt]`, `[status, availableAt]`, `[kioskId, createdAt]`,
`[sessionId, occurredAt]` — these already cover most dashboard queries).

**Do not change:** the session state machine; the print settlement table; the
cleanup checkpoint order; the DB triggers; the agent pull model; the
loopback-only agent; the processor's lack of egress; the no-filename-in-keys
rule.

**Genuinely missing, in priority order:**

1. Human identity, sessions, and MFA — nothing exists.
2. Capability model and enforcement for humans.
3. Audit immutability (`audit_events` update/delete trigger) and a human actor
   type.
4. A surface for `RECOVERY_REQUIRED` — the state the system explicitly defers
   to a person.
5. A surface and alarm for `CleanupRun` dead letters and overdue retention.
6. A surface for unsettled refund obligations.
7. `Kiosk.lastSeenAt` is never written, so kiosk liveness is unanswerable.

---

## 21. Necessary schema changes, and why

Only these. Each is justified by an absence, not a preference.

1. **`admin_user`** — human identity. Unavoidable: no human exists in the
   schema. No password column, ever — WebAuthn is the only factor (§13.1).
2. **`admin_authenticator`** — one row per enrolled FIDO2 credential:
   credential ID, public key, signature counter, transports, attachment,
   attested authenticator model where available, enrolled/last-used/revoked
   timestamps. **Many per user, by requirement** — a privileged account with
   fewer than two active rows is not fully provisioned, and that invariant is
   worth a database check constraint or trigger rather than only application
   code, matching how this repository already enforces invariants.
3. **`admin_session`** — revocable server-side sessions with short TTL, plus
   the timestamp of the last step-up assertion so R2/R3 can require a fresh
   one. Cookies alone cannot be revoked.
4. **`admin_role_assignment`** — role/capability binding, mirroring the
   `KioskCredential.scopes` array pattern already in use. Includes the
   **Operator→kiosk scoping** required by §14.1.
5. **`AuditEvent.actorType`** gains a human value, plus a trigger making
   `audit_events` reject `UPDATE` and `DELETE`, matching the three tables that
   already have that protection.
6. **A print-job recovery resolution record** — recording an observation about
   `RECOVERY_REQUIRED` must be a new, explicit, auditable fact rather than a
   mutation of the job's device-reported outcome, which the existing triggers
   correctly forbid. Kept distinct from any refund obligation, per §14.1.
7. **`change_request` + `change_approval`** (Phase 5 only) — R3 workflow with
   an immutable request digest so amending a request invalidates approvals.
8. **Writing `Kiosk.lastSeenAt`** in the existing once-per-minute throttled
   heartbeat in `sessions/auth.ts`. Not a new column — the column and its index
   already exist and are simply never populated. Zero additional write cost.

Break-glass credential storage is deliberately **not** a schema item: it should
be a sealed offline artifact verified against a stored digest, so that reading
the database yields nothing usable.

Not proposed: no changes to sessions, payments, print jobs, files,
derivatives, cleanup runs, pricing, or any trigger other than the audit one.

---

## 22. Proposed phase plan

| Phase | Content                                                                                                                                                                                                                                                                                                                               | Gate                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1     | WebAuthn registration + assertion, multi-authenticator enrollment, revocation/replacement, break-glass procedure, revocable sessions, step-up assertion, capability enforcement, Operator kiosk scoping, audit immutability, admin UI shell, protected routes, permission tests. No read of production data yet beyond a health page. | Boundary tests pass; no privileged account has fewer than two authenticators; break-glass documented |
| 2     | Read-only observability: overview, kiosks, sessions + timeline, printing, payments, documents/retention, error centre. Bounded queries, read-only DB role.                                                                                                                                                                            | No mutations exist                                                                                   |
| 3     | Operator tools: R1 incident acknowledge; constrained R2 `print.recovery.resolve` with kiosk scoping, eligibility revalidation, step-up.                                                                                                                                                                                               | Operator cannot move money, cannot act outside assigned kiosks, cannot force a job into recovery     |
| 4     | Admin tools: `refund.authorize` (money), `document.retention.retry`, Operator and authenticator management.                                                                                                                                                                                                                           | Reason + before/after audited; refund path separate from Operator observation path                   |
| 5     | Technical Admin + R3 approval workflow: propose → validate → dry run → second Technical Admin → Admin → revalidate → execute → verify.                                                                                                                                                                                                | Self-approval and amendment tests pass                                                               |
| 6     | Hardening: authz matrix review per endpoint, IDOR, CSRF, XSS, secret leakage, query performance, audit integrity.                                                                                                                                                                                                                     | Security test suite green                                                                            |

---

## 23. Decisions taken by the owner

All three Phase 0 gating questions are answered. Recorded here because each
changed the design away from my initial recommendation.

**23.1 Authentication — self-hosted WebAuthn/FIDO2 only.**
I had recommended managed OIDC. The owner rejected it to avoid a _runtime_
dependency on a third-party IdP, and resolved my stated objection to
WebAuthn-only — no recovery path for a lost key — by requiring multiple
enrolled authenticators per privileged account plus an explicit break-glass
procedure, rather than by adding a weaker fallback factor. That is a better
answer than mine: it removes an outage dependency and avoids a phishable
secondary factor. Detail in §13.1.

**23.2 Kiosk credentials — out of the dashboard entirely.**
Confirmed as recommended. This closes T4 outright rather than mitigating it
(§14, §19). Credential issuance stays an operator-run CLI.

**23.3 Recovery resolution — Operator and above, but split from money.**
The owner accepted Operator access for operational reasons (they are the ones
who can see the tray) while adding a constraint I had not separated: recording
a recovery observation and authorizing a refund must be different capabilities
with different authorization. `print.recovery.resolve` is Operator+, kiosk-
scoped, eligibility-revalidated, and cannot move money; `refund.authorize` is
Admin+. This is a stronger design than the single capability I proposed —
it closes T13. Detail in §14.1.

---

## 24. Status

Phase 0 is complete. No implementation has begun and no dependency has been
installed.

Phase 1 is ready to start. It will introduce exactly one new runtime
dependency, `@simplewebauthn/server`, justified in §13.1, and the schema
additions in §21 — nothing else.
