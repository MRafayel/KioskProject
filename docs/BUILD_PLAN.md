# Printing Kiosk software build plan

Status: active implementation plan; Phases 0–6 implemented

Audience: solo developer building the first prototype, then a commercial pilot
Primary target: Windows kiosk, with development on macOS and hardware simulated

## 1. Executive direction

Build one TypeScript monorepo, but preserve two deployment boundaries from the
first day:

1. A cloud control plane owns public uploads, session truth, pricing, payments,
   object storage, administration, and fleet monitoring.
2. A local kiosk agent owns printer and payment-terminal access. It
   keeps a small durable local queue and connects outward to the cloud.

For the MVP, all cloud components may run on the development laptop. They must
still communicate through documented HTTP, event, and adapter contracts. This
prevents mock devices from leaking into business logic and lets a Windows
implementation replace them later.

The first end-to-end slice is deliberately narrow: PDF, JPEG, and PNG upload;
one active session per kiosk; basic page and copy settings; server-authoritative
pricing; fake payment; a mock printer that writes an output PDF; terminal-state
cleanup. Document scanning, photocopying/xerox, and color printing are outside
the product scope. Real payment and real printer support follow only after this
slice is reliable.

### Decisions that are expensive to reverse

- Keep hardware behind a versioned kiosk-agent contract. A cloud server cannot
  safely or reliably control a USB printer directly.
- Make PostgreSQL the source of truth. Redis is a cache, queue, lock, presence,
  and rate-limit store, never the only record of a payment or print job.
- Store money as integer minor units plus a three-letter currency; never use
  floating-point money.
- Give every retried mutation an idempotency key, and use an outbox table for
  reliable events.
- Store private blobs under random object keys, outside public web roots. Keep
  original, preview, and normalized print-ready artifacts distinct.
- Normalize every accepted input to a print-ready PDF. Device adapters consume
  this stable format rather than arbitrary customer input.
- Separate session, file, payment, and print-job state. A single status column
  cannot accurately represent all four workflows.
- Treat a spooler success as acceptance by a queue, not proof that paper exited
  the printer. Preserve an explicit result-confidence field.
- Use opaque, high-entropy QR tokens. A short numeric code is a convenience
  locator and must not be the primary security boundary.
- Design deletion as a durable, retryable workflow. Deleting one database row
  is not deletion of all copies.

## 2. Terms

- Control plane: cloud services that coordinate kiosks and retain operational
  metadata.
- Kiosk agent: a local background service that talks to hardware and buffers
  work during brief outages.
- Adapter: a small interface hiding a specific printer or payment
  implementation.
- Idempotency: retrying the same request produces one business action, not a
  duplicate charge or print.
- Outbox: database rows written in the same transaction as a state change and
  later published as events.
- Print-ready artifact: a validated, normalized PDF with final page order and
  layout, suitable for a device adapter.
- Object storage: private blob storage using an S3-compatible API.

## 3. Recommended architecture

### 3.1 Communication diagram

~~~text
Customer phone
  Mobile React app
        |
        | HTTPS: token exchange, upload, status
        v
+--------------------------- Cloud control plane ----------------------------+
| CDN / reverse proxy                                                        |
|      |                                                                     |
|      +--> Fastify API + Socket.IO gateway                                  |
|              |             |                |                              |
|              |             |                +--> PostgreSQL                |
|              |             +--> Redis / BullMQ                             |
|              +--> private S3 object storage                                |
|                            |                                                |
|                    validation / preview / normalization workers             |
|                                                                             |
| Admin React app --> OIDC login --> Admin API --> audit log / monitoring     |
+----------------------------------|------------------------------------------+
                                   |
                       outbound TLS connection only
                    commands down; events and health up
                                   |
+---------------------------- Windows kiosk --------------------------------+
| React kiosk UI <---- localhost authenticated API/events ----> kiosk agent   |
|                                                               |            |
|                                  SQLite outbox + encrypted local spool      |
|                                          |          |          |            |
|                                      printer adapter     payment adapter    |
|                                          |          |          |            |
|                                    OS queue/IPP   WIA/TWAIN  certified SDK   |
+---------------------------------------------------------------------------+
~~~

For local development, cloud boxes are Docker Compose services on the laptop,
the kiosk agent is a normal host process, and all device adapters are mocks.

### 3.2 Component responsibilities and placement

| Component | MVP responsibility | Production responsibility | Runs |
|---|---|---|---|
| Kiosk touchscreen app | Start/cancel a session, show QR and connection state, display validated files, collect settings, show price/payment/print status | Locked-down accessible UI, local recovery screen, diagnostics with admin authorization | Local static assets, served by the agent; uses cloud data |
| Mobile upload app | Exchange QR token, upload allowed files, show validation and session expiry | Resumable upload, localization, privacy notice, reconnect using a secure grant | Cloud/CDN; browser on phone |
| Backend API | Sessions, files, settings, quotes, mock payment, print orchestration | Fleet APIs, real payment webhooks, policy, reconciliation | Cloud; local in development |
| Real-time service | Socket.IO room per authorized kiosk session | Scaled gateway using Redis adapter, replay by event sequence, reconnect/resync | Cloud plus localhost agent-to-UI events |
| Temporary file storage | Private S3-compatible MinIO bucket | Encrypted private cloud object storage with lifecycle fallback; encrypted agent cache | Both |
| Database | PostgreSQL for durable truth | Managed PostgreSQL with backups and point-in-time recovery | Cloud; Docker locally |
| Redis and job queue | BullMQ validation, preview, print dispatch, cleanup; locks and rate limits | Managed Redis; queues split by workload | Cloud; Docker locally |
| Print-job processing | Build job manifest and call mock adapter | Cloud orchestration plus local execution, reconciliation, and uncertain-output handling | Both |
| Printer integration | Mock writes PDF and manifest to a folder | Windows spooler, IPP, CUPS, or manufacturer SDK adapter | Local only |
| Payment integration | Deterministic fake provider | Certified terminal/provider; application sees tokens and results, never card data | Cloud orchestration and local terminal adapter |
| Administrative dashboard | Not required for first vertical slice | Kiosk health, pricing, jobs, refunds, audit, roles | Cloud |
| Monitoring and logging | Pino logs with request/session IDs and no filenames | OpenTelemetry traces/metrics, Sentry, alerting, agent log buffer | Both |

### 3.3 Communication rules

1. The phone talks only to the public upload origin over HTTPS.
2. The browser never receives an object-storage credential. It receives a
   narrow upload grant or a short-lived presigned operation.
3. No inbound public port is opened on a kiosk. The agent creates an outbound
   authenticated connection and polls or leases durable commands.
4. The kiosk UI talks only to the loopback agent facade. The agent owns the
   authenticated cloud Socket.IO connection and relays user-visible events
   locally. After reconnect it fetches a current snapshot and events after its
   last sequence number.
5. A print command contains immutable artifact hash, settings hash, quote ID,
   payment authorization reference, and idempotency key.
6. Business state changes and their outbox event are committed in one database
   transaction.
7. Every service uses UTC timestamps, structured error codes, correlation IDs,
   and ULID or UUIDv7 identifiers.

### 3.4 MVP versus later topology

MVP on one laptop:

~~~text
React apps -> Fastify -> PostgreSQL / Redis / MinIO
                        |
                        +-> BullMQ workers -> Node mock kiosk agent
                                             -> var/mock-printer/output
~~~

Production:

- Static frontends on a CDN.
- API and workers as separate containers.
- Managed PostgreSQL, Redis, and private S3 storage.
- Each kiosk has a locally installed, signed agent and cached UI.
- Optional regional services only when fleet size or data-residency needs
  require them.

Do not begin with microservices. Use a modular monolith plus separate workers
and the already-separated kiosk agent. Extract a service only after operational
evidence shows an independent scaling or trust boundary.

## 4. Primary technology stack

### 4.1 Selected defaults

| Area | Default | Why |
|---|---|---|
| Language and repository | TypeScript, Node.js 24 LTS, pnpm workspaces, Turborepo | One language across web, API, workers, contracts, and mocks; fast solo development; explicit package boundaries |
| Kiosk frontend | React + Vite + React Router + TanStack Query | Mature component ecosystem, fast development, static assets that can be cached locally |
| Mobile upload frontend | React + Vite, responsive CSS, browser upload APIs | Reuses contracts and UI primitives; no install/account required |
| Admin frontend | React, added after MVP | Reuse without coupling admin code to public or kiosk bundles |
| API | Fastify with TypeScript, Zod, OpenAPI, Pino | Smaller learning surface than a large framework, strong performance, validation and logging support |
| Durable database | PostgreSQL with Prisma migrations/client | Transactions, constraints, relational audit trail, productive typed access |
| Ephemeral store and jobs | Redis + BullMQ | Delays, retries, concurrency, cleanup scheduling, and local simulation |
| Real-time | Socket.IO | Rooms, heartbeats, reconnect behavior, and transport fallback; pair it with snapshot resync |
| Object storage | S3 interface; MinIO for local development | Same private-object contract locally and in hosted clouds |
| QR | qrcode package in the kiosk browser | Generates a data URL or SVG from a server-provided URL; no secret leaves the session response |
| PDF browser preview | PDF.js through pdfjs-dist | Mature page rendering and zoom support |
| Images | sharp/libvips | Bounded decoding, orientation, metadata removal, thumbnails, and normalization |
| PDF inspection | qpdf plus PDF metadata/page-count tooling in a sandboxed worker | Detect encryption/malformed structure and build a predictable validation pipeline |
| Print agent | Node.js service with PrinterAdapter; native .NET or vendor helper behind the adapter when required | Mock and cross-platform orchestration now without blocking a robust Windows implementation later |
| Admin identity | Auth0 through standard OIDC, with MFA and RBAC | Easy solo-developer start without building password/MFA security; the OIDC boundary permits later Entra ID or Keycloak |
| Unit/integration tests | Vitest, Fastify inject, Testcontainers where valuable | Fast TypeScript tests and real infrastructure tests |
| Browser/E2E tests | Playwright | Chromium, Firefox, WebKit, mobile viewports, upload and network controls |
| Load/security tests | k6, OWASP ZAP, Semgrep, Gitleaks, Trivy, dependency audit | Covers traffic, web behavior, source/secrets, and images |
| Containers | Docker Compose locally; OCI containers for API/workers | Reproducible services while the hardware agent remains on the host |
| CI and deployment | GitHub Actions; AWS ECS Fargate, RDS PostgreSQL, ElastiCache, S3, CloudFront, Secrets Manager | A more demanding setup than a hobby PaaS, but managed, auditable building blocks support a commercial fleet without changing application contracts |
| Observability | Pino, OpenTelemetry, Sentry, Prometheus-compatible metrics | Correlated logs/traces/errors without document data |

Node 24 is selected because it is an LTS line as of this plan. Pin the exact
runtime and every direct dependency through the lockfile; upgrade deliberately.

### 4.2 Brief alternatives

- NestJS is more prescriptive than Fastify but adds concepts and ceremony that
  do not yet help a solo MVP. Fastify plugins can still enforce module
  boundaries.
- Server-Sent Events are simpler for one-way updates, but Socket.IO is chosen
  because kiosk connection state, rooms, acknowledgments, and future fleet
  commands benefit from a bidirectional channel. Durable data still uses REST.
- Electron packages a kiosk conveniently but has a large attack surface if
  Node integration is exposed. Start with a browser in OS kiosk mode and a
  separate agent. Consider Tauri or a hardened wrapper only if deployment
  evidence requires it.
- SQLite is excellent for the local agent outbox but not the cloud source of
  truth. PostgreSQL is required for transactional payments and multi-kiosk
  concurrency.
- A local filesystem adapter is useful in tests, but application code should
  use the S3 storage interface so production storage is not a rewrite.
- Render/Railway/Fly-style platforms can host a staging MVP faster, but AWS is
  the production default in this plan because the document, network, IAM,
  audit, backup and regional controls are clearer. Containers and standard
  PostgreSQL/Redis/S3 contracts keep this choice replaceable.

### 4.3 Licensing checkpoint

PDF renderers, printer SDKs, virtual PDF drivers, fonts, and some image/PDF
tools have redistribution or commercial-use terms. Record each binary and
library in a software bill of materials and complete a license review before
shipping an appliance. Never copy a manufacturer SDK into the repository
without confirming its license.

## 5. MVP definition

### 5.1 Included

1. Provision one development kiosk identity.
2. Create one active, expiring print session.
3. Display QR URL and an eight-digit fallback code.
4. Open a mobile page without account creation.
5. Upload up to 10 PDF/JPEG/PNG files with hard size and page limits.
6. Validate into quarantine, generate previews, and mark files ready.
7. Notify the kiosk in real time and recover via snapshot after reconnect.
8. Reorder/remove files and choose flexible page ranges, copies,
   simplex/duplex, orientation, and fit on fixed A4 paper. Output is always
   monochrome.
9. Create a server-authoritative, expiring price quote.
10. Run a fake payment outcome with idempotent callbacks.
11. Create a normalized print-ready PDF and immutable job manifest.
12. Let a mock printer save the result into a local output directory and
    simulate success or failure.
13. Show terminal status and automatically delete every private artifact.

### 5.2 Explicitly excluded

- Real card acceptance, cash hardware, refunds to a real provider.
- Office documents, URLs, email ingestion, USB customer media, HEIC, SVG, TIFF,
  archives, or password-protected PDFs.
- Document scanning, photocopying/xerox, color printing, printer discovery, and
  consumable telemetry.
- Customer accounts, saved documents, remote reprints, and marketing profiles.
- Multiple simultaneous customer sessions on one kiosk.
- Full offline phone upload.
- Production administrator UI beyond an authenticated diagnostic endpoint.

### 5.3 MVP acceptance criteria

- A fresh environment completes the happy path from QR to mock output using one
  documented command per process or one root development command.
- Refreshing either browser does not lose the session.
- Repeating payment confirmation or print submission does not duplicate the
  business action.
- A rejected or oversized file never reaches preview or printer queues.
- Restarting API or worker processes recovers nonterminal jobs.
- Simulated offline, jam, out-of-paper, timeout, decline, and duplicate webhook
  paths reach deterministic states.
- Cleanup removes originals, partials, previews, normalized files, grants, and
  local spool copies, and a test proves this.
- Logs contain identifiers and error codes, not customer filenames or content.

## 6. Security defaults present from Phase 0

- HTTPS everywhere outside loopback; HSTS in production.
- Exact CORS origin allowlist; no wildcard with credentials.
- Secure, HttpOnly, SameSite cookies for upload grants; CSRF token for
  cookie-authenticated mutations.
- Kiosk identity per device, rotatable and revocable; development API keys are
  never a production mechanism.
- OIDC, MFA, and role-based authorization for administrators.
- Rate limits by IP, token, kiosk, and session; stricter limits on manual-code
  exchange.
