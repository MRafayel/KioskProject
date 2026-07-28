# Phase 5 status

- Date: 2026-07-26
- Status: complete for the pilot/prototype acceptance boundary
- Scope: secure document validation, normalization, metadata extraction, and
  authenticated monochrome previews

“Complete” here means the local pilot is integrated, migration-safe, and
covered by automated security and regression gates. It does not mean the
commercial-distribution items under
[Known boundaries before commercial distribution](#known-boundaries-before-commercial-distribution)
are complete.

## What Phase 5 adds

1. A successfully uploaded PDF, JPEG, or PNG remains private and moves from
   `QUARANTINED` to `VALIDATING`. It is not printable merely because its upload
   completed.
2. PostgreSQL owns dispatch, attempts, claim tokens, leases, retries, and the
   final result. BullMQ is a wake-up queue and may be retried or rebuilt
   without becoming the source of truth.
3. The worker reads the quarantined object with a dedicated least-privilege
   object-storage identity and streams it to an authenticated document
   processor. It never loads a customer file into one application buffer.
4. The document processor verifies the exact content length, immutable SHA-256
   digest, and file signature before accepting the request.
5. ClamAV scans the complete file through its bounded `INSTREAM` protocol
   before any PDF parser or image decoder processes it. Stale or unavailable
   malware definitions fail closed and cause a bounded retry.
6. PDFs are checked with qpdf, rejected when encrypted, page-count bounded,
   and rasterized one page at a time with Poppler. Images are decoded with
   Sharp under dimension, total-pixel, page-count, timeout, and output-size
   limits. qpdf separates recovered warnings (exit 3) from unrecoverable
   structural errors (exit 2): a document whose cross-reference table qpdf
   rebuilds is accepted, and only an error exit means corruption. Parser
   diagnostics are drained without retention, so warning volume — which grows
   with page count — cannot decide the outcome.
7. Every accepted page is flattened onto white, converted to grayscale, fitted
   to an A4 page, and used to build a canonical image-only PDF. The original
   object remains immutable until the session cleanup policy removes it.
8. The processor returns only a bounded tar archive containing an allowlisted
   manifest, one normalized PDF, and one WebP preview per page. The worker
   verifies archive length, archive digest, entry allowlist, entry count,
   per-artifact digest, media signature, manifest continuity, and all configured
   limits before storing anything.
9. A file becomes `READY` only in the same serializable transaction that proves
   all artifact ledgers and page rows are complete. That transaction also
   writes the audit entry and durable `file.ready` outbox event.
10. The kiosk can retrieve page metadata and WebP previews through its
    loopback-only agent. The API requires the owning kiosk credential, conceals
    foreign resources, requires the current processing revision, and sends
    previews only after rechecking their recorded byte length, SHA-256 digest,
    and WebP signature. Responses use `no-store`, `nosniff`, a sandboxed
    content policy, and same-origin resource policy.
11. The phone and kiosk display meaningful `VALIDATING`, `READY`, and safe
    rejection states in Armenian, Russian, and English. Private parser,
    scanner, object key, hash, and infrastructure details never enter the
    public contract.
12. Cancellation, expiry, rejection, and explicit file deletion invalidate
    processing ownership and converge through idempotent object and database
    cleanup. Exact-key cleanup also enumerates and removes all S3 object
    versions and delete markers before database finalization.

Phase 5 does not add scanning, photocopying/xerox, color printing, print
settings persistence, pricing, payment, or physical printing.

## Processing architecture

```text
Mobile upload
    |
    v
API ---- private quarantine object ----> S3-compatible object storage
 |                                            ^
 | PostgreSQL QUARANTINED                     | worker-only read/write policy
 v                                            |
PostgreSQL dispatcher --> BullMQ wake-up --> worker
                                              |
                                              | fixed-length authenticated stream
                                              v
                                  loopback development gateway
                                              |
                                              v
                              isolated document processor
                               |                         |
                               v                         v
                         ClamAV INSTREAM       qpdf / Poppler / Sharp
                               \                         /
                                \-- bounded tar bundle --/
                                              |
                                              v
                          normalized PDF + WebP previews in private storage
                                              |
                                              v
                         serializable READY + pages + artifacts + outbox
                                              |
                                              v
                    authenticated API --> loopback agent --> kiosk preview
```

The processor has no database, Redis, queue, kiosk, or object-storage
credential. Its container has a read-only root filesystem, non-root runtime
user, all Linux capabilities dropped, `no-new-privileges`, bounded memory,
CPU, PIDs, request time, and scratch space. It shares only an internal network
with ClamAV. A narrow development TCP gateway publishes the processor on
`127.0.0.1:3200`; it does not give the processor an egress-capable interface.
Only the FreshClam updater uses the development egress network. The scanner
mounts those signatures read-only and shares only the internal processing
network; neither scanner nor processor can reach PostgreSQL, Redis, or MinIO.

## State and retry rules

```text
UPLOADING
   |
   v
QUARANTINED -- claim(generation, token, lease) --> VALIDATING
   ^                                                |
   | transient failure + successful cleanup        | all checks and artifacts complete
   |                                                v
   +---------------------------------------------- READY
                                                    |
terminal validation failure                         | customer/session cleanup
   |                                                |
   v                                                v
DELETE_PENDING <--> DELETING --> REJECTED or DELETED
```

- Each queue job carries only an opaque file ID and positive generation.
- A worker may mutate or complete only the matching database generation and
  claim token.
- The lease heartbeat aborts processing after ownership is lost. A stale job
  cannot mark a replacement job complete.
- Transient processor, scanner, storage, or network errors retry with bounded
  exponential backoff. Permanent document errors use a small public rejection
  allowlist.
- Derived object keys contain only server-generated session/file IDs,
  processing revision, and generation. Customer filenames never become paths.
- Cleanup is safe to retry. Missing objects are treated as already removed;
  database finalization happens only after every known object has been handled.
- Explicit deletion is audited when accepted and when deferred cleanup
  completes. Every concurrent idempotency key for the same deletion settles to
  `204` once the objects are gone.
- Integration tests are destructive only to explicit loopback targets, execute
  files serially, and start their own dispatcher and worker. A development
  worker must not run at the same time.
- Bucket lifecycle rules expire quarantine, normalized, preview, and incomplete
  multipart data after one day as a defense-in-depth backstop, not as the
  primary deletion mechanism.

## Public API additions

```text
GET /v1/sessions/:sessionId/files/:fileId/pages
GET /v1/sessions/:sessionId/files/:fileId/pages/:pageNumber/preview?revision=N
```

Both endpoints require the owning kiosk credential with `files:read`. The
mobile credential cannot fetch previews. Page metadata contains only the file
ID, processing revision, page count, page numbers, dimensions, and preview
availability; it contains no object key or signed storage URL.

Existing upload, list, delete, session, cancellation, mobile SSE, kiosk
realtime, replay, and idempotency endpoints retain their routes and
authentication rules. Existing Phase 3 event snapshots are upgraded
additively with neutral Phase 5 fields. Runtime contract parsing applies those
same neutral defaults to legacy durable events written during a rolling
deployment, preventing a permanent replay sequence gap.

## Storage and database model

- `uploaded_files` now records processing revision/generation, attempts,
  availability/enqueue time, claim token and lease, safe error metadata,
  malware state, page count, and ready time.
- `file_derivatives` is the durable ledger for the immutable original,
  canonical normalized PDF, and each page preview.
- `file_pages` records the contiguous page order and binds each page to its
  exact preview derivative.
- Originals remain under `quarantine/v1`. Canonical PDFs use
  `normalized/v1`; previews use `previews/v1`.
- API credentials can upload quarantine objects, read previews, and delete all
  cleanup prefixes and their historical versions. Worker credentials can read
  quarantine objects and write/delete only normalized and preview objects and
  their historical versions. Both can list versions only at the bucket level;
  object read/write permissions remain prefix-scoped.

## Limits and accepted content

The default development limits are:

- one file per session and 50 MiB per file;
- PDF, JPEG, and PNG only;
- 200 document pages;
- 20,000 pixels on either source-image dimension;
- 40 million source-image pixels;
- 100 MiB normalized PDF;
- 2 MiB per WebP preview;
- 1,600 x 2,200 maximum preview dimensions;
- one concurrent processor request;
- 120-second processing deadline and 180-second ownership lease;
- three processing attempts.

The 200-page limit is a structural bound, not a throughput promise. Measured
against the pinned processor image on one CPU, a page costs roughly 0.7 s and
0.6 MB of canonical output for sparse text and about 1.4 s for a dense
real-world page. With the default 120-second deadline and 100 MiB normalized
ceiling, the practical acceptance ceiling is therefore roughly 85–165 pages
depending on page density; beyond that a document is rejected with
`PROCESSING_TIMEOUT` or `OUTPUT_SIZE_LIMIT_EXCEEDED` rather than
`PAGE_LIMIT_EXCEEDED`. Before advertising 200 pages to customers, either raise
`DOCUMENT_PROCESSOR_TIMEOUT_SECONDS` (and the lease above it) and
`MAX_NORMALIZED_FILE_BYTES` to cover the worst case, or lower
`MAX_DOCUMENT_PAGES` to a value the deadline can serve.

These values are configuration, not browser hints. The API, worker, processor,
database constraints, object store, and container limits enforce compatible
bounds. Production configuration rejects development secrets, shared API and
worker storage credentials, plaintext public origins, missing server-side
encryption, a non-container processor, a non-ClamAV scanner, and an unpinned
processor image.

## Run locally

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Open `http://127.0.0.1:5173`. The complete journey requires the API, worker,
kiosk agent, kiosk UI, and mobile UI started by `pnpm dev:kiosk`; starting only
the kiosk Vite package does not process documents.

Useful readiness checks:

```bash
pnpm infra:status
curl --fail http://127.0.0.1:3200/health/ready
curl --fail http://127.0.0.1:3000/health/ready
curl --fail http://127.0.0.1:3100/health/ready
```

The real-phone HTTPS and trusted local certificate procedure remains in
`docs/PHASE_3_STATUS.md`. Use only synthetic documents during development.

## Acceptance gate

Phase 5 is accepted only when all of these pass against the applied additive
migrations and healthy PostgreSQL, Redis, MinIO, ClamAV, and processor
containers:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm audit --prod --audit-level=moderate
pnpm infra:validate
```

The integration gate must exercise the real API, PostgreSQL dispatcher,
BullMQ, worker, MinIO policies, authenticated HTTP processor, ClamAV, qpdf,
Poppler, Sharp, preview authorization, rejection cleanup, object cleanup, and
idempotent replay rather than replacing those components with mocks.

### Verified evidence — 2026-07-26

- `format:check`, lint, type-check, build, Compose validation, and
  `git diff --check` passed.
- All 16 Turbo unit/service test tasks passed. The critical Phase 5 suites
  include 32 processor tests, 35 worker tests, 41 API tests, 32 kiosk tests,
  and 32 mobile tests.
- All 33 integration tests passed across three serial files against real
  loopback PostgreSQL, Redis, MinIO, ClamAV, qpdf, Poppler, Sharp, the
  authenticated processor, BullMQ, API, worker, and janitor.
- The document integration suite accepts and normalizes real synthetic JPEG
  and PNG bytes, rejects real encrypted, truncated, excessive-page, malformed,
  and antivirus-test PDFs, and verifies cleanup and private preview
  authorization.
- The deterministic browser gate passed 12 kiosk scenarios at both supported
  pilot resolutions and three mobile scenarios at 390×844.
- `db:verify-phase5-upgrade` passed: it creates an isolated temporary database,
  applies Phase 0–4, inserts a quarantined-file fixture, applies Phase 5,
  verifies neutral processing defaults and new tables, and removes the
  temporary database.
- The production dependency audit reported no known vulnerabilities at
  `moderate` or higher. The vulnerable general-purpose frontend router was
  removed; the kiosk now uses a small internal-only hash router, while the
  mobile upload page uses its single explicit route.
- `.github/workflows/phase5.yml` runs the locked quality, browser, dependency,
  fresh-migration, upgrade-migration, and real-infrastructure gates on pushes
  and pull requests. Dependabot tracks npm and GitHub Actions updates.

The first remote GitHub Actions run remains unverified until these files are
committed and pushed. This does not change the local pilot acceptance result;
the first remote run must be green before merging or deploying from GitHub.

### Follow-up review — 2026-07-27

A review of the multi-page PDF path found and fixed three defects. The
2026-07-26 evidence above predates them and no longer describes current
behaviour on its own.

- Multi-page acceptance had no end-to-end coverage. The only accepted PDF
  fixture was a single page; multi-page fixtures existed solely to test
  rejection. The integration suite now accepts real 2-, 5- and 12-page
  documents and asserts one preview per page.
- `qpdf` exit code 3 (recovered warnings) was treated as `MALFORMED_DOCUMENT`.
  A readable document whose cross-reference table qpdf rebuilds was rejected as
  damaged even though Poppler rendered every page. Exit 3 is now accepted for
  `--check` and `--show-npages`; exit 2 still rejects.
- A retryable failure that exhausted the attempt budget always reported
  `PROCESSING_FAILED`. Deterministic processing timeouts and scanner outages now
  report `PROCESSING_TIMEOUT` and `MALWARE_SCAN_UNAVAILABLE`, and page-count
  rejections no longer share a message with image-size rejections.

## Known boundaries before commercial distribution

- The canonical PDF is intentionally an image-only monochrome A4 artifact.
  Searchable text, accessibility structure, annotations, forms, layers,
  embedded links, JavaScript, and original PDF metadata do not survive
  normalization.
- Preview layout is the canonical document page, not yet a simulation of
  copies, duplex, orientation, or page ranges. Phase 6 will create
  server-authoritative settings and pricing.
- The validated deployment profile keeps `MAX_FILES_PER_SESSION=1`. Values up
  to 10 remain accepted for backward compatibility with the existing upload
  API, but the kiosk configuration screen does not yet provide correct
  per-document controls for multiple files. Do not deploy a value above 1
  until that Phase 6 workflow is completed.
- ClamAV is defense in depth, not proof that a document is harmless. Parser
  isolation, least privilege, bounds, and deletion remain required.
- Development Compose reuses one hardened processor container. A commercial
  deployment must launch a new disposable, no-egress sandbox and encrypted
  quota-limited scratch volume for each document, terminate the entire process
  group on timeout, and destroy both after the response. Restarting code inside
  a shared container is not an equivalent security boundary.
- The loopback kiosk agent is trusted appliance middleware in the current
  prototype. Before arbitrary local software can coexist on the kiosk, bind
  each browser instance to a short-lived agent capability and reject requests
  from any other local process.
- Browser tests use deterministic API boundaries while the real backend path is
  verified by integration tests. Before a public pilot with remote cloud
  infrastructure, add one browser-to-real-stack smoke journey in the target
  deployment environment.
- The mobile production entry chunk is approximately 505 kB minified
  (approximately 150 kB gzip), slightly above Vite's default warning threshold.
  It is acceptable for the current pilot but should be code-split and measured
  on the intended customer network before a broad rollout.
- Complete the recorded qpdf, Poppler, Sharp, PDFKit, ClamAV, base-image, and
  transitive-license review before distributing a commercial appliance.
  Produce and retain an SBOM, vulnerability scan, image signature, and
  immutable image digest for each release. Deployment admission must verify
  that the configured digest is the image that actually runs.
- Implement the privacy retention schedule for session, file, audit, and
  idempotency metadata as well as object bytes; exclude worker scratch, logs,
  backups, indexing, and crash capture from customer-document content.
- A production orchestrator should expose separate liveness and readiness
  probes, restrict ClamAV updater egress to approved mirrors, and alert on stale
  definitions, repeated processing retries, cleanup backlog, and lifecycle-rule
  drift. Network policy must also rate-limit and isolate the unauthenticated
  internal clamd protocol from every workload except disposable processors.
- Deploy the new `ListBucketVersions` and prefix-scoped
  `DeleteObjectVersion` permissions before rolling out code that uses
  version-aware cleanup. When an ingress proxy is present, configure Fastify's
  trusted-proxy boundary to the exact proxy addresses before relying on IP rate
  limits; never trust arbitrary forwarded headers.
