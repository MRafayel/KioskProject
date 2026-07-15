# Printing Kiosk

Privacy-first, self-service monochrome printing kiosk platform.

## Current status

Phases 0–2 are complete. The repository contains a reproducible TypeScript/pnpm
monorepo, a tested touchscreen kiosk journey, authoritative temporary sessions,
an authenticated loopback kiosk-agent facade, a placeholder mobile application,
typed configuration/contracts, migrated Prisma/PostgreSQL session data, and
healthy local PostgreSQL/Redis/MinIO infrastructure.

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
- SECURITY.md — handling rules for secrets and private customer documents.

## Development commands

Load the installed nvm environment first if Node is not already on PATH:

```bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
```

Then:

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Start the kiosk browser journey

Phase 2 requires four running parts: PostgreSQL, the API on port `3000`, the
local kiosk agent on port `3100`, and the kiosk frontend on port `5173`.

From the repository root, run:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Keep that terminal running and open `http://127.0.0.1:5173`.

Do not use `pnpm --filter @printing-kiosk/kiosk dev` for the complete journey;
that command starts only Vite. If the agent is missing, Vite reports
`ECONNREFUSED 127.0.0.1:3100` when the customer presses Start.