- Random server-side names; original names displayed only from sanitized
  metadata and never used in paths or headers without safe encoding.
- Quarantine and validation before preview, price, download, or print.
- Document processors run non-root with no network, read-only base filesystem,
  bounded CPU/memory/process/time, and a disposable working directory.
- Parameterized ORM access plus database constraints; React escaping plus a
  strict Content Security Policy; no rendering of customer HTML/SVG.
- Object buckets private, public access blocked, versioning disabled for
  temporary content unless retention behavior is explicitly handled.
- Tokens stored as digests, signed URLs short-lived, secrets held in a secret
  manager in production.
- Structured logs redact authorization, cookies, tokens, signed URLs, original
  filenames, and multipart bodies.
- Session-specific encryption keys are preferred for local caches; deletion of
  the key provides practical crypto-erasure when SSD block erasure cannot be
  guaranteed.

## 7. Development roadmap

MVP is Phases 0–9. Hardware work begins only after the mock workflow, restart
recovery, failure simulation, and cleanup pass. Phase 11 is the commercial
pilot gate. A realistic solo-developer MVP is roughly 6–10 focused weeks, but
quality gates, not calendar dates, decide when a phase is complete.

### Phase 0 — reproducible and clean development workspace

**Status:** complete on 2026-07-13. See `docs/PHASE_0_STATUS.md`.

**Objective:** make a fresh checkout safe and runnable.

**Build:** initialize Git and pnpm/Turborepo; strict TypeScript; lint, format,
unit test, and CI commands; Docker Compose with PostgreSQL, Redis, and MinIO;
typed environment validation; health endpoints; synthetic fixtures; ADR and
threat-model folders.

**Tools:** Node 24 LTS, pnpm 11, TypeScript, Turborepo, ESLint, Prettier,
Vitest, Fastify, Zod, Prisma, Pino, Docker Compose.

**Modules:** packages/config, packages/database,
services/api/src/modules/health, infrastructure/compose, tests/fixtures,
docs/adr, docs/threat-model.

**Endpoints/entities:** GET /health/live and GET /health/ready; initial schema
migration only.

**Tests:** clean install; container health; lint/typecheck/test; missing config
fails fast; secret scan; verify private artifacts and secrets are ignored.

**Done:** a clean checkout installs, starts infrastructure, migrates, seeds,
runs all apps, and passes tests with documented root commands.

**Avoid:** public database binds, real document fixtures, unpinned runtimes,
committed .env files, verbose request-body logging, and premature
microservices.

### Phase 1 — kiosk UI prototype

**Status:** complete on 2026-07-13. See `docs/PHASE_1_STATUS.md`.

**Objective:** validate a complete touchscreen journey without a backend.

**Build:** welcome/start screen with Print as the only service; QR, upload,
configuration, checkout, progress, success, failure, cancel, and idle reset
screens; accessible large touch targets; responsive landscape layouts; error
boundary.

**Tools:** React, Vite, React Router, TanStack Query, CSS modules or Tailwind,
Mock Service Worker, React Testing Library, Playwright, axe-core.

**Modules:** apps/kiosk/src/routes, features/session, features/files,
features/checkout, components, mocks. No API or database yet; mocks must conform
to the proposed contracts.

**Tests:** component states, Playwright happy/cancel/back paths, fake-timer idle
reset, 1280x800 and 1920x1080, keyboard focus, automated accessibility scan.

**Done:** a tester reaches every terminal screen without a dead end, tiny
control, browser navigation, or desktop exposure.

**Avoid:** Electron packaging before UX stabilizes, one-resolution assumptions,
business state hidden in React components, and missing recovery screens.

### Phase 2 — authoritative temporary sessions

**Status:** complete on 2026-07-14. See `docs/PHASE_2_STATUS.md`.

**Objective:** put session lifecycle and concurrency in the backend.

**Build:** seed a development kiosk; create ID, public ID, domain-separated
HMAC-derived upload token and short code, digest-only grant storage, expiry, and
state; pure transition function; optimistic version; audit/outbox event;
injected Clock and random source; idempotent create/cancel with HMAC-digested
keys and sanitized replay records.

**Tools:** Fastify, Prisma/PostgreSQL, Zod, node crypto, Vitest, fast-check.

**Modules:** services/api/src/modules/kiosks and sessions;
packages/domain/src/session; packages/contracts/src/sessions;
packages/database/prisma.

**Endpoints:** POST /v1/kiosks/:kioskId/sessions; GET /v1/sessions/:sessionId;
POST /v1/sessions/:sessionId/cancel.

**Entities:** kiosks, kiosk_credentials, print_sessions,
session_upload_grants, audit_events, outbox_events, idempotency_records.

**Tests:** code collision retry, digest-only token/code/key storage, exact safe
replay, replay tamper/state refusal, transition table, tenant isolation,
concurrent create/cancel, exact expiry boundary, duplicate/expired idempotency
key, active session uniqueness, and database response sanitization.

**Done:** create returns the QR value and a duplicate request safely reconstructs
the exact response only while the original waiting grant remains active;
invalid/stale transitions return 409 or 412.

**Avoid:** treating the code as sufficient authorization, storing a raw token,
short code, idempotency key, or credential-bearing replay response; accepting
client state assignments; and writing audit separately from the transaction.

### Phase 3 — QR and mobile upload

**Status:** complete for the bounded one-file MVP on 2026-07-15. See
`docs/PHASE_3_STATUS.md` for implementation and verification evidence.

**Objective:** securely move one allowed file from a phone into quarantine.

**Build:** render the returned QR URL; responsive join page; fragment-token
exchange into a session-specific HttpOnly cookie; strip the fragment from
history; stream multipart data; enforce count/byte/type limits; private random
object keys; progress/list/delete; exact-origin and CSRF enforcement.

The numeric fallback claim was deliberately deferred: the kiosk does not show
the code until a kiosk-approved claim flow, abuse controls, and operational
recovery design exist. Phase 3 uses QR claim only.

**Tools:** qrcode.react, @fastify/multipart, AWS S3 client, MinIO, bounded
in-house magic-signature validation,
React/Vite, XHR upload progress.

**Modules:** apps/mobile-upload/src/features/join and upload;
services/api/src/modules/mobile-access and files; packages/file-processing/src.

**Endpoints:** POST /v1/mobile-auth/exchange; GET
/v1/mobile-auth/:publicSessionId/context;
POST/GET /v1/sessions/:sessionId/files; DELETE
/v1/sessions/:sessionId/files/:fileId.

**Entities:** session_upload_grants, mobile_clients, uploaded_files.

**Tests:** real multipart, zero bytes, spoofed type/extension/signature, over
size/count, expired/revoked/claimed token, two phones, interruption/partial
cleanup, object privacy, and a real phone on the same Wi-Fi.

**Done:** a phone can scan, upload, list, and delete a synthetic file; neither
the raw token nor customer filename becomes a storage path or log field. The
kiosk polls a safe file projection as a temporary Phase 3 transport. Files
remain `QUARANTINED` until Phase 5 deep validation; Phase 4 replaces polling
with sequenced real-time delivery and snapshot recovery.

**Avoid:** base64 file JSON, public buckets, query-string tokens, whole-file
memory buffering, path use of filenames, and marking partial data READY.

### Phase 4 — durable real-time updates

**Implementation status:** complete. See `docs/PHASE_4_STATUS.md`.

**Objective:** update the kiosk quickly without making the socket authoritative.

**Build:** agent-authenticated cloud Socket.IO connection; per-kiosk/session
room; ephemeral loopback UI connection that exposes no device credential;
transactional outbox publisher; monotonically increasing session event
sequence; deduplication; replay endpoint; snapshot resync after gaps;
credential-scoped mobile SSE for terminal events; low-frequency authoritative
phone reconciliation. Exact byte progress remains phone-local; the kiosk
receives durable, low-frequency upload lifecycle events.

**Tools:** Socket.IO client/server, PostgreSQL outbox, BullMQ publisher; Redis
adapter only when multiple gateway instances exist.

**Modules:** services/api/src/modules/realtime and events;
services/worker/src/jobs/publish-outbox; packages/contracts/src/events.

**Endpoints/events:** GET /v1/sessions/:id/events?after=sequence, authenticated
Socket.IO for the kiosk agent, and GET
/v1/mobile-auth/:publicSessionId/events/stream for the claimed phone;
session.created, mobile.connected, upload.started,
file.uploaded/rejected/deleted, session.canceled, and session.expired. Phase 5
adds file.ready after deep validation.

**Entities:** session_events and outbox_events.

**Tests:** emit after commit, disconnect/reconnect/replay, duplicate/out-of-order
event, unauthorized room, session isolation, pushed phone cancellation,
credential expiry, bounded stream concurrency, and missed-event
reconciliation.

**Done:** an uploaded file appears promptly and the same correct state returns
after a forced disconnect and process restart.

**Avoid:** Redis Pub/Sub as durable truth, emission before commit, global
guessable rooms, missing sequence numbers, secrets in event payloads,
unbounded/immortal SSE connections, and using a process-local fanout bus after
scaling beyond one API replica.

### Phase 5 — validation, normalization, and preview

**Objective:** turn untrusted input into bounded inert previews and a canonical
print artifact.

**Implementation:** complete for the pilot/prototype boundary. See
`docs/PHASE_5_STATUS.md` for the exact security model, operational boundaries,
migrations, acceptance evidence, and commercial follow-up requirements.

**Build:** UPLOADING to QUARANTINED to VALIDATING to READY/REJECTED workflow;
malware scan; signature/parser checks; PDF encryption/page limits; bounded
image decode; previews; immutable original; normalized PDF; resource-isolated
workers; safe customer error codes.

**Tools:** BullMQ, qpdf, Poppler, Sharp, PDFKit, ClamAV, tar-stream, private
S3-compatible storage, and container resource limits. Complete a license review
before distribution.

**Modules:** `services/worker/src/jobs/process-document`,
`services/worker/src/processing`, `services/worker/src/storage`,
`services/document-processor`, `packages/file-processing`, and the API files
and preview modules.

**Endpoints:** GET session files; GET file pages; GET authenticated page
preview. Reprocess is development/admin only.

**Entities:** uploaded_files processing columns, file_pages, file_derivatives.

**Tests:** corrupt/truncated/encrypted PDF, extreme page count/pixels, timeout,
lease loss and competing claims, shell characters in filename, preview
authorization and digest validation, immutable source hash, malware rejection,
rejection temp cleanup, durable `file.ready` delivery, and deletion of every
known object.

**Done:** READY means metadata, previews, and normalized PDF all exist;
malformed input cannot crash or escape the worker.

**Avoid:** converters inside the API, shell command strings with user input,
Office/SVG/archive support now, public previews, eager huge rasterization, and
native viewing of originals.

### Phase 6 — settings and server-authoritative pricing

**Implementation:** complete for the pilot/prototype boundary. See
`docs/PHASE_6_STATUS.md` for the pricing model, invalidation rules, migrations,
acceptance evidence, and commercial follow-up requirements.

**Objective:** create valid immutable settings revisions and reproducible quotes.

**Build:** canonical page ranges, copies, duplex, A4, orientation,
fit; enforce monochrome output; capability checks; page/side/sheet counts; immutable expiring
quote with pricing version and manifest hash; automatic quote invalidation.

**Tools:** Zod, pure packages/pricing, Vitest, fast-check.

**Modules:** API settings and quotes modules; packages/pricing;
packages/domain/src/print-settings.

**Endpoints:** PUT /v1/sessions/:id/settings; POST
/v1/sessions/:id/quotes; GET /v1/sessions/:id/quotes/:quoteId.

**Entities:** print_setting_revisions, pricing_rule_sets, pricing_rules,
price_quotes.

**Tests:** range normalization; bounds; odd duplex; pages-per-sheet; fixed
monochrome output; minimum, fees and tax rounding; expired/stale quote; manipulated
browser total; pricing properties.

**Done:** identical inputs and pricing version produce the same quote, and only
the backend total can enter payment.

**Avoid:** floating money, mutable published rules, settings mutation after
quote lock, browser prices, unbounded copies, and ambiguous rounding.

### Phase 7 — simulated payment

**Objective:** prove payment correctness without card hardware.

**Build:** provider interface; deterministic success, decline, cancel, timeout,
duplicate/out-of-order callback, and unavailable scenarios; idempotent intent
and confirmation; raw-body webhook signature; amount/currency/quote check;
timeout reconciliation; compensation records.

**Tools:** packages/payment-adapters, node crypto HMAC, BullMQ.

**Modules:** packages/payment-adapters/src/mock;
services/api/src/modules/payments; worker payment-timeout/reconcile jobs.

**Endpoints:** POST /v1/sessions/:id/payments; POST
/v1/payments/:id/confirm; GET /v1/payments/:id; POST
/v1/webhooks/payments/mock; development-only outcome route.

**Entities:** payments, payment_attempts, payment_webhook_inbox, refunds or
print_credits.

**Tests:** all outcomes; same key/same body; same key/different body; bad
signature; duplicate and late callback; wrong amount; capture across restart.

**Done:** at most one effective capture exists, only verified capture reaches
PAID, and production builds cannot expose outcome-control routes.

**Avoid:** trusting browser redirects, receiving card data, retrying with a new
key, overwriting captured state with a late failure, and erasing original
payment records.

### Phase 8 — virtual printing

**Objective:** exercise asynchronous printing and failures without hardware.

**Build:** immutable job manifest; unique operation ID; BullMQ dispatch;
PrinterAdapter and MockPrinterAdapter; output PDF and manifest directory;
health/capabilities/status/cancel; success, offline, jam, out-of-paper, warning,
cancel, timeout, and unknown-after-submit scenarios; local operation ledger.

**Tools:** BullMQ, Node filesystem APIs inside the mock, pdf-lib/normalizer,
kiosk agent.

**Modules:** packages/printer-adapters; services/kiosk-agent/src/print;
worker dispatch-print job; API print-jobs module.

**Endpoints:** POST /v1/sessions/:id/print-jobs; GET
/v1/print-jobs/:id; POST /v1/print-jobs/:id/cancel; internal agent
claim/status operations.

**Entities:** print_jobs, print_job_attempts or events, agent_commands.

**Tests:** every mock scenario, crash at each boundary, duplicate queue
delivery, cancel race, unpaid/stale quote refusal, immutable snapshot, output
path traversal.

**Done:** a paid session creates one logical mock output and reaches a precise
success, definite failure, or recovery-required state.

**Avoid:** printing in HTTP handlers, equating queued with completed, blind
retry after ambiguous submission, user filenames in paths, and an assumption
of exactly-once queues.

### Phase 9 — expiration and idempotent cleanup

**Objective:** reliably remove all document artifacts and revoke access.

