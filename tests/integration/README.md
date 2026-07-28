# Integration tests

These tests use real loopback-only PostgreSQL, Redis, MinIO, ClamAV, and
document-processor services. They mutate and clean the configured development
database and private object bucket.

From the repository root:

```bash
pnpm infra:up
pnpm db:verify-phase5-upgrade
pnpm db:migrate
pnpm db:seed
pnpm infra:status
pnpm test:integration
```

Do not leave `pnpm dev:kiosk` or another dispatcher/worker running during the
integration suite. The tests start their own coordinator and intentionally run
test files without file-level parallelism so a second worker cannot claim a
fixture.

The suite fails closed unless `NODE_ENV=test` and every destructive target
(PostgreSQL, Redis, S3 endpoint, and processor) resolves to loopback. This guard
must not be bypassed to point tests at shared, staging, or production data.

`db:verify-phase5-upgrade` has an independent loopback guard. It creates a
uniquely named temporary database, verifies that a Phase 4 quarantined-file row
survives the Phase 5 migrations with safe defaults, and removes that temporary
database even when verification fails.

All fixtures are synthetic. Never place customer documents in this directory.
