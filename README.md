# Printing Kiosk

Privacy-first, self-service monochrome printing kiosk platform.

## Current status

Phase 0 is in progress. The repository contains a TypeScript/pnpm monorepo,
placeholder kiosk and mobile applications, API and local-agent health services,
typed configuration/contracts, a Prisma/PostgreSQL baseline, and local
PostgreSQL/Redis/MinIO infrastructure.

The product is intentionally print-only and monochrome. Document scanning,
photocopying/xerox, and color printing are outside scope.

Read these documents before implementation:

- docs/BUILD_PLAN.md — product architecture, MVP, contracts, data model,
  device simulation, security, testing, and the phased delivery plan.
- docs/adr/0001-platform-boundaries.md — decisions that should remain stable
  as the implementation grows.
- docs/DOCKER_AUDIT.md — Docker Desktop diagnosis and the remaining owner action.
- docs/PHASE_0_STATUS.md — completed and pending Phase 0 acceptance checks.
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
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```