**Build:** delayed expiry and cleanup jobs; artifact ledger/checkpoints; delete
incoming/original/normalized/preview/local spool/multipart data; revoke grants;
scrub transient metadata; retries, leases, dead-letter alert; orphan
reconciliation; object lifecycle backstop; local agent TTL watchdog.

**Tools:** BullMQ, S3 delete/list/abort APIs, PostgreSQL row leasing with
SKIP LOCKED, storage lifecycle policies.

**Modules:** worker expire-session, cleanup-session, reconcile-storage;
packages/domain/src/retention.

**Endpoints/entities:** no public scheduler endpoint; authenticated manual
admin cleanup later. cleanup_runs, cleanup fields and tombstones.

**Tests:** completed/canceled/expired/timeout/failure; failure after every
checkpoint; three repeat cleanups; worker restart; orphan object; 410 access;
log redaction.

**Done:** every terminal session eventually has zero document objects and local
derivatives while minimal payment/audit metadata remains.

**Avoid:** deleting database rows first, forgetting previews/backups/multipart
parts/mock output, relying only on bucket lifecycle, promising SSD overwrite,
and deleting financial records.

### Phase 10 — physical printer integration

**Objective:** replace the mock through the same contract on Windows.

**Build:** Windows service; approved-queue discovery; capability snapshot and
mapping; spooler/IPP submission; OS job ID; status/cancel; outbound agent
heartbeat and lease; optional narrow .NET device host.

**Tools:** .NET LTS Worker Service for reliable Win32 interoperability, Windows
Print Spooler/PrintTicket APIs, IPP, then vendor SDK only when required.

**Modules:** kiosk agent Windows/device host; printer-adapters/windows and ipp;
docs/hardware/printer-compatibility.md.

**Endpoints/entities:** agent register, heartbeat, capabilities, command
claim/lease/status; printers, capabilities, health, agent_job_leases.

**Tests:** Microsoft Print to PDF for integration only; paused/offline queue;
cancel; spooler and agent restart; capability mapping; each certified physical
printer/driver/firmware combination.

**Done:** the Windows test machine prints one normalized PDF and restart does
not duplicate output; status confidence is explicit.

**Avoid:** shell Print verbs, parsing PowerShell as the long-term API, assuming
spooler completion means paper output, arbitrary queues, and uncertified
driver versions.

### Phase 11 — production hardening and multi-kiosk pilot

**Objective:** make a small fleet operable, supportable, and safe.

**Build:** per-device certificates and rotation; signed updates; managed data
services; OIDC/MFA/RBAC admin; Windows Assigned Access and application
allowlisting; TLS/network segmentation; telemetry/alerts; offline outbox and
reconciliation; deployment rings/rollback; backup restore; runbooks; privacy,
incident, retention, vendor, and penetration reviews.

**Tools:** managed OIDC, OpenTelemetry, Pino, Sentry without replay/screens on
document views, Prometheus/Grafana or managed equivalents, CI, Trivy, Semgrep,
Gitleaks, dependency scanning, secret manager.

**Modules:** apps/admin; API admin/device-sync; packages/telemetry;
infrastructure/cloud and windows; docs/runbooks/security/privacy.

**Endpoints/entities:** admin fleet/jobs/pricing/audit; agent sync/heartbeat/
commands; private metrics; admin_users/roles, kiosk_credentials, heartbeats,
sync_operations, security_events.

**Tests:** threat review and external penetration test; kiosk escape; RBAC
matrix; credential rotation; offline/reconcile; restore/rollback; load/soak;
expired cert; alert and incident exercise.

**Done:** a pilot kiosk can be observed, updated, disabled, reconciled, and
recovered without raw card data or document access in admin tooling.

**Avoid:** fleet-wide secrets, public inbound agent ports, local-admin kiosk
processes, offline payment invention, unredacted observability, and launch
without rollback or hardware certification.

## 8. Temporary session design

### 8.1 Session record

Each session contains:

- id: internal UUIDv7
- public_id: independent opaque identifier used in the mobile route
- kiosk_id
- short_code_digest and upload_grant_digest, never raw secrets
- created_at, idle_expires_at, hard_expires_at, updated_at
- workflow state and monotonically increasing state_version
- ordered file references and current settings revision
- active quote ID and calculated money snapshot
- payment summary and print-job reference
- cleanup_due_at, cleanup status, and terminal reason

Do not embed every file, payment, or job detail in this row. Those are related
entities with their own state machines.

### 8.2 Recommended states

Session:

~~~text
CREATED -> WAITING_FOR_UPLOAD -> FILES_UPLOADED -> CONFIGURING
                                      ^               |
                                      |               v
                                      +------ AWAITING_PAYMENT
                                                   |
                                                   v
                                                PAID
                                                   |
                                                   v
                                               PRINTING
                                              /    |    \
                                     COMPLETED  FAILED  RECOVERY_REQUIRED
~~~

Pre-payment active states may also move to CANCELED or EXPIRED.
RECOVERY_REQUIRED is deliberately added to the example list: it means a command
may have reached the physical printer but definite output cannot be established.
It prevents an unsafe automatic reprint.

Related states:

~~~text
File:    UPLOADING -> QUARANTINED -> VALIDATING -> READY
                                         \-------------> REJECTED
          READY/REJECTED -> DELETING -> DELETED

Payment: CREATED -> PENDING -> AUTHORIZED -> CAPTURED
                    |             |            |
                    +-> DECLINED   +-> CANCELED +-> REFUND_PENDING -> REFUNDED
                    +-> TIMED_OUT

Print:   QUEUED -> SUBMITTING -> ACCEPTED -> PRINTING -> SUCCEEDED
                    |              |            |
                    +-> FAILED      +-----------> STATUS_UNKNOWN
                                   \------------> CANCELED
~~~

### 8.3 Allowed session transitions

| From | To | Guard |
|---|---|---|
| CREATED | WAITING_FOR_UPLOAD | token digest, code, and expiry created atomically |
| WAITING_FOR_UPLOAD | FILES_UPLOADED | first file reaches READY |
| FILES_UPLOADED | WAITING_FOR_UPLOAD | last READY file removed |
| FILES_UPLOADED | CONFIGURING | valid settings revision saved |
| CONFIGURING | FILES_UPLOADED | settings deliberately reset |
| CONFIGURING | WAITING_FOR_UPLOAD | last READY file removed |
| FILES_UPLOADED or CONFIGURING | AWAITING_PAYMENT | current manifest/settings quoted and locked |
| AWAITING_PAYMENT | CONFIGURING | decline/cancel/timeout is authoritative and lock is released |
| AWAITING_PAYMENT | PAID | verified capture for exact active quote |
| PAID | PRINTING | unique durable job exists and local adapter accepted it |
| PRINTING | COMPLETED | definite success |
| PRINTING | FAILED | definite no-output, unrecoverable result |
| PRINTING | RECOVERY_REQUIRED | physical result uncertain |
| Active pre-payment state | CANCELED | guarded customer/kiosk cancellation |
| Active pre-payment state | EXPIRED | database expiry worker wins |
| FAILED | PRINTING | audited operator retry only when no output is certain |

COMPLETED, CANCELED, and EXPIRED are terminal. A paid session never silently
expires. A late capture enters refund/recovery handling.

### 8.4 Enforcing correctness

1. Only domain services request transitions; controllers and clients never set
   a state directly.
2. Update using a row lock or compare-and-swap on current state and version.
   Zero changed rows means 409 invalid state or 412 stale version.
3. Commit transition, audit row, and outbox event in one PostgreSQL
   transaction.
4. Any file/order/range/settings change invalidates a quote.
5. AWAITING_PAYMENT locks an ordered manifest, settings revision, pricing
   version, total, currency, and hash.
6. Payment must exactly match that unexpired quote.
7. A unique constraint permits at most one captured payment lineage and one
   logical print job per session.
8. Every external operation has a stable ID. Repeated delivery returns the
   prior provider/spooler mapping.
9. Expiration uses the database clock; user devices cannot extend it.
10. For the MVP a partial unique index allows one active session per kiosk.

## 9. QR upload flow

### 9.1 URL contents

Use a URL such as:

~~~text
https://upload.example.test/s/ps_7Jk2mQf9Cw4nT8x#t=u_example-256-bit-random-value
~~~

- ps_... is an opaque public ID with at least 128 bits of randomness.
- u_... is a 32-byte, domain-separated HMAC-derived value encoded base64url.
  The server can reconstruct it for the original idempotent create retry
  without storing the bearer credential.
- The fragment is not sent in the HTTP path or ordinary Referer header. The
  mobile app reads it, exchanges it in a POST body, then calls
  history.replaceState to remove it.
- The URL contains no database ID, kiosk credential, customer information,
  filename, price, or settings.
- Store only an HMAC-SHA-256 digest using a server-side pepper.
- The QR grant is single-exchange by default and expires with the session.

### 9.2 Join and refresh

1. Mobile app loads from the public HTTPS origin.
2. It reads public ID from the route and token from the fragment.
3. POST /v1/mobile-auth/exchange atomically verifies digest, unused state,
   origin, expiry, session state, and uploader claim.
4. Server consumes the grant and issues a random scoped cookie:

~~~text
Set-Cookie: pk_upload_<session-id-without-dashes>=opaque;
HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=600
~~~

5. Browser removes the fragment and fetches a limited session snapshot.
6. Refresh works through the cookie. Neither token belongs in localStorage.

The first phone wins. A second gets 409 UPLOAD_GRANT_ALREADY_CLAIMED. To change
phones, the person uses a kiosk action that revokes the client, rotates the
grant, and displays a new QR. The kiosk should visibly announce a phone
connection and may show a two-word matching phrase so an unexpected connection
can be rejected.

If the session expires mid-upload, the server stops accepting the stream,
returns 410, aborts/deletes partial storage, revokes the grant/cookie, and emits
session.expired. A soft idle deadline may extend during an active resumable
upload, but not beyond a 30-minute hard maximum.

### 9.3 Numeric fallback code

Generate an eight-digit value with a CSPRNG or domain-separated HMAC derivation
and ensure uniqueness among active sessions.
It is guessable and is not sufficient authorization in production. Preferred
flow:

1. Phone submits the code through a heavily rate-limited route.
2. Server creates a pending claim and shows the same two-word phrase on phone
   and kiosk.
3. Customer approves on the physical kiosk.
4. Server issues the scoped cookie.

Limit attempts by IP, code, device, and time window; do not reveal whether a
specific expired/foreign session exists. A code-only prototype must be marked
development-only.

### 9.4 Browser security

- Public upload is HTTPS-only with HSTS in production.
- Use Referrer-Policy: no-referrer and a strict Content Security Policy.
- No analytics, tag manager, advertisements, chat widget, or third-party
  scripts on upload/preview pages.
- Prefer same-origin API; otherwise use an exact CORS list.
- Check Origin and use a CSRF token for cookie-authenticated mutations.
- Set Cache-Control: no-store on session and preview responses.

## 10. API specification

### 10.1 Conventions

- Base path /v1; JSON except multipart bodies and preview bytes.
- UTC ISO-8601 timestamps; UUIDv7 internal IDs; separate public IDs.
- Mutations require Idempotency-Key. Same key/body returns the stored result;
  same key/different body returns 409 IDEMPOTENCY_KEY_REUSED.
- Responses include session version; concurrent updates use If-Match.
- Kiosk auth is a per-device scoped credential. MVP uses a hashed development
  key; production uses a certificate or short-lived device token.
- Mobile auth is the scoped cookie. Admin uses OIDC/MFA/RBAC. Agent uses mTLS
  or a short-lived workload identity. Webhooks verify signature over raw bytes.
- Cross-session resource access returns 404 to avoid disclosing existence.

Standard error:

~~~json
{
  "error": {
    "code": "INVALID_SESSION_STATE",
    "message": "Settings cannot change while payment is pending.",
    "requestId": "req_01J...",
    "details": {
      "currentState": "AWAITING_PAYMENT"
    }
  }
}
~~~

Common statuses: 400 syntax, 401 credential, 403 scope, 404 hidden/not found,
409 conflict, 410 expired/cleaned, 412 version, 413 size, 415 media, 422 domain
validation, 423 locked, 429 rate limit, and 503 dependency unavailable.

### 10.2 Create session

~~~http
POST /v1/kiosks/k_01J/sessions
Authorization: Bearer development-device-token
Idempotency-Key: 6db7...
Content-Type: application/json

{"locale":"en"}
~~~

~~~json
{
  "session": {
    "id": "0190efb7-0000-7000-8000-000000000001",
    "publicId": "ps_7Jk2mQf9Cw4nT8x",
    "kioskId": "k_01J",
    "locale": "en",
    "state": "WAITING_FOR_UPLOAD",
    "version": 1,
    "expiresAt": "2026-07-12T10:15:00Z",
    "hardExpiresAt": "2026-07-12T10:35:00Z",
    "createdAt": "2026-07-12T10:05:00Z",
    "canceledAt": null
  },
  "upload": {
    "shortCode": "48392174",
    "qrUrl": "https://upload.example.test/s/ps_7Jk2mQf9Cw4nT8x#t=u_not-real"
  }
}
~~~

Auth: owning active kiosk with sessions:create. Validate one active session,
server-selected expiry, locale allowlist. Errors: 401, 403 KIOSK_DISABLED, 409
ACTIVE_SESSION_EXISTS, 503. Return the raw QR grant only here or on rotation.
The touchscreen reaches this operation through the loopback agent facade; the
device bearer/certificate is never placed in browser JavaScript.

### 10.3 Retrieve session

~~~http
GET /v1/sessions/0190efb7-...
Authorization: Bearer device-token
~~~

~~~json
{
  "session": {
    "id":"0190efb7-0000-7000-8000-000000000001",
    "publicId":"ps_7Jk2mQf9Cw4nT8x",
    "kioskId":"k_01J",
    "locale":"en",
    "state":"WAITING_FOR_UPLOAD",
    "version":1,
    "expiresAt":"2026-07-12T10:15:00Z",
    "hardExpiresAt":"2026-07-12T10:35:00Z",
    "createdAt":"2026-07-12T10:05:00Z",
    "canceledAt":null
  }
}
~~~

Auth: owning kiosk. The mobile client gets its limited projection from the
mobile context route and lists files separately. Validate ownership and
non-cleaned status. Errors: 401, 404, 410.

### 10.4 Join with QR grant

~~~http
POST /v1/mobile-auth/exchange
Origin: https://upload.example.test
Content-Type: application/json

{
  "publicSessionId":"ps_7Jk2mQf9Cw4nT8x",
  "uploadToken":"u_not-a-real-secret",
  "clientNonce":"0190efb7-0000-7000-8000-000000000010"
}
~~~

