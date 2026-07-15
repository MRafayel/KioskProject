# Integration tests

These tests use the real local PostgreSQL service. Run `pnpm infra:up`,
`pnpm db:migrate`, and `pnpm db:seed` before `pnpm test:integration`.

All fixtures are synthetic. Never place customer documents in this directory.
