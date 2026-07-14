# Printing Kiosk

Privacy-first, self-service monochrome printing kiosk platform.

## Current status

Phases 0 and 1 are complete. The repository contains a reproducible
TypeScript/pnpm monorepo, a tested touchscreen kiosk journey, a placeholder
mobile application, API and local-agent health services, typed
configuration/contracts, a migrated Prisma/PostgreSQL baseline, and healthy
local PostgreSQL/Redis/MinIO infrastructure.

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
- SECURITY.md — handling rules for secrets and private customer documents.

## Phase 0 commands

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