~~~json
{
  "session": {
    "id":"0190efb7-0000-7000-8000-000000000001",
    "publicId":"ps_7Jk2mQf9Cw4nT8x",
    "locale":"en",
    "state":"WAITING_FOR_UPLOAD",
    "version":1,
    "expiresAt":"2026-07-12T10:15:00Z",
    "hardExpiresAt":"2026-07-12T10:35:00Z"
  },
  "csrfToken":"c_not-a-real-secret",
  "limits": {
    "maxFiles":1,
    "maxFileBytes":52428800,
    "maxTotalBytes":52428800,
    "allowedMimeTypes":["application/pdf","image/jpeg","image/png"]
  }
}
~~~

Auth: raw one-time grant, replaced by Set-Cookie. Validate exact origin, digest,
unused/unexpired state and uploader claim atomically. Errors: 401
INVALID_UPLOAD_GRANT, 409 UPLOAD_GRANT_ALREADY_CLAIMED, 410, 429.

### 10.5 Upload a file

~~~http
POST /v1/sessions/0190efb7-0000-7000-8000-000000000001/files
Cookie: pk_upload_0190efb7000070008000000000000001=opaque
X-CSRF-Token: ...
X-Client-File-Id: 0190efb7-0000-7000-8000-000000000011
X-File-Size: 182430
Idempotency-Key: 0190efb7-0000-7000-8000-000000000012
Content-Type: multipart/form-data

file=@synthetic.pdf
~~~

~~~json
{
  "file":{
    "id":"0190efb7-0000-7000-8000-000000000002",
    "ordinal":0,
    "status":"QUARANTINED",
    "kind":"PDF",
    "sizeBytes":182430,
    "createdAt":"2026-07-12T10:06:00Z"
  }
}
~~~

Return 202. Stream with a byte counter and hash; never buffer the full body.
Validate editable state, count/byte/duration caps, preliminary extension/MIME/
signature, storage success, and mobile scope. READY requires asynchronous deep
validation. Errors: 401, 404, 409/423, 413, 415, 429, 503.

At scale, replace proxy bytes with initiate/complete presigned multipart
operations, but never skip server-side finalization and validation.

### 10.6 List and delete files

~~~http
GET /v1/sessions/0190efb7-0000-7000-8000-000000000001/files
Cookie: pk_upload_0190efb7000070008000000000000001=opaque
~~~

~~~json
{"items":[{"id":"0190efb7-0000-7000-8000-000000000002","ordinal":0,"status":"QUARANTINED","kind":"PDF","sizeBytes":182430,"createdAt":"2026-07-12T10:06:00Z"}]}
~~~

~~~http
DELETE /v1/sessions/0190efb7-0000-7000-8000-000000000001/files/0190efb7-0000-7000-8000-000000000002
Cookie: pk_upload_0190efb7000070008000000000000001=opaque
X-CSRF-Token: ...
Idempotency-Key: 0190efb7-0000-7000-8000-000000000013
~~~

GET requires owning kiosk/mobile claim; errors 401, 404, 410. DELETE returns
204, including an idempotent replay. It is allowed only before manifest lock,
invalidates the quote, and schedules every derivative for cleanup. Errors: 404,
409/423, 410.

### 10.7 Update settings

~~~http
PUT /v1/sessions/0190efb7-.../settings
Authorization: Bearer device-token
If-Match: "session-v7"
Idempotency-Key: settings-revision-3
Content-Type: application/json

{
  "fileOrder":["f_01J"],
  "fileSelections":[{"fileId":"f_01J","pageRanges":"1-3"}],
  "copies":2,
  "duplex":"LONG_EDGE",
  "paperSize":"A4",
  "orientation":"AUTO",
  "scaling":"FIT",
  "collate":true
}
~~~

~~~json
{
  "settings":{"revision":3,"copies":2,"normalizedPageRanges":[[1,3]]},
  "sessionVersion":8,
  "quoteInvalidated":true
}
~~~

Auth: owning kiosk. Replace the whole settings document. Validate READY files,
ranges, bounds, order uniqueness, current capabilities, and unlocked state.
Errors: 404, 409/423, 412, 422 UNSUPPORTED_PRINT_SETTING.

### 10.8 Calculate price

~~~http
POST /v1/sessions/0190efb7-.../quotes
Authorization: Bearer device-token
Idempotency-Key: quote-settings-3
Content-Type: application/json

{"settingsRevision":3}
~~~

~~~json
{
  "quote":{
    "id":"q_01J",
    "settingsRevision":3,
    "pricingVersion":"price-v4",
    "currency":"AMD",
    "printedSides":6,
    "physicalSheets":4,
    "subtotalMinor":70000,
    "taxMinor":14000,
    "totalMinor":84000,
    "expiresAt":"2026-07-12T10:10:00Z"
  }
}
~~~

Auth: owning kiosk. The request never contains a price. Validate current
manifest/settings/capabilities, all READY files, pricing version, and at least
one page. Errors: 409 FILES_STILL_PROCESSING, 412, 422, 503.

### 10.9 Start and confirm simulated payment

~~~http
POST /v1/sessions/0190efb7-.../payments
Authorization: Bearer device-token
Idempotency-Key: pay-q_01J
Content-Type: application/json

{"quoteId":"q_01J","provider":"MOCK"}
~~~

~~~json
{"payment":{"id":"pay_01J","status":"PENDING","amountMinor":84000,"currency":"AMD"}}
~~~

~~~http
POST /v1/payments/pay_01J/confirm
Authorization: Bearer device-token
Idempotency-Key: confirm-pay_01J
~~~

~~~json
{"payment":{"id":"pay_01J","status":"PENDING"}}
~~~

Auth: kiosk; development-only test token controls
POST /v1/test/payments/:id/outcomes with outcome SUCCEEDED, DECLINED, CANCELED,
or TIMEOUT and optional delay/duplicate callback count. Validate unexpired
unchanged quote, exact server amount/currency, provider availability, and no
capture. Errors: 409 QUOTE_STALE or PAYMENT_ALREADY_CAPTURED, 422
QUOTE_EXPIRED, 503. A decline is normally HTTP success with domain state.

### 10.10 Submit and retrieve print job

Verified capture should automatically create the unique job through the
transactional outbox. Keep submission as an idempotent recovery action.

~~~http
POST /v1/sessions/0190efb7-.../print-jobs
Authorization: Bearer device-token
Idempotency-Key: print-session-0190efb7
Content-Type: application/json

{"paymentId":"pay_01J","quoteId":"q_01J"}
~~~

~~~json
{"printJob":{"id":"pj_01J","status":"QUEUED","operationId":"print:0190efb7:1"}}
~~~

~~~http
GET /v1/print-jobs/pj_01J
Authorization: Bearer device-token
~~~

~~~json
{
  "id":"pj_01J",
  "status":"PRINTING",
  "adapter":"MOCK",
  "deviceJobId":"mock-217",
  "resultConfidence":"DEVICE",
  "lastStatusAt":"2026-07-12T10:06:03Z"
}
~~~

Auth: owning kiosk or admin for GET. Validate captured payment, exact quote and
session, normalized artifact existence and digest, and unique operation.
Errors: 404, 409 PAYMENT_NOT_CAPTURED, 410 FILES_CLEANED, 503. Replay returns
the same logical job.

### 10.11 Cancel session

~~~http
POST /v1/sessions/0190efb7-.../cancel
Authorization: Bearer device-token
Idempotency-Key: cancel-0190efb7
Content-Type: application/json

{"reason":"CUSTOMER_CANCELED"}
~~~

~~~json
{"sessionId":"0190efb7-...","state":"CANCELED","cleanupStatus":"PENDING"}
~~~

Allowed before capture. If payment is pending, cancel the provider intent and
guard against late capture. After capture return 409 PAYMENT_ALREADY_CAPTURED
and use fulfillment/refund recovery. Replay returns the same result.

### 10.12 Real-time event contract

~~~json
{
  "eventId":"evt_01J",
  "sessionId":"0190efb7-...",
  "sequence":42,
  "sessionVersion":6,
  "occurredAt":"2026-07-12T10:04:18Z",
  "type":"file.ready",
  "payload":{"fileId":"f_01J","displayName":"Document 1.pdf","pageCount":3}
}
~~~

Delivery is at least once. Client deduplicates eventId/sequence; after a gap it
calls GET snapshot and GET events?after=N. Persist in PostgreSQL; Redis only
accelerates fan-out. Heartbeat every 15–30 seconds and throttle upload progress
to about once per second or five-percent change.

Events:

- mobile.claim.requested, mobile.connected, mobile.disconnected
- file.upload.started, file.upload.progress, file.upload.received
- file.validation.started, file.ready, file.rejected, file.deleted,
  files.reordered
- settings.updated, quote.created, quote.invalidated
- payment.pending, payment.succeeded, payment.failed
- print.queued, print.started, print.completed, print.failed,
  print.status_unknown
- session.canceled, session.expired, session.completed
- cleanup.completed for operations/agent consumers

Payloads never contain raw tokens, card data, object keys/signed URLs, document
bytes, or detailed malware output.

## 11. PostgreSQL, Redis, and object-storage design

Use text plus check constraints for frequently evolving status values rather
than hard-to-change PostgreSQL enum types. Use timestamptz, foreign keys,
nonnegative checks, unique constraints, and transactional migrations.

### 11.1 Core tables

**kiosks**

- Fields: id, public_code, name, site_id, status, timezone, capabilities JSON,
  capabilities_version, config_version, last_seen_at, timestamps.
- Relationships: sessions, credentials, printers, heartbeats.
- Indexes: unique public_code; status; site_id/status; last_seen_at.
- Cleanup: retain as business/fleet metadata; revoke credentials on retirement.

**kiosk_credentials**

- Fields: kiosk_id, credential_id, digest or certificate thumbprint, scopes,
  issued_at, expires_at, revoked_at, last_used_at.
- Indexes: unique credential_id; active credentials by kiosk.
- Never store a plaintext long-lived device secret.

**print_sessions**

- Fields: id, public_id, kiosk_id, state, state_version, idle_expires_at,
  hard_expires_at, current_settings_revision, active_quote_id, cleanup_due_at,
  cleanup_status/lease/attempts/last_error, terminal/failure code, created,
  updated, completed/canceled/expired/files_deleted timestamps.
- Indexes: unique public_id; kiosk_id/created_at; active expiry; due cleanup;
  partial unique active session per kiosk.
- Cleanup: scrub transient document metadata and retain a minimal tombstone
  tied to accounting/audit requirements.

**session_upload_grants**

- Fields: id, session_id, token_digest, status, expires_at, claimed_client_id,
  claimed/revoked/created timestamps.
- Indexes: unique digest; session/status.
- Cleanup: revoke at terminal state and delete after the audit window.

**mobile_clients**

- Fields: id, session_id, cookie_digest, status, matching_phrase, expires_at,
  last_seen_at, created/revoked timestamps.
- Indexes: unique cookie digest; session/status.
- Do not create invasive device fingerprints.

**uploaded_files**

- Fields: id, session_id, ordinal, display_name, state, declared/detected MIME,
  size, page count, dimensions, content hash, malware_scan_status, rejection code,
  original/normalized object keys, preview prefix, created/ready/deleted times.
- Relationships: file pages/derivatives and settings selections.
- Indexes: session/ordinal; session/status; status/created_at for stuck work;
  unique non-null object keys.
- Cleanup: remove bytes first, then scrub names, hashes, parser details and keys.

**file_pages and file_derivatives**

- Fields: file ID, type/revision/page, object key, size, hash, dimensions,
  created/deleted timestamps.
- Unique file/type/revision/page. These form the artifact ledger for cleanup.

**print_setting_revisions**

- Append-only key session_id/revision; copies, duplex, paper,
  orientation, scaling, collate; ordered files and selections;
  capability version; manifest hash; created_at.
- A quote references one exact revision. Never update it in place.

**pricing_rule_sets and pricing_rules**

- Rule-set fields: ID/version, currency, scope/site, validity, status, rounding,
  tax mode. Rule fields: service, paper, monochrome unit amount, duplex
  adjustment, service/minimum/tax/promotion properties, priority.
- Unique published version and non-overlapping validity per scope.
- Published sets are immutable; corrections create another version.

**price_quotes**

- Fields: id, session, settings revision, manifest hash, rule-set ID, status,
  currency, subtotal/tax/total integer minor amounts, breakdown JSON, expiry,
  timestamps.
- Indexes: session/created desc; status/expiry.
- Retain the numeric/commercial snapshot, not customer file identity.

**payments and payment_attempts**

- Fields: IDs, session/quote, provider, provider intent/reference, state,
  integer amount, currency, request fingerprint, failure code, captured/refund
  timestamps.
- Constraints: unique provider/provider_intent_id; one captured lineage per
  session; amount/currency equals quote.
- Keep the accounting record according to law/provider rules; no card data.

**payment_webhook_inbox and refunds**

- Inbox primary key provider/provider_event_id; payload digest, received and
  processed time/result. Refund links original payment, provider reference,
  reason, amount, state, and idempotency key.
- Duplicate webhook insertion is acknowledged and ignored.

**print_jobs**

- Fields: ID, session/payment/quote, logical attempt, unique operation_id,
  adapter/agent, device job ID, state, immutable settings and artifact
  manifests, error/retryability/result confidence, queued/submitted/started/
  completed/last-status times.
- Unique session for the MVP and unique operation ID. Later, keep one logical
  job with child attempts rather than losing its identity.

**print_job_events and agent_commands**

- Append-only status observations with source/confidence/sequence; durable
  signed command, lease owner/expiry, acknowledgement, payload hash.

**audit_events**

- Fields: ID/time, actor type/ID, kiosk/session, action, outcome, request ID,
  redacted metadata.
- Index session/time and actor/time; partition by time only when scale needs it.
- Never store document bytes, token, signed URL, card data, or filename.

**admin_users**

- Fields: ID, OIDC subject, normalized email, status, role links, MFA policy,
  last login and timestamps.
- Unique OIDC subject. Do not build local password storage for the MVP.

**outbox_events, idempotency_records, cleanup_runs**

- Outbox: aggregate ID, per-session sequence, type, redacted payload, publish
  attempts/status.
- Idempotency: actor/action/context-bound key digest, request hash, sanitized
  response/resource, expiry; unique actor/action/key digest. Never persist a
  raw key or credential-bearing response.
- Cleanup: session, lease, checkpoint/status, attempts/error/next retry.

### 11.2 What belongs in Redis

Use Redis for:

- rate-limit counters;
- mobile/kiosk presence with TTL;
- BullMQ validation, preview, expiration, cleanup, reconciliation and print
  dispatch jobs;
- Socket.IO fan-out;
- short efficiency locks/leases;
- short-lived resumable upload coordination and capability/price cache.

Queue messages contain opaque IDs, not filenames, tokens, URLs or bytes.
PostgreSQL guards every critical transition even if Redis provided a lock.
Losing Redis may delay work; it must not erase payment, print, or audit truth.

