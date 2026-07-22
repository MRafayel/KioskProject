# End-to-end tests

`pnpm test:e2e` now runs both browser surfaces:

- kiosk Playwright projects at 1280×800 and 1920×1080;
- a 390×844 mobile upload project covering pre-render fragment removal,
  session-language continuity, responsive layout, synthetic upload/list/delete,
  HttpOnly-cookie refresh, and QR-token non-exposure.

The frontend browser tests mock their API boundary for deterministic visual and
accessibility behavior. `pnpm test:integration` separately exercises the same
contracts against real PostgreSQL and private MinIO. Phase 4 will add a single
live two-context kiosk/phone journey over the sequenced event channel.
