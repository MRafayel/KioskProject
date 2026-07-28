# End-to-end tests

`pnpm test:e2e` now runs both browser surfaces:

- kiosk Playwright projects at 1280×800 and 1920×1080;
- a 390×844 mobile upload project covering pre-render fragment removal,
  session-language continuity, responsive layout, synthetic upload/list/delete,
  HttpOnly-cookie refresh, and QR-token non-exposure.

The frontend browser tests mock their API boundary for deterministic visual and
accessibility behavior. `pnpm test:integration` separately exercises the same
contracts against the real local PostgreSQL, Redis, private MinIO, ClamAV, and
isolated processor services. Realtime replay, phone cancellation, document
validation, private preview authorization, and cleanup are covered at their
API/worker integration boundaries rather than by sharing mutable live worker
state with Playwright.