### 11.3 Object layout and policy

Suggested private keys:

~~~text
incoming/kiosk-id/session-id/file-id/random
originals/kiosk-id/session-id/file-id/random
normalized/kiosk-id/session-id/file-id/revision.pdf
previews/kiosk-id/session-id/file-id/revision/page.webp
~~~

Keys contain only generated identifiers. Incoming objects are never readable
by browsers. Preview reads use authorization or signed URLs lasting 30–60
seconds. Block public access/listing, enable encryption, restrict CORS, abort
multipart remnants, and use a dedicated temporary bucket. Object versioning,
replication, object lock, and long backups can defeat privacy deletion; keep
them off unless a specific policy handles every copy.

Lifecycle deletion at 24 hours is a backstop. Application cleanup should
normally finish in minutes.

## 12. Secure file handling and processing

### 12.1 Initial limits

Make these configuration values, with the following conservative MVP defaults:

- formats: PDF, JPEG, PNG only;
- 10 files per session;
- 50 MiB per file and 150 MiB total received bytes;
- 200 selected/validated pages total;
- image maximum 20,000 pixels per dimension and 40 megapixels decoded;
- processing timeout 120 seconds per file, with CPU/RAM/process limits;
- maximum 20 copies and a configured maximum total printed sides;
- 10-minute idle session, 30-minute absolute lifetime.

These limits protect cost and availability, not just storage. Adjust only after
measurement on the actual controller and renderer.

### 12.2 Validation pipeline

1. Authorize session before reading a body.
2. Stream into a random quarantine object while enforcing bytes/time and
   computing SHA-256. Never assemble the whole file in API memory.
3. Normalize a short display name; never use it as a path, shell input, object
   key, or log field.
4. Require an allowed extension and claimed MIME, but do not trust either.
5. Check signature: PDF header/parser, JPEG magic, or PNG signature. Use
   file-type as an early test and the actual decoder/parser as authority.
6. Reject zero-byte, polyglot/unexpected trailing content where detectable,
   malformed, encrypted/password-protected PDFs, excessive pages, dimensions,
   pixels, nesting, time, or memory.
7. Scan inside owned infrastructure with ClamAV or the selected enterprise
   engine. Never submit private documents to public malware-analysis sites.
8. Run qpdf structure checks and page metadata inside a disposable non-root,
   no-network sandbox. Invoke programs with argument arrays, never a shell
   command assembled from user input.
9. Decode JPEG/PNG with sharp limitInputPixels; apply EXIF orientation; strip
   metadata and embedded profiles not required by the print policy; re-encode.
10. Generate inert page thumbnails and a normalized PDF.
11. Atomically mark READY only when every required derivative and metadata row
   exists. Otherwise mark REJECTED and enqueue artifact cleanup.

Archives are rejected, so normal ZIP archive bombs are out of scope. PDF object
streams and compressed images can still be decompression bombs; decoded pixel,
page, CPU, memory, process, disk, output-size, and time limits are mandatory.

### 12.3 Originals and canonical output

Keep the immutable original only until retention cleanup for investigation of
processing discrepancies; customers and administrators do not download it.
Store previews and normalized output as separate derived rows. Assemble the
final ordered/imposed print-ready PDF only after settings lock, and record its
hash in the job manifest. Never send customer PCL/PostScript or arbitrary raw
data directly to a device.

PDF.js, qpdf, Poppler/MuPDF/Ghostscript-like tools, fonts, and manufacturer
drivers have different security and licensing characteristics. Benchmark
fidelity and complete legal review before choosing the distributable
production renderer.

## 13. Document preview

Use both backend and browser, with clear authority:

- Backend validates content, produces canonical WebP thumbnails, counts pages,
  normalizes page ranges, calculates imposition geometry, sheet/side totals,
  and price.
- Browser renders the responsive UI, thumbnails, reorder controls, selections,
  and a canvas/CSS approximation. PDF.js may provide zoom only after validation
  and through an authenticated source.
- Never load the raw quarantined file into the kiosk or a native viewer.

Kiosk features:

1. File strip with generic safe display names, status and page count.
2. Page grid/lazy loading; zoomed page view.
3. Drag or large-button file reorder with an accessible alternative.
4. Remove before payment lock.
5. Page-range input plus page selection UI; backend returns canonical ranges.
6. Paper outline showing portrait/landscape, margins, fit/fill,
   duplex front/back grouping and approximate crop.
7. Monochrome mode applies a display filter labeled as an approximation.
8. Persistent summary of selected document pages, printed sides, physical
   sheets, copies and price.
9. Every settings change invalidates the current quote and requests another
   server calculation, with debounce.

The monochrome preview is an approximation and cannot guarantee the printer
contrast or printable area until a real capability snapshot exists. State this in the UI. For the MVP
start each input file on a new sheet boundary; show this explicitly. Continuous
cross-file imposition can be added later with matching preview and pricing.

## 14. Pricing engine

The pricing package is a pure deterministic function. Its inputs are normalized
file/page selections, settings, printer capability snapshot, immutable rule
version, tax context, and currency. It returns a detailed breakdown and no side
effects.

For each file in the MVP:

~~~text
logicalPages = count of selected normalized page ranges
printedSidesPerCopy = logicalPages
printedSides = printedSidesPerCopy * copies

simplexSheets = printedSidesPerCopy * copies
duplexSheets = ceil(printedSidesPerCopy / 2) * copies
~~~

Duplex changes sheets, not inked sides. Unless the published rule says
otherwise, charge by printed side:

~~~text
printCharge =
  sum(printedSides by paper size * monochrome unit amount per side)

adjusted =
  printCharge with versioned duplex adjustment in integer basis points
  + service fee
  - valid promotions

minimumAdjusted = max(adjusted, minimum transaction amount)
tax = definedIntegerRounding(minimumAdjusted * taxBasisPoints / 10000)
total = minimumAdjusted + tax
~~~

Example using cents:

- five pages, two copies, two pages per side, duplex;
- A4 monochrome at 12 cents per printed side;
- service fee 20 cents; pre-tax minimum 100 cents; tax 10 percent.

~~~text
sides per copy = ceil(5 / 2) = 3
total sides = 3 * 2 = 6
sheets = ceil(3 / 2) * 2 = 4
print = 6 * 12 = 72 cents
with service fee = 92 cents
minimum adjustment = 8 cents
tax = 10 cents
total = 110 cents
~~~

Represent money as integer provider/ISO minor units and explicit currency.
Define the currency exponent, rounding point, whether tax is included, and
whether the minimum applies before or after tax. For a provider using two
decimal minor units, 840.00 AMD is stored as 84000, not 840. Have a local
accountant validate tax/receipt rules before real sales.

The browser may estimate, but it never supplies a payable total. The server
reads verified page counts and current capability, pins the rule version and
manifest hash, stores the quote, and rechecks it before creating payment.

## 15. Payment simulation and future providers

### 15.1 Adapter contract

~~~ts
type Money = {
  amountMinor: number;
  currency: string;
};

interface PaymentProvider {
  createIntent(input: {
    paymentId: string;
    sessionId: string;
    amount: Money;
    idempotencyKey: string;
  }): Promise<{
    providerIntentId: string;
    status: "PENDING" | "AUTHORIZED" | "CAPTURED";
  }>;

  confirm(providerIntentId: string, idempotencyKey: string):
    Promise<{ status: string }>;

  cancel(providerIntentId: string, idempotencyKey: string):
    Promise<{ status: string }>;

  refund(input: {
    providerIntentId: string;
    amount: Money;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ providerRefundId: string; status: string }>;

  verifyAndParseWebhook(rawBody: Uint8Array, headers: Record<string, string>):
    Promise<{
      providerEventId: string;
      providerIntentId: string;
      type: string;
    }>;
}
~~~

The mock has deterministic scenarios: SUCCEEDED, DECLINED, CANCELED, TIMEOUT,
delayed result, duplicate/out-of-order webhook, and provider unavailable.
Production builds must omit its control route.

Keep provider orchestration separate from a local device adapter:

~~~ts
interface PaymentTerminalAdapter {
  present(input: {
    paymentId: string;
    providerIntentId: string;
    amount: Money;
    idempotencyKey: string;
  }): Promise<{ terminalTransactionId: string }>;
  getStatus(id: string): Promise<
    "PENDING" | "APPROVED" | "DECLINED" | "CANCELED" | "UNKNOWN"
  >;
  cancel(id: string): Promise<void>;
}
~~~

- Card/contactless: cloud pins amount/intent; certified local terminal captures
  it and returns only a reference/status.
- Provider QR payment: provider returns a time-limited display payload; signed
  webhook or reconciliation is authoritative.
- Online gateway: provider-hosted page/SDK with tokenization; never a kiosk
  card-number form.
- Cash/coin: a local acceptor adapter emits validated denomination/escrow
  events linked to the payment ID. Cash cannot use a normal card refund, so
  change, escrow return, overpayment, jam and power-loss policies must be
  explicitly designed before enabling it.

All methods enter the same payment ledger/state machine. Device events improve
the UI but cannot override the backend quote or create a second capture.

### 15.2 Idempotency and callbacks

1. Store actor/action/key, request hash and result.
2. Use deterministic downstream keys such as payment:ID:create,
   payment:ID:confirm, refund:ID:attempt, and print:session:1.
3. Unique provider intent and event IDs prevent duplicates.
4. Verify raw-body signature, timestamp tolerance, provider ID, amount and
   currency before processing.
5. Insert a webhook-inbox row first. A duplicate is a no-op returning 200.
6. State is monotonic: a late decline cannot overwrite CAPTURED.
7. In one transaction after capture: mark payment, move session to PAID, create
   the unique print job/command, and write outbox rows.
8. An agent may receive a command repeatedly; its local operation ledger maps
   it to the existing device job.

### 15.3 Print failure after payment

- Definite no output: request one idempotent full refund or issue a governed
  print credit.
- Definite partial output: policy-based refund/credit, normally reviewed.
- Unknown output: RECOVERY_REQUIRED; do not reprint or refund blindly.
- A late capture after cancel/expiry triggers recovery/refund, never silence.
- Refund is a new linked financial record; never rewrite the original capture.

### 15.4 PCI boundary

Use a semi-integrated, certified terminal or hosted gateway. The kiosk system
may see amount, currency, provider intent/token, terminal transaction ID, and
status. Raw PAN, track data, PIN, CVV, and contactless cryptograms must never
enter browser/app memory, API, database, screenshots, logs, or telemetry.
Point-to-point encryption and tokenization can reduce scope, but the payment
provider/acquirer must confirm the actual PCI obligations.

## 16. Working without a printer

### 16.1 Recommended order

1. Primary MVP: mock adapter copies the immutable print-ready PDF and a JSON
   manifest to var/mock-printer/output/job-id. It is deterministic, observable,
   CI-friendly, and does not open a print dialog.
2. Manual visual check: open the generated PDF or use the operating system
   Print to PDF queue. Microsoft Print to PDF can prompt for an output path and
   is not a dependable unattended production adapter.
3. Protocol simulation: run an IPP test printer such as an OpenPrinting
   development target and test submit/status/cancel mapping.
4. First hardware: certify one exact printer, connection, driver, firmware and
   paper configuration before general discovery is attempted.

Virtual PDF drivers and CUPS-PDF are useful on matching systems, but may have
installation, automation, licensing, and dialog behavior. The folder mock
remains the automated-test default.

### 16.2 Printer contract

~~~ts
export type DeviceHealth =
  | "READY"
  | "BUSY"
  | "DEGRADED"
  | "OFFLINE"
  | "ERROR";

export type PrintStatus =
  | "ACCEPTED"
  | "SPOOLING"
  | "PRINTING"
  | "COMPLETED_CONFIRMED"
  | "COMPLETION_UNVERIFIED"
  | "FAILED"
  | "CANCELED"
  | "STATUS_UNKNOWN";

export interface PrinterCapabilities {
  paperSizes: Array<"A4" | "LETTER">;
  duplexModes: Array<"SIMPLEX" | "LONG_EDGE" | "SHORT_EDGE">;
  trays: string[];
  canCancel: boolean;
  completionConfidence: "PHYSICAL" | "DEVICE" | "SPOOLER_ONLY";
}

export interface PrintSubmission {
  jobId: string;
  operationId: string;
  artifactPath: string;       // resolved by the agent, never browser input
  artifactSha256: string;
  settings: {
    copies: number;
    paperSize: "A4" | "LETTER";
    duplex: "SIMPLEX" | "LONG_EDGE" | "SHORT_EDGE";
    tray?: string;
  };
  mockScenario?: MockScenario;
}

export interface PrinterAdapter {
  getHealth(): Promise<{ state: DeviceHealth; reasons: string[] }>;
  getCapabilities(): Promise<PrinterCapabilities>;
  submit(input: PrintSubmission): Promise<{ deviceJobId: string }>;
  getStatus(deviceJobId: string): Promise<{
    status: PrintStatus;
    reason?: string;
    impressionsCompleted?: number;
  }>;
  cancel(deviceJobId: string): Promise<void>;
}
~~~

The adapter does not calculate price, decide retries, fetch arbitrary URLs, or
change session state. It translates a validated local artifact and generic
settings into device operations.

### 16.3 Mock implementation example

~~~ts
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type MockScenario =
  | "SUCCESS"
  | "OFFLINE"
  | "OUT_OF_PAPER"
  | "PAPER_JAM"
  | "LOW_TONER"
  | "CANCELED"
  | "TIMEOUT"
  | "UNKNOWN_AFTER_SUBMIT";

type StoredStatus = {
  status: PrintStatus;
  reason?: string;
  impressionsCompleted?: number;
};

export class MockPrinterAdapter implements PrinterAdapter {
  private readonly jobs = new Map<string, StoredStatus>();

  constructor(private readonly outputRoot: string) {}

  async getHealth() {
    return { state: "READY" as const, reasons: [] };
  }

  async getCapabilities(): Promise<PrinterCapabilities> {
    return {
      paperSizes: ["A4", "LETTER"],
      duplexModes: ["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"],
      trays: ["AUTO"],
      canCancel: true,
      completionConfidence: "DEVICE"
    };
  }

  async submit(input: PrintSubmission) {
    const existing = this.jobs.get(input.operationId);
    if (existing) return { deviceJobId: input.operationId };

    const scenario = input.mockScenario ?? "SUCCESS";
    if (scenario === "OFFLINE") throw new Error("PRINTER_OFFLINE");

    const deviceJobId = "mock-" + randomUUID();
    this.jobs.set(input.operationId, { status: "ACCEPTED" });

    const root = resolve(this.outputRoot);
    const staging = join(root, "." + input.jobId + ".tmp");
    const finalDirectory = join(root, input.jobId);
    await mkdir(staging, { recursive: true });
    await copyFile(input.artifactPath, join(staging, "output.pdf"));
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify({ ...input, artifactPath: undefined, deviceJobId }, null, 2),
      { encoding: "utf8", flag: "wx" }
    );
    await rename(staging, finalDirectory);

