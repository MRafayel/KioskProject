# Phase 0 status

- Date: 2026-07-13
- Status: complete

## Completed

- Git/pnpm/Turborepo TypeScript monorepo.
- Exact pnpm lockfile and restrictive dependency build-script allowlist.
- Node 24 runtime pin and pnpm 11 package-manager pin.
- Strict shared TypeScript, ESLint, Prettier, Vitest, and Turbo configuration.
- Print-only monochrome product-scope contract.
- React/Vite kiosk and mobile placeholder applications.
- Fastify API live/ready endpoints.
- Loopback-only Fastify kiosk-agent live/ready endpoints.
- Worker process baseline.
- Prisma 7 PostgreSQL client, migration, seed, and configuration.
- Loopback-only PostgreSQL, Redis, and MinIO Compose services.
- Docker CLI locator for macOS Docker Desktop installations.
- VS Code extension/settings recommendations.
- Security ignores for secrets, uploads, generated files, certificates, and
  mock printer output.

## Verified

- pnpm install --frozen-lockfile --offline
- pnpm peers check
- pnpm format:check
- pnpm build
- pnpm lint
- pnpm typecheck
- pnpm test
- pnpm audit: no known vulnerabilities
- pnpm infra:validate
- Prisma schema validation and client generation
- API process binds successfully when run outside the workspace sandbox
- Docker engine 29.6.1 and native arm64 hello-world container
- Healthy PostgreSQL 17, Redis 7, and MinIO containers
- Loopback-only container port bindings
- Baseline Prisma migration applied successfully
- Seeded product scope read back from PostgreSQL
- API `/health/live` returns the print-only monochrome contract
- API `/health/ready` reports PostgreSQL, Redis, and object storage as healthy

The Phase 0 acceptance gate is satisfied. Phase 1 may now begin with the kiosk
user-interface prototype while preserving the print-only monochrome boundary.
