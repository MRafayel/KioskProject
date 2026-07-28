# Phase 0 status

- Date: 2026-07-13
- Status: complete
- Last reviewed: 2026-07-25 (Phases 0–4 review)

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

- pnpm install --frozen-lockfile
- pnpm format:check
- pnpm build
- pnpm lint
- pnpm typecheck
- pnpm test
- pnpm test:integration
- pnpm test:e2e
- pnpm infra:validate
- Prisma schema validation and client generation
- Docker engine and native arm64 container support
- Healthy PostgreSQL 17, Redis 7, and MinIO containers
- Loopback-only container port bindings
- Baseline Prisma migration applied successfully
- Seeded product scope read back from PostgreSQL
- API `/health/live` returns the print-only monochrome contract
- API `/health/ready` reports PostgreSQL, Redis, and object storage, and
  answers 503 when any one of them is genuinely unreachable

## Known issues

- `pnpm audit` reports four advisories: `react-router` (high),
  `postcss` (high), `brace-expansion` (high), and `valibot` (moderate).
  Three are development-only transitive dependencies. The `react-router`
  advisory covers RSC mode, which neither application uses; both mount a
  client-side router only. Resolving these is tracked as a follow-up decision
  rather than a Phase 0 gate. This section replaces the earlier
  "no known vulnerabilities" claim, which was true when first recorded.

## Changes since the original gate

The Phases 0–4 review on 2026-07-25 changed three Phase 0 behaviours:

- `DATABASE_URL` is now rejected at startup unless it is a `postgresql://` or
  `postgres://` URL. Previously any non-empty string was accepted and the
  failure surfaced later as an HTTP 500 from `/health/ready`.
- Readiness performs a real operation against each dependency — a `SELECT 1`
  through Prisma, a keyspace read over the realtime gateway's own Redis
  connection, and a bucket head request. The earlier TCP connect reported a
  healthy PostgreSQL and Redis whenever _any_ service answered on those ports.
- Kiosk-authenticated routes carry request ceilings, and repeated
  authentication failures from one source stop being answered. A credential
  that recently authenticated always keeps its lookup, so a guessing burst
  cannot refuse service to real devices sharing an apparent address behind a
  reverse proxy.

## Development machine

Verified on macOS 26.4 on 2026-07-25:

- Git 2.50.1, Homebrew 5.1.1
- nvm 0.40.3 with Node.js 24.18.0, Corepack 0.35.0, pnpm 11.12.0.
  Load nvm before using these commands; see the README.
- Docker Desktop with Docker 27.3.1 and Compose 2.29.7
- mkcert 1.4.4 for the trusted-LAN HTTPS steps in `docs/PHASE_3_STATUS.md`

Exact tool versions are not a gate. The pinned runtime (`.nvmrc`, `engines`)
and the frozen lockfile are.

The Phase 0 acceptance gate is satisfied.