    queueMicrotask(() => this.finish(input.operationId, scenario));
    return { deviceJobId };
  }

  private finish(operationId: string, scenario: MockScenario) {
    const results: Record<MockScenario, StoredStatus> = {
      SUCCESS: { status: "COMPLETED_CONFIRMED" },
      OFFLINE: { status: "FAILED", reason: "PRINTER_OFFLINE" },
      OUT_OF_PAPER: { status: "FAILED", reason: "OUT_OF_PAPER" },
      PAPER_JAM: {
        status: "FAILED",
        reason: "PAPER_JAM",
        impressionsCompleted: 1
      },
      LOW_TONER: {
        status: "COMPLETED_CONFIRMED",
        reason: "LOW_TONER"
      },
      CANCELED: { status: "CANCELED" },
      TIMEOUT: { status: "FAILED", reason: "DEVICE_TIMEOUT" },
      UNKNOWN_AFTER_SUBMIT: { status: "STATUS_UNKNOWN" }
    };
    this.jobs.set(operationId, results[scenario]);
  }

  async getStatus(operationId: string) {
    return this.jobs.get(operationId) ??
      { status: "FAILED" as const, reason: "JOB_NOT_FOUND" };
  }

  async cancel(operationId: string) {
    this.jobs.set(operationId, { status: "CANCELED" });
  }
}
~~~

The production mock should persist the operation-to-device-job ledger in
SQLite, not an in-memory Map. Use an atomic staging-directory rename and verify
the artifact hash before accepting. The development API chooses a scenario;
never let a public customer control it.

### 16.4 Job orchestration example

~~~ts
async function dispatchPrintJob(jobId: string, adapter: PrinterAdapter) {
  const job = await printJobs.claimForSubmission(jobId);
  if (!job) return; // another worker or a completed replay owns it

  try {
    const prior = await localOperations.find(job.operationId);
    const submission = prior ?? await adapter.submit(job.submission);

    await localOperations.recordOnce({
      operationId: job.operationId,
      deviceJobId: submission.deviceJobId
    });

    await printJobs.markAccepted(job.id, submission.deviceJobId);

    const result = await adapter.getStatus(submission.deviceJobId);
    await printJobs.applyDeviceObservation(job.id, result);

    if (result.status === "COMPLETED_CONFIRMED") {
      await sessions.completeFromPrintJob(job.sessionId, job.id);
    } else if (
      result.status === "STATUS_UNKNOWN" ||
      result.status === "COMPLETION_UNVERIFIED"
    ) {
      await sessions.requireRecovery(job.sessionId, job.id);
    } else if (result.status === "FAILED") {
      await sessions.failFromPrintJob(job.sessionId, job.id, result.reason);
    }
  } catch (error) {
    await printJobs.recordDispatchError(job.id, classifyPrinterError(error));
    throw error; // BullMQ retries only errors classified safe before submission
  }
}
~~~

Status updates use guarded database transitions and an outbox event. Never
blindly retry after submit may have succeeded. Poll known device job IDs or
consume adapter notifications until terminal/timeout.

### 16.5 Swapping in real adapters

~~~ts
const printer: PrinterAdapter =
  config.printerAdapter === "mock"
    ? new MockPrinterAdapter(config.mockOutputDirectory)
    : process.platform === "win32"
      ? new WindowsSpoolerAdapter(windowsDeviceHost)
      : new IppOrCupsAdapter(ippClient);
~~~

WindowsSpoolerAdapter and IppOrCupsAdapter implement the same contract; session,
price, payment, worker, and kiosk UI code do not change.

## 17. Physical printer integration plan

### 17.1 Windows recommendation

- Keep React in Edge kiosk/Assigned Access and run the agent as a separate
  low-privilege Windows service.
- Add a narrow C#/.NET device host for Win32 spooler, PrintTicket/
  PrintCapabilities, WIA/TWAIN, or manufacturer interop. Communicate with the
  TypeScript agent over a named pipe or authenticated loopback RPC.
- Discover only an administrator-approved queue. Snapshot paper sizes, duplex,
  trays, resolutions and cancel capability before pricing. Force monochrome in
  normalization and again in the device adapter.
- Submit a normalized PDF through a controlled renderer into the Windows
  spooler; retain the OS job ID and opaque job name.
- Query/cancel through Print Spooler APIs. Some calls block, so keep them off
  UI and Node event-loop threads.
- Prefer an IPP/IPPS network printer using the Windows inbox IPP class driver
  when compatible. USB works, but ties the kiosk to local drivers and cabling.

Do not use a shell Print verb, automate Acrobat/viewer UI, or treat process exit
as success. Do not call WritePrinter with raw PDF unless the exact printer
declares native PDF support. Otherwise render to the spool format or supported
printer description language.

### 17.2 IPP, CUPS, PCL and PostScript

- IPP provides capability, submit, job query and cancellation operations; IPPS
  protects transport. It is preferable for replaceable network printers.
- CUPS is the Linux/macOS print-queue implementation and uses IPP. A future
  adapter can use the CUPS library or IPP directly; it is not the Windows
  production layer.
- PCL/PostScript may offer precise device control but couples output to device
  models and options. Generate it only from trusted normalized content. Never
  accept customer-supplied printer-language jobs.
- OS queues provide broad compatibility but their completed/removed state may
  mean only that bytes left the spooler, not that the last sheet exited.
- For reliable jams, consumables, page-out confirmation, finishing, secure
  output bins, or accounting counters, use IPP device status, secure management
  protocol, bidirectional driver data, or the manufacturer SDK.

Procurement must test IPPS, native PDF or renderer compatibility, duplex/tray
capability discovery, forced monochrome behavior, job ID/status/cancel,
internal disk retention, firmware support, SDK access, and exact failure
telemetry before purchasing a fleet.

## 18. Security and privacy checklist

Treat the touchscreen browser, phone browser, every uploaded file, local
network, and physical USB access as untrusted. Treat every document as
sensitive even if it appears harmless.

### 18.1 Public kiosk and Windows

- Use a standard non-admin interactive kiosk account and a separate
  non-interactive service identity.
- Configure Microsoft Edge kiosk mode with Windows Assigned Access. Permit only
  the local kiosk origin; block address bar, desktop, File Explorer, downloads,
  print dialogs, developer tools, context menu, clipboard, external protocols,
  new windows and navigation to other origins.
- Keyboard-shortcut blocking is defense in depth, not the boundary. Use
  Assigned Access plus Windows Defender Application Control/AppLocker and
  least privilege.
- Enable UEFI Secure Boot, TPM-backed BitLocker, firmware password, blocked
  external boot, automatic screen reset, and physically lock the cabinet.
- Restrict USB storage and new device installation while allowing only required
  hardware. Maintain a service procedure rather than granting public admin.
- Patch OS, browser, agent, drivers and firmware on a tested ring. Sign
  installers/updates, keep rollback, an SBOM and a support matrix.
- Disable Keep printed documents, recent-document history, thumbnails,
  hibernation where inappropriate, unnecessary crash dumps and verbose spooler
  names. Use opaque job IDs.
- Bind the local API to a named pipe or loopback only, authenticate it, enforce
  exact local origin, and expose no generic filesystem or command endpoint.
- Block inbound network access. Allow only required cloud, DNS/NTP, managed
  printer, terminal and management destinations.
- Design physical privacy: screen placement, shielded payment entry, enclosed
  output area, abandoned-paper procedure, and optional door/presence sensor.

### 18.2 API and browser

- Per-kiosk identity, scopes, rotation and revocation; never one fleet-wide
  key. Store private keys in Windows certificate/TPM facilities when possible.
- OIDC administrator identity with phishing-resistant MFA, short sessions,
  least-privilege roles and audited role changes.
- Upload cookie scoped to one session/action set; grant has 256-bit randomness,
  digest storage, short expiry and rotation.
- HTTPS/TLS, HSTS, no-referrer, private no-store cache controls, exact CORS,
  CSRF protection, Origin verification and secure cookie attributes.
- Strict CSP; React escaping; never use unsanitized innerHTML. Reject SVG/HTML
  rather than trying to sanitize active content.
- Zod schemas, ORM parameters, database constraints and authorization on every
  object lookup prevent injection and insecure direct object reference.
- Rate limits on session creation, code/token exchange, file count/bytes,
  processing concurrency, preview reads, quote and payment attempts.
- Safe server-generated paths/keys. Sanitize display names for length/control
  characters and render as text only.
- Do not return internal parser, antivirus, storage or device details to a
  customer. Use stable safe error codes and separate protected diagnostics.

### 18.3 Files and processors

- Allowlist PDF/JPEG/PNG and verify extension, declared type, magic signature
  and actual parser result.
- Quarantine; antivirus; bounded page/pixel/size/time checks; normalize before
  preview/print.
- Sandboxed non-root worker with no network, read-only root, disposable work
  directory and CPU/RAM/disk/process/time limits.
- Patch parsers quickly and run hostile fixtures in isolation.
- Never upload private files to a public malware scanning service.
- Never print original raw PDF/PCL/PostScript. Verify the normalized artifact
  hash locally before spooling.

### 18.4 Network and secrets

- Segment kiosk/controller, printer, payment, and management networks
  when practical. Prefer IPPS and authenticated secure management protocols.
- No printer, object store, Redis, database, admin panel or agent port is
  public.
- Encrypt in transit and at rest. Encrypt local cache with short-lived
  per-session keys and restrict filesystem ACLs.
- Production secrets go in a managed secret store, not source, images, .env,
  QR codes, registry plaintext or logs. Rotate and audit access.
- Use separate credentials and buckets/databases per environment.

### 18.5 Observability and administration

- Logs include request ID, opaque kiosk/session/job ID, action, duration and
  safe error code. Redact authorization, cookie, raw/body, QR URL, signed URL,
  object key, original filename, document hash/text and payment data.
- Disable session replay, screenshot capture and DOM/body capture on all
  document/upload/payment screens.
- Administrators see operational metadata, not previews or downloads. Avoid a
  support-document-access feature. If ever legally required, demand explicit
  consent, reason, dual authorization and immutable audit.
- Record authentication, pricing publication, device configuration, payment/
  refund, controlled reprint, cleanup override and administrator actions.
- Alert on cleanup backlog, repeated token guessing, malware/rejections,
  credential misuse, printer uncertainty, disk pressure and agent outage.

### 18.6 Privacy and consent

Before upload, show a short plain-language notice: purpose, supported formats,
limits, session expiry, deletion timing, print-failure/refund retention,
whether temporary cloud processing occurs, and support contact. Require an
affirmative continue action. Do not reuse documents or metadata for analytics,
training, marketing or troubleshooting.

Ordinary file deletion cannot promise immediate physical overwrite on SSDs,
cloud replicas, backups, Windows spool storage or printer disks. Use encryption
and crypto-erasure, short retention, no temporary-content backups/versioning,
provider lifecycle guarantees, device sanitization at retirement, and accurate
privacy language. Procurement must cover MFP internal storage.

## 19. File deletion and cleanup

### 19.1 Starting retention policy

| Condition | Document policy |
|---|---|
| Successful print | enqueue after 5–15 minute confirmation/receipt grace |
| Customer canceled | enqueue immediately |
| Session expired/no payment | enqueue immediately at expiry |
| Declined/canceled payment | enqueue when provider state is terminal |
| Payment timeout/unknown | reconcile first; bounded encrypted hold, then refund or cleanup |
| Definite recoverable paid print failure | explicit retry window, default no more than one hour for MVP |
| Unrecoverable or ambiguous print result | apply refund/review policy, then short grace and cleanup |

Do not retain files because support may want them. Retain minimal payment,
refund, quote and audit metadata according to legal/accounting policy, but scrub
object keys, filenames, hashes, preview references and parser details.

### 19.2 Complete artifact inventory

- unfinished multipart parts and quarantine object;
- immutable original;
- normalized per-file and final job PDF;
- thumbnails/page previews;
- worker scratch and renderer files;
- local encrypted cache and mock output;
- browser/CDN cache entries;
- Windows spool data and printer/MFP internal storage where controllable;
- Redis grants/presence/locks;
- transient filename/token metadata.

Keep customer bytes out of PostgreSQL, logs, analytics, crash dumps and ordinary
backups so those systems do not become additional cleanup targets.

### 19.3 Idempotent algorithm

1. Insert or claim cleanup_runs with a stable session cleanup ID and lease using
   FOR UPDATE SKIP LOCKED.
2. Mark cleanup PENDING/IN_PROGRESS without deleting the artifact ledger.
3. Revoke grants, mobile cookies and signed access; abort multipart uploads.
4. Delete every known incoming/original/normalized/preview object. Missing
   means success.
5. List the deterministic session prefix to find missed objects; delete them.
6. Send the agent a stable signed delete command. Its local watchdog also
   deletes expired cache if cloud is unavailable.
7. Remove Redis keys and private caches.
8. Scrub relational filename/hash/key/processing fields; preserve redacted
   tombstones and required financial/audit rows.
9. Verify no objects/local artifacts remain, set files_deleted_at and DONE, and
   write a metadata-only audit event.
10. On interruption, the lease expires and the same steps safely repeat.
    Backoff with jitter; dead-letter and alert after a threshold.

Run a periodic reconciler over stale object prefixes, multipart uploads and
local files not represented by active records. Bucket lifecycle and multipart
abort policies are independent 24-hour safety nets, not the primary deletion
mechanism.

## 20. Offline and unreliable-network behavior

Public QR upload needs a reachable public service. A local agent alone does not
make the customer's phone able to reach the kiosk. A kiosk hotspot/captive
portal/LAN upload with trusted HTTPS is a separate later product; exclude it
from the MVP.

| Failure | Behavior |
|---|---|
| Internet down before session | do not create a QR; show clear offline/health state; later local copy may be available under its payment policy |
| Drop during upload | mobile retries/resumes bounded chunks; never mark READY before final hash/validation; clean partials at hard expiry |
| Drop after payment before agent command | cloud keeps durable paid command; UI never requests payment again; agent claims after reconnect |
| Drop after signed command and artifact are cached | agent may finish locally, append events to SQLite, sync later |
| Drop before artifact cache | wait; do not invent authorization or print incomplete data |
| Cloud unavailable | finish only already cached authorized jobs; no new cloud upload/payment |
| Printer still local | health and cached paid jobs continue through agent |
| Status cannot upload | durable local event outbox with retry/backoff/jitter; server deduplicates |
| Agent restarts during print | reconcile stored device job ID with spooler; uncertain outcome never auto-reprints |
| Printer becomes unready | stop new checkout/payment before a paid backlog grows |

Local SQLite tables:

