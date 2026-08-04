# Printing Kiosk

Privacy-first, self-service monochrome printing kiosk platform.

## Current status

Phases 0–7 are implemented to the pilot/prototype acceptance boundary. The
repository contains the first secure document workflow: the kiosk creates an
authoritative session and QR link, one phone claims that link, and PDF/JPEG/PNG
bytes stream into private quarantine storage. An isolated processor performs
malware scanning, bounded document validation, one-page-at-a-time normalization
into a monochrome A4 PDF, and private WebP preview generation. Only a fully
verified document becomes `READY`.

The kiosk receives authenticated, sequenced updates through its loopback
agent. PostgreSQL replay and snapshot recovery restore the correct screen after
a disconnect. The phone can list and delete its file without exposing the
kiosk credential or storing a raw QR token. Kiosk cancellation is pushed to
the claimed phone through an authenticated SSE stream, while PostgreSQL
remains authoritative for upload, processing, and cleanup transitions.

A validated document is then configured into an immutable settings revision and
priced by the control plane from a published tariff. Payment is simulated: the
kiosk starts a payment against one exact quote, and only a signed provider
callback for that exact amount moves the session to `PAID`. No card data enters
this system, and no real money moves anywhere in the current phases.

The product is intentionally print-only and monochrome. Document scanning,
photocopying/xerox, and color printing are outside scope.

Read these documents before implementation:

- docs/BUILD_PLAN.md — product architecture, MVP, contracts, data model,
  device simulation, security, testing, and the phased delivery plan.
- docs/adr/0001-platform-boundaries.md — decisions that should remain stable
  as the implementation grows.
- docs/DOCKER_AUDIT.md — Docker Desktop diagnosis and verified resolution.
- docs/PHASE_0_STATUS.md — Phase 0 implementation and acceptance evidence.
- docs/PHASE_1_STATUS.md — kiosk prototype features and browser-test evidence.
- docs/PHASE_2_STATUS.md — session API, security boundaries, migration, and
  concurrency-test evidence.
- docs/PHASE_3_STATUS.md — QR exchange, private upload, cleanup, mobile testing,
  and the exact real-phone HTTPS setup.
- docs/PHASE_4_STATUS.md — transactional outbox, authenticated realtime relay,
  replay recovery, migration, and verification evidence.
- docs/PHASE_5_STATUS.md — isolated document processing, private previews,
  cleanup guarantees, migration, and verification evidence.
- docs/PHASE_6_STATUS.md — immutable settings revisions, capability checks,
  server-authoritative pricing, quote invalidation, and migration evidence.
- docs/PHASE_7_STATUS.md — simulated payment, the payment ledger, signed
  provider callbacks, compensation records, and migration evidence.
- docs/PHASE_8_STATUS.md — the immutable print job, the durable kiosk command
  channel, the simulated printer, the refund policy for a failed print, and
  migration evidence.
- SECURITY.md — handling rules for secrets and private customer documents.

## Development commands

Load the installed nvm environment first if Node is not already on PATH:

```bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
```

For a first checkout, create the ignored local environment file before seeding:

```bash
cp .env.example .env
openssl rand -base64 48
```

Run `openssl rand -base64 48` once for each development secret and replace each
`replace-with-...` value in `.env` with a different result. Do not overwrite an
existing `.env`, and never commit it. Then:

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm infra:up
pnpm db:verify-phase8-upgrade
pnpm db:verify-phase9-upgrade
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Start the current browser journey

The workflow uses PostgreSQL, Redis, private MinIO, the ClamAV scanner, the
isolated document processor behind loopback port `3200`, the API on port
`3000`, the local kiosk agent on port `3100`, the kiosk on port `5173`, and the
mobile upload page on port `5174`. The worker is included in
`pnpm dev:kiosk`.

From the repository root, run:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Keep that terminal running and open `http://127.0.0.1:5173`.

Press Start and scan the rendered QR from a phone after completing the trusted
LAN HTTPS steps in docs/PHASE_3_STATUS.md; a phone cannot use a QR URL whose
host is `localhost`. For synthetic same-computer testing only, inspect the
`POST /agent/v1/sessions` response in the kiosk browser's Network panel, copy
`upload.qrUrl`, and open it in a separate private browser profile. Treat that
URL as a temporary bearer secret and close the Network panel afterward.

Do not use `pnpm --filter @printing-kiosk/kiosk dev` for the complete journey;
that command starts only Vite. If the agent is missing, Vite reports
`ECONNREFUSED 127.0.0.1:3100` when the customer presses Start.

Do not leave `pnpm dev:kiosk` running while executing integration tests. The
test suite starts its own dispatcher and worker and deliberately refuses
non-loopback infrastructure.
