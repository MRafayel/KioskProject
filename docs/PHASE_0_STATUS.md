# Phase 0 status

Date: 2026-07-12

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

## Pending Docker acceptance

Docker Desktop is currently stopped because its setup flow rejected the
license. After the project owner accepts Docker Desktop's terms:

1. Run pnpm infra:up.
2. Confirm all three containers are healthy with pnpm infra:status.
3. Run pnpm db:migrate.
4. Run pnpm db:seed.
5. Re-run the complete Phase 0 verification.

No feature-phase implementation should begin until these infrastructure checks
pass.