- commands(command_id unique, sequence, payload_hash, state, received_at);
- device_jobs(job_id unique, operation_id unique, device_job_id, last_state,
  confidence);
- event_outbox(event_id unique, job_id, sequence, payload, sent_at);
- cached_artifacts(artifact_id, hash, encrypted_path, expires_at);
- device_snapshots(device_id, capabilities_hash, health, observed_at).

A cloud command contains kiosk/job IDs, artifact digest, immutable settings and
quote/payment entitlement references, issued/expiry times, sequence and
signature. The agent verifies device scope, signature, time, sequence and
downloaded hash. Sync calls carry idempotency IDs and server acknowledgments;
acknowledged outbox rows can later be compacted.

Health reports software version, clock skew, disk space, local queue/cleanup
depth, last sync, device capabilities and printer/terminal state.
Reject new work when clock, disk, cache, or device readiness is unsafe. Use
exponential retry with randomized jitter and circuit breakers so a recovering
cloud is not flooded.

## 21. Testing strategy

### 21.1 Test layers and tools

**Unit — Vitest and fast-check**

- session/file/payment/print transition tables and forbidden transitions;
- token digest/expiry and page-range parsing;
- side/sheet counts, price rules, integer rounding and quote hashing;
- payment and webhook reducers/idempotency;
- retry classification, cleanup planning and adapter conformance;
- property tests: price is nonnegative, more identical copies cannot lower the
  unpromoted charge, terminal states do not leave, and cleanup repeats safely.

Inject Clock, random source, object store, queue and adapters. Do not wait real
minutes or rely on global mocks.

**API integration — Fastify inject, Vitest, PostgreSQL/Redis/MinIO**

- real schema, constraints and transactions, not SQLite substitution;
- kiosk/mobile/admin/agent authorization and cross-session isolation;
- real multipart streaming, private object existence and aggregate limits;
- BullMQ job, outbox, replay, idempotency and concurrency conflicts;
- every standard 4xx/5xx contract.

Use Docker Compose for developer runs and Testcontainers where isolated CI
instances materially help.

**Frontend — Testing Library, Mock Service Worker, axe-core**

- loading, empty, processing, rejected, error, offline and recovery states;
- focus order, screen-reader names, large touch controls and high contrast;
- refresh restoration, duplicate/out-of-order events and idle reset;
- safe text rendering of Unicode, HTML and path-like display names.

**End-to-end — Playwright**

Run two independent contexts: authenticated kiosk and clean mobile browser.
Use real API, database, object storage, worker, event gateway and mock agent.
Test Chromium, WebKit and Firefox plus iPhone/Android-sized viewports.

**Real mobile**

Periodically test camera QR, Files/Photos picker, refresh, background/resume,
weak Wi-Fi, upload progress and expiry during file selection on actual iOS and
Android devices.

**File corpus**

Use synthetic: valid one/multi-page PDFs; EXIF JPEG/PNG; wrong extension/MIME/
signature; zero/truncated; encrypted PDF; excessive pages; huge dimensions/
decoded pixels; duplicate bytes; Unicode/HTML/traversal/shell display names.
Hostile/fuzz cases run only inside bounded processing containers.

**Security**

- Semgrep static rules; dependency audit; Gitleaks; Trivy filesystem/images;
- OWASP ZAP against a disposable deployment;
- authorization/IDOR matrix, CSRF, CSP/XSS, rate-limit and credential-rotation
  tests;
- private-bucket and signed-URL scope/expiry tests;
- log-redaction snapshots;
- threat-model review per architecture change and external penetration test
  before public payment pilot.

**Expiry and cleanup**

Fake clock just before/at/after expiry; duplicate expiration jobs; crash after
each cleanup checkpoint; unavailable storage/database/agent; orphan multipart;
repeat cleanup three times; restart and reconcile.

**Payments**

Same key/same body, same key/different body, duplicate and out-of-order signed
webhook, invalid signature, wrong amount/currency, timeout followed by late
capture, process restart, and exactly one refund/credit request after failure.

**Device failure simulation**

Scenarios:

~~~text
success
offline-before-submit
timeout-before-submit
unknown-after-submit
paper-jam-before-page
paper-jam-after-page-N
out-of-paper
low-toner-warning
cancel-before-submit
cancel-during-print
agent-crash
~~~

Each result is classified warning, safe retry before submission, definite
terminal failure, or ambiguous recovery.

**Network interruption and restart**

- Playwright offline controls for browsers;
- Toxiproxy for latency, resets and dependency outage;
- stop/restart API, worker, Redis, PostgreSQL, MinIO and agent separately;
- kill each durable workflow immediately before and after every external side
  effect; verify lease recovery without duplicate charge/print;
- ensure agent SQLite outbox persists and UI resynchronizes.

**Concurrency and load — k6**

- many kiosks creating sessions concurrently;
- parallel phone uploads and validation backpressure;
- rate-limited short-code guesses;
- Socket.IO connections/replay;
- quote/payment/print idempotency races;
- cleanup and worker queue depth.

Set service-level targets after pilot measurements. An early stress profile can
exercise 50 kiosks and far more simultaneous uploads than expected, but this is
a test assumption, not a capacity promise.

### 21.2 Complete end-to-end acceptance test

1. Start isolated PostgreSQL, Redis, MinIO, API, worker and mock agent.
2. Seed KIOSK_TEST_01 and a known pricing rule.
3. Kiosk presses Print and sends an idempotent create request.
4. Assert WAITING_FOR_UPLOAD, expiry, short code and QR.
5. Assert database contains only the token digest.
6. Open the rendered QR URL in a separate mobile context.
7. Exchange token; assert scoped HttpOnly cookie and fragment removal.
8. Upload a synthetic two-page PDF.
9. Assert private quarantine object and processing state.
10. Wait for READY; assert page count, previews and normalized derivative.
11. Assert kiosk receives file.ready, then retrieves authoritative state.
12. Select A4, monochrome, simplex and two copies.
13. Request quote and independently assert expected four printed sides and
    server total.
14. Create fake successful payment with an idempotency key.
15. Repeat it; assert same payment ID and one capture.
16. Assert PAID and unique durable print command.
17. Let the mock adapter accept the job; repeat delivery.
18. Assert exactly one output directory/manifest and correct artifact hash.
19. Assert print events and session COMPLETED.
20. Advance fake clock through the short grace and run cleanup.
21. Assert quarantine, original, normalized, previews, multipart remnants and
    local/mock spool copies are absent.
22. Assert grants/cookies are revoked and document routes return 410.
23. Assert payment, quote and redacted audit/tombstone remain.
24. Assert captured logs contain no token, unsafe filename, object key, signed
    URL or bytes.

Run variants for decline, interrupted upload, processing worker crash,
duplicate event, jam, ambiguous submission, cloud outage after payment, and
object-delete failure.

### 21.3 CI order

1. Frozen-lockfile install.
2. Format, lint and type check.
3. Unit/property tests and coverage.
4. Build packages/apps.
5. Start disposable infrastructure and migrate.
6. Integration tests.
7. Playwright E2E.
8. Secret, dependency, static and container scans.
9. Publish signed artifacts only from protected branches.

## 22. Exact local development setup

### 22.1 Current machine audit

This workspace was inspected on macOS 26.4:

- Git 2.50.1 and Homebrew 6.0.6 are installed.
- Node.js 24.18.0, Corepack 0.35.0, and pnpm 11.12.0 are installed under nvm.
  The shell must load ~/.nvm/nvm.sh before those commands appear on PATH.
- Visual Studio Code 1.127.0 and its code command are installed.
- Docker Desktop 4.81.0, Docker client 29.6.1, and Compose 5.2.0 are installed.
  Docker setup and the native arm64 runtime checks are complete, as documented
  in docs/DOCKER_AUDIT.md.
- The repository is initialized on main and the Phase 0 acceptance gate is
  complete.

### 22.2 Install prerequisites on this Mac

Recommended editor: Visual Studio Code with ESLint, Prettier, Prisma, Docker and
Playwright extensions. The existing nvm installation should be initialized in
~/.zshrc:

~~~bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

corepack enable
corepack prepare pnpm@11.12.0 --activate
~~~

If the installed Node distribution does not include Corepack:

~~~bash
npm install --global pnpm@11
~~~

Launch Docker Desktop once and wait for its engine. Verify:

~~~bash
git --version
node --version
pnpm --version
docker version
docker compose version
code --version
~~~

Node 24 LTS is the pinned runtime. The root package will pin pnpm 11 and use a
frozen lockfile in CI. Do not substitute the non-LTS Node 26 line merely because
it is newer.

### 22.3 Proposed monorepo

~~~text
PrintingKiosk/
├── apps/
│   ├── kiosk/                 touchscreen React application
│   ├── mobile-upload/         anonymous phone React application
│   └── admin/                 later operator dashboard
├── services/
│   ├── api/                   modular REST API and Socket.IO gateway
│   ├── worker/                validation, previews, expiry and cleanup jobs
│   └── kiosk-agent/           local device control and durable edge queue
├── packages/
│   ├── contracts/             Zod API/event schemas and inferred types
│   ├── domain/                pure state machines and invariants
│   ├── config/                typed environment loading
│   ├── database/              Prisma schema, migrations and client
│   ├── pricing/               pure price calculation
│   ├── file-processing/       validation/normalization contracts
│   ├── printer-adapters/      interface, mock, later Windows/IPP
│   ├── payment-adapters/      mock and later terminal/gateway
│   ├── telemetry/             redacted logging, metrics and tracing
│   └── ui/                    shared accessible visual components
├── infrastructure/
│   ├── compose/dev.yml
│   ├── docker/
│   ├── cloud/
│   └── windows/
├── tests/
│   ├── e2e/
│   ├── fixtures/
│   ├── integration/
│   └── load/
├── docs/
│   ├── adr/
│   ├── threat-model/
│   ├── hardware/
│   ├── privacy/
│   └── runbooks/
├── var/                       ignored local private artifacts
├── .env.example
├── compose.yml
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
~~~

Initially create only kiosk, mobile-upload, api, worker, kiosk-agent, contracts,
domain, config, database, pricing, file-processing, printer-adapters,
payment-adapters, UI, Compose, and test fixtures. Add admin/vendor packages in
their phase; empty speculative packages create noise.

### 22.4 Phase 0 bootstrap commands

From this repository root after prerequisites:

~~~bash
pnpm init
pnpm add -Dw turbo typescript eslint prettier vitest @types/node
pnpm install
cp .env.example .env
docker compose -f infrastructure/compose/dev.yml up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
~~~

The root package should contain:

~~~json
{
  "private": true,
  "engines": {
    "node": ">=24 <25"
  },
  "packageManager": "pnpm@11.12.0"
}
~~~

Expected root commands:

~~~bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm db:migrate
pnpm db:seed
~~~

### 22.5 Development Docker Compose

Create infrastructure/compose/dev.yml in Phase 0:

~~~yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: printing_kiosk
      POSTGRES_USER: printing_kiosk
      POSTGRES_PASSWORD: development-only
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U printing_kiosk -d printing_kiosk"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: development-user
      MINIO_ROOT_PASSWORD: development-password-change-me
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"
    volumes:
      - minio_data:/data

volumes:
  postgres_data:
  redis_data:
  minio_data:
~~~

Pin exact tested image digests in CI. Do not expose these ports on the LAN.
MinIO is a local S3-compatible development service; use managed private object
storage in production and review redistribution licenses.

### 22.6 Environment variables

The checked-in .env.example is the source of names and safe placeholders.
Generate each development secret separately:

~~~bash
openssl rand -base64 32
~~~

Copy it:

~~~bash
cp .env.example .env
~~~

The .env file, certificates and all var/data/upload/output directories are
already ignored. Production uses a secret manager and separate credentials.

### 22.7 Run each process

Once Phase 0 packages exist:

~~~bash
pnpm --filter @printing-kiosk/api dev
pnpm --filter @printing-kiosk/worker dev
pnpm --filter @printing-kiosk/kiosk-agent dev
pnpm --filter @printing-kiosk/kiosk dev --host 127.0.0.1
pnpm --filter @printing-kiosk/mobile-upload dev --host 0.0.0.0
~~~

Suggested ports: API 3000, kiosk 5173, mobile 5174, admin 5175, MinIO API 9000
and console 9001. The mock printer writes under
var/mock-printer/output/job-id.

### 22.8 Test a phone on the same Wi-Fi

Find the LAN IP:

~~~bash
ipconfig getifaddr en0
~~~

If it is 192.168.1.50, set only `UPLOAD_ORIGIN` and
`PUBLIC_UPLOAD_ORIGIN` to `https://192.168.1.50:5174`. Keep the API on
`127.0.0.1:3000`; the mobile Vite server proxies `/v1` to it. Expose only port
5174 through the Mac firewall. Do not expose PostgreSQL, Redis, MinIO, the API,
or the kiosk agent to the LAN. Guest Wi-Fi client isolation may still block
device-to-device traffic.

Basic HTTP can test a synthetic upload if the development profile explicitly
disables Secure cookies. For the real QR/cookie/security behavior, use HTTPS.

### 22.9 Local HTTPS

~~~bash
mkcert -install
mkdir -p .certs
mkcert -cert-file .certs/dev.pem \
  -key-file .certs/dev-key.pem \
  localhost 127.0.0.1 ::1 192.168.1.50
~~~

Configure the mobile Vite server with those files and use
https://192.168.1.50:5174. Fastify remains HTTP on loopback behind Vite's
`/v1` proxy. The phone must trust the local mkcert root CA.
Alternatively use an authenticated development tunnel with synthetic files;
remember that it exposes a development server outside the laptop. Never use a
development tunnel as production infrastructure.

## 23. First vertical slice skeleton

This is implementation-oriented pseudocode, not copy/paste production code.
Phase 0 first establishes packages, schemas, configuration and tests. The slice
then grows in the following order.

### 23.1 Shared contracts and session creation

~~~ts
// packages/contracts/src/session.ts
import { z } from "zod";

export const SessionState = z.enum([
  "WAITING_FOR_UPLOAD",
  "FILES_UPLOADED",
  "CONFIGURING",
  "AWAITING_PAYMENT",
  "PAID",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "RECOVERY_REQUIRED",
  "EXPIRED",
  "CANCELED"
]);

export const CreateSessionResponse = z.object({
  session: z.object({
    id: z.string().uuid(),
    publicId: z.string(),
    kioskId: z.string(),
    state: SessionState,
    version: z.number().int(),
    expiresAt: z.string().datetime()
  }),
  upload: z.object({
    shortCode: z.string().regex(/^[0-9]{8}$/),
    qrUrl: z.string().url()
  })
});
~~~

~~~ts
// services/api/src/modules/sessions/create-session.ts
import {
  createHmac,
  randomBytes,
  randomUUID
} from "node:crypto";

const derive = (
  purpose: "upload-token" | "short-code",
  sessionId: string,
  idempotencyKey: string,
  pepper: string
) => createHmac("sha256", pepper)
  .update("printing-kiosk/" + purpose + "/v1\0")
  .update(sessionId)
  .update("\0")
  .update(idempotencyKey)
  .digest();

const digest = (value: string, pepper: string) =>
  createHmac("sha256", pepper).update(value, "utf8").digest("hex");

const digestIdempotencyKey = (
  actorId: string,
  action: string,
  value: string,
  pepper: string
) => createHmac("sha256", pepper)
  .update("printing-kiosk/idempotency-key/v1\0")
  .update(actorId)
  .update("\0")
  .update(action)
  .update("\0")
  .update(value)
  .digest("hex");

export async function createSession(input: {
  kioskId: string;
  idempotencyKey: string;
  publicUploadOrigin: string;
  pepper: string;
  clock: Clock;
}) {
  for (let collisionAttempt = 0; collisionAttempt < 5; collisionAttempt += 1) {
    const id = randomUUID(); // use UUIDv7 helper in the real implementation
    const publicId = "ps_" + randomBytes(16).toString("base64url");
    const grantBytes = derive("upload-token", id, input.idempotencyKey, input.pepper);
    const codeBytes = derive("short-code", id, input.idempotencyKey, input.pepper);
    const grant = "u_" + grantBytes.toString("base64url");
    const code = (codeBytes.readBigUInt64BE(0) % 100_000_000n)
      .toString()
      .padStart(8, "0");
    const expiresAt = input.clock.addMinutes(10);

    try {
      return await database.transaction(async (tx) => {
        await tx.lockKiosk(input.kioskId);
        const idempotencyKeyDigest = digestIdempotencyKey(
          input.kioskId,
          "sessions.create",
          input.idempotencyKey,
          input.pepper
        );
        const replay = await tx.idempotency.findByKeyDigest(
          input.kioskId,
          "sessions.create",
          idempotencyKeyDigest
        );
        if (replay) {
          // Verify request hash, waiting state, active/unexpired grant, and both
          // derived digests before reconstructing the original response.
          return reconstructSafeCreateReplay(replay, input);
        }
        await tx.sessions.assertNoActiveSession(input.kioskId);

        const session = await tx.sessions.insert({
          id,
          publicId,
          kioskId: input.kioskId,
          state: "WAITING_FOR_UPLOAD",
          version: 1,
          idleExpiresAt: expiresAt,
          hardExpiresAt: input.clock.addMinutes(30)
        });
        await tx.uploadGrants.insert({
          sessionId: id,
          grantDigest: digest(grant, input.pepper),
          shortCodeDigest: digest(code, input.pepper),
          expiresAt
        });

        const qrUrl =
          input.publicUploadOrigin + "/s/" + publicId + "#t=" + grant;
        const response = { session, upload: { shortCode: code, qrUrl } };

        await tx.outbox.insert({
          aggregateId: id,
          sequence: 1,
          type: "session.created",
          payload: { sessionId: id, kioskId: input.kioskId }
        });
        await tx.idempotency.store(
          input.kioskId,
          "sessions.create",
          idempotencyKeyDigest,
          hashRequest({ kioskId: input.kioskId }),
          { session }, // never persist shortCode, qrUrl, or the upload token
          session.id
        );
        return response;
      });
    } catch (error) {
      if (!isShortCodeCollision(error)) throw error;
    }
  }
  throw domainError("SESSION_CODE_ALLOCATION_FAILED");
}
~~~

~~~ts
// services/api/src/modules/sessions/routes.ts
app.post("/v1/kiosks/:kioskId/sessions", {
  preHandler: [authenticateKiosk, requireScope("sessions:create")],
  schema: createSessionSchema
}, async (request, reply) => {
  assertOwnKiosk(request.identity, request.params.kioskId);
  const result = await createSession({
    kioskId: request.params.kioskId,
    idempotencyKey: requireIdempotencyKey(request),
    publicUploadOrigin: config.PUBLIC_UPLOAD_ORIGIN,
    pepper: config.UPLOAD_TOKEN_PEPPER,
    clock
  });
  return reply.code(201).send(result);
});
~~~

The logging configuration must redact headers, cookies and request bodies for
this route so the returned QR URL is not copied into traces.

### 23.2 Kiosk creates and displays the QR

~~~tsx
// apps/kiosk/src/features/session/StartPrintSession.tsx
import QRCode from "qrcode";

export function StartPrintSession() {
  const create = useCreateSession();
  const [qrDataUrl, setQrDataUrl] = useState<string>();

  async function start() {
    const result = await create.mutateAsync({
      idempotencyKey: crypto.randomUUID()
    });
    setQrDataUrl(await QRCode.toDataURL(result.upload.qrUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 420
    }));
  }

  if (!create.data) return <button onClick={start}>Print</button>;
  return (
    <SessionWaitingScreen
      qrDataUrl={qrDataUrl}
      shortCode={create.data.upload.shortCode}
      expiresAt={create.data.session.expiresAt}
    />
  );
}
~~~

Do not reconstruct the QR from a numeric code in the browser. Render the exact
server URL, keep it only in current UI state, and clear it on reset.

### 23.3 Mobile exchanges and uploads

~~~ts
// apps/mobile-upload/src/features/join/exchange.ts
export async function exchangeQrGrant(publicId: string) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("t");
  if (!token) throw new Error("UPLOAD_GRANT_MISSING");

  const response = await fetch("/v1/mobile-auth/exchange", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicSessionId: publicId,
      uploadToken: token,
      clientNonce: crypto.randomUUID()
    })
  });
  history.replaceState(null, "", location.pathname);
  if (!response.ok) throw await readApiError(response);
  return response.json();
}
~~~

~~~ts
// progress-friendly multipart helper
export function uploadFile(
  sessionId: string,
  file: File,
  csrfToken: string,
  onProgress: (ratio: number) => void
) {
  const body = new FormData();
  body.append("clientFileId", crypto.randomUUID());
  body.append("file", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/v1/sessions/" + sessionId + "/files");
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    xhr.setRequestHeader("Idempotency-Key", crypto.randomUUID());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status === 202 ? resolve(JSON.parse(xhr.responseText)) : reject(xhr);
    xhr.onerror = () => reject(new Error("UPLOAD_INTERRUPTED"));
    xhr.send(body);
  });
}
~~~

### 23.4 API streams, validates, and stores

~~~ts
// services/api/src/modules/files/upload-file.ts
export async function receiveFile(request: MobileRequest) {
  const session = await sessions.assertEditableForUpload(
    request.mobileIdentity.sessionId
  );
  const part = await request.file({
    limits: { fileSize: config.MAX_FILE_BYTES, files: 1 }
  });
  if (!part) throw domainError("FILE_REQUIRED");

  const fileId = ids.next();
  const objectKey =
    "incoming/" + session.kioskId + "/" + session.id + "/" +
    fileId + "/" + ids.randomOpaque();

  await files.createUploading({
    id: fileId,
    sessionId: session.id,
    displayName: safeGenericDisplayName(part.filename),
    objectKey
  });

  try {
    const stored = await objectStore.putPrivateStream({
      key: objectKey,
      stream: withHardByteAndTimeLimit(part.file),
      computeSha256: true
    });
    await preliminaryValidation.assertAllowed({
      declaredMime: part.mimetype,
      firstBytes: stored.firstBytes,
      sizeBytes: stored.sizeBytes
    });
    await files.markQuarantined(fileId, stored);
    await validationQueue.add(
      "validate-file",
      { fileId },
      { jobId: "validate:" + fileId }
    );
    return { id: fileId, status: "QUARANTINED" };
  } catch (error) {
    await cleanupQueue.add("cleanup-file", { fileId });
    throw error;
  }
}
~~~

The validation worker scans, bounds, parses, creates WebP previews and a
normalized PDF. In one transaction it marks READY, advances the session if
needed, and inserts file.ready into the outbox. Rejection stores only a safe
reason and schedules all partial artifacts.

### 23.5 Kiosk receives the durable event

~~~ts
// apps/kiosk/src/features/session/useSessionEvents.ts
useEffect(() => {
  // Connects to the loopback agent. The browser never owns a device key.
  const socket = createLocalAgentSocket();
  socket.emit("session.subscribe", {
    sessionId,
    afterSequence: lastAppliedSequence.current
  });
  socket.on("session.event", async (event) => {
    if (event.sequence <= lastAppliedSequence.current) return;
    if (event.sequence !== lastAppliedSequence.current + 1) {
      await queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    }
    lastAppliedSequence.current = event.sequence;
    await queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  });
  return () => socket.close();
}, [sessionId]);
~~~

The event is only a wake-up signal. The kiosk displays the file from the
authorized session snapshot, so missed or duplicate events do not corrupt UI.

### 23.6 Settings and price

~~~ts
// packages/pricing/src/calculate.ts
export function calculateQuote(input: PricingInput): QuoteBreakdown {
  const perFile = input.files.map((file) => {
    const pages = countSelectedPages(file.pageRanges, file.pageCount);
    const sidesPerCopy = pages;
    return {
      sides: sidesPerCopy * input.settings.copies,
      sheets:
        input.settings.duplex === "SIMPLEX"
          ? sidesPerCopy * input.settings.copies
          : Math.ceil(sidesPerCopy / 2) * input.settings.copies
    };
  });

  const printedSides = sum(perFile.map((item) => item.sides));
  const physicalSheets = sum(perFile.map((item) => item.sheets));
  const printAmount = printedSides * input.rule.unitAmountMinor;
  const beforeTax = Math.max(
    printAmount + input.rule.serviceFeeMinor,
    input.rule.minimumAmountMinor
  );
  const taxMinor = roundBasisPoints(
    beforeTax,
    input.rule.taxBasisPoints,
    input.rule.rounding
  );
  return {
    printedSides,
    physicalSheets,
    subtotalMinor: beforeTax,
    taxMinor,
    totalMinor: beforeTax + taxMinor,
    currency: input.rule.currency
  };
}
~~~

PUT settings creates an append-only revision and invalidates old quotes. POST
quotes loads READY metadata and capability snapshot on the server, calls this
pure function, stores the immutable result/manifest hash, and returns it.

### 23.7 Fake payment creates one print job

~~~ts
// packages/payment-adapters/src/mock/MockPaymentProvider.ts
export class MockPaymentProvider implements PaymentProvider {
  async createIntent(input: CreateIntentInput) {
    return {
      providerIntentId: "mock-" + input.paymentId,
      status: "PENDING" as const
    };
  }

  // Test harness schedules a signed event; production code cannot choose it.
  signTestEvent(event: MockProviderEvent): SignedWebhook {
    return signRawWebhook(event, this.developmentSecret);
  }
}
~~~

Webhook application:

~~~ts
await database.transaction(async (tx) => {
  const firstReceipt = await tx.webhookInbox.insertIfAbsent(providerEvent);
  if (!firstReceipt) return;
  const payment = await tx.payments.lockByProviderIntent(providerIntentId);
  assertExactQuoteAmount(payment, providerEvent);
  await tx.payments.capture(payment.id, providerEvent.capturedAt);
  await tx.sessions.transition(payment.sessionId, "AWAITING_PAYMENT", "PAID");
  const job = await tx.printJobs.insertOnce({
    sessionId: payment.sessionId,
    paymentId: payment.id,
    quoteId: payment.quoteId,
    operationId: "print:" + payment.sessionId + ":1"
  });
  await tx.outbox.insertPrintDispatch(job);
});
~~~

The worker downloads the normalized job artifact to the agent, verifies its
hash, and calls MockPrinterAdapter. Successful status changes the print job and
session to COMPLETED in a guarded transaction and emits both events.

### 23.8 Cleanup completes the slice

~~~ts
// services/worker/src/jobs/cleanup-session.ts
export async function cleanupSession(sessionId: string) {
  const run = await cleanupRuns.claim(sessionId);
  if (!run) return;

  await uploadAccess.revokeAll(sessionId);
  await objectStore.abortMultipartForSession(sessionId);

  for (const artifact of await artifacts.listForSession(sessionId)) {
    await objectStore.deleteIfPresent(artifact.objectKey);
    await artifacts.markDeleted(artifact.id);
  }

  await kioskAgentCommands.deleteCachedArtifactsOnce(sessionId);
  await redisState.deleteSessionKeys(sessionId);
  await files.scrubTransientMetadata(sessionId);
  await cleanupRuns.verifyAndComplete(sessionId);
}
~~~

Missing artifacts count as success. The integration test interrupts this
function after every line and verifies the next run completes without exposing
or resurrecting data.

### 23.9 Slice sequence mapped to the requested workflow

1. Kiosk POSTs create session.
2. Backend generates digest-stored grant/code and durable state.
3. Response contains fragment QR URL.
4. Kiosk renders QR.
5. Phone opens mobile route and exchanges the grant.
6. Phone streams PDF with progress.
7. API quarantines; worker validates, stores and normalizes it.
8. Outbox publisher sends file.ready.
9. Kiosk resyncs and displays validated pages.
10. Kiosk PUTs complete settings revision.
11. Backend creates the quote.
12. Kiosk starts mock payment; signed fake callback captures it.
13. Capture transaction creates the one logical print command.
14. Mock printer verifies and saves PDF/manifest to the ignored output folder.
15. Definite result moves print job/session to completed.
16. Delayed cleanup revokes access and deletes all temporary artifacts.

## 24. Production references

- Node release/LTS information: https://nodejs.org/en/about/previous-releases
- OWASP file upload guidance:
  https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- OWASP logging guidance:
  https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- Microsoft Windows Print Spooler API:
  https://learn.microsoft.com/en-us/windows/win32/printdocs/print-spooler-api
- Microsoft Windows kiosk options:
  https://learn.microsoft.com/en-us/windows/configuration/kiosk/
- OpenPrinting CUPS IPP implementation:
  https://openprinting.github.io/cups/doc/spec-ipp.html

## 25. Review gate before Phase 0

Accept or change these decisions before code scaffolding:

1. TypeScript modular monorepo and the selected libraries.
2. Cloud control plane plus local agent boundary.
3. Public upload requires internet in the MVP.
4. PDF/JPEG/PNG and exact resource limits.
5. One active session per kiosk and first-phone-wins QR policy.
6. Eight-digit manual code requires kiosk confirmation in production.
7. Original plus normalized PDF plus inert previews.
8. Money representation, starting currency/tax policy and example prices.
9. Payment-failure/refund/credit and ambiguous-print policy.
10. File retention periods and privacy wording.
11. The first printer model/connection will be selected against capability and
    status requirements, not price alone.
12. No administrator document viewing.

After this gate, Phase 0 should create the actual monorepo and infrastructure.
Then implement one vertical slice in order instead of building all frontends or
device types independently.
