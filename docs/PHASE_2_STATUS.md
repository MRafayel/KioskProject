# Phase 2 status

- Date: 2026-07-15
- Status: complete

## Implemented

- Seeded development kiosk and revocable, scoped kiosk credential.
- Authoritative PostgreSQL print sessions with UUIDv7 IDs, opaque public IDs,
  eight-digit fallback codes, idle/absolute expiry, locale, state, and optimistic
  version.
- Pure session transition rules shared outside the API and protected against
  stale versions.
- Authenticated create, read, and cancel endpoints.
- Idempotent create/cancel operations with request-hash verification. Raw
  idempotency keys are stored only as context-bound HMAC digests. Create
  records persist only a sanitized session snapshot; an exact create response
  is reconstructed only while the original upload grant is still safely
  replayable.
- One active session per kiosk enforced in both application logic and a partial
  unique PostgreSQL index.
- Audit and outbox rows written in the same serializable transaction as each
  session state change.
- Injected clock and random-source boundaries for deterministic expiry and
  allocation tests.
- Loopback-only kiosk-agent facade. The React kiosk sends requests to the local
  agent; only the agent adds the private kiosk credential to cloud API calls.
- Kiosk start, customer cancellation, idle timeout, and prototype completion
  now release the authoritative server session. The existing simulated upload,
  payment, and printing screens remain mocks until their planned phases.
- Printing-progress screen keeps timeout enforcement but no longer displays the
  countdown.

## Security properties

- Raw QR upload tokens and fallback codes are returned only in the create
  response. They are derived with domain-separated HMAC inputs so an exact
  retry can be reconstructed without persistence. PostgreSQL stores keyed HMAC
  digests, never the raw values.
- Create replay verifies both the upload-token and fallback-code digests with
  timing-safe comparison. It fails closed after the session advances, expires,
  or its grant is claimed/revoked, and if any stored value is inconsistent.
- PostgreSQL constraints allow a create idempotency record to contain only the
  exact public session-snapshot keys. They reject upload data at the top level
  or hidden inside the snapshot.
- The upload token is placed in the URL fragment, which is not sent in the HTTP
  request to the mobile origin. Fragment exchange and cookie issuance belong to
  Phase 3.
- Kiosk API credentials do not enter the browser bundle or agent response.
- Session responses are marked `Cache-Control: no-store` at both the cloud API
  and local facade.
- Session ownership is derived from the authenticated kiosk credential, not a
  client-provided kiosk claim. Versioned row locks also include the owning
  kiosk ID, preventing cross-kiosk lock abuse.
- Production configuration requires HTTPS for public/mobile origins and for
  any non-loopback API or kiosk origin.
- Cancel uses `If-Match` and returns `412` for stale versions; invalid lifecycle
  transitions return `409`.

## Database entities

- `kiosks`
- `kiosk_credentials`
- `print_sessions`
- `session_upload_grants`
- `audit_events`
- `outbox_events`
- `idempotency_records`

Migrations `20260714000000_phase2_sessions`,
`20260715000000_secure_idempotency_storage`, and
`20260715010000_harden_session_secret_boundaries` were applied successfully to
the healthy local PostgreSQL container and the development kiosk was seeded.

The security migrations intentionally revoke every legacy usable upload grant,
cancel legacy nonterminal sessions, and purge legacy idempotency rows because
their old create responses contained non-reconstructable credentials. Any
session open before this migration must be started again.

## Verified

- Twelve real-PostgreSQL integration tests cover exact safe replay,
  digest-only secret storage, database secret constraints, tamper refusal,
  replay refusal after state advancement, tenant isolation, expired-key reuse,
  one-active-session enforcement, concurrent create/cancel behavior, exact
  expiry, replacement after expiry, and allocation collision retry.
- Four domain tests cover the transition table, stale versions, transition
  version increments with property-based testing, and exact expiry.
- API tests verify health and pre-database authentication rejection.
- Kiosk-agent tests verify credential forwarding, secret non-disclosure, and a
  controlled offline response.
- Kiosk component tests and all eight Playwright tests pass at 1280×800 and
  1920×1080, including the hidden printing countdown.
- Repository format, lint, strict type-check, unit test, and production build
  gates pass.

## Operational security notes

- `UPLOAD_TOKEN_PEPPER` rotation currently invalidates active grants and makes
  existing idempotency records unreachable. Until a versioned pepper keyring
  is implemented, rotate it only with the same revoke/cancel/purge procedure
  used by the security migration.
- SQL `DELETE` is logical deletion. Old bytes can remain in PostgreSQL heap
  pages, WAL, snapshots, or backups until normal database and backup retention
  expires. Revocation makes historical upload grants unusable; production
  retention and media-destruction procedures remain a Phase 12 requirement.
- These migrations are appropriate for the current single-developer MVP and
  require downtime. A future rolling deployment needs an expand/backfill/
  contract migration sequence.

## Phase 3 boundary

The mobile application is still a placeholder and no customer file is accepted
yet. Phase 3 will implement QR-token exchange, a scoped HttpOnly mobile grant,
private MinIO quarantine storage, bounded PDF/JPEG/PNG upload, list/delete, and
phone-to-kiosk progress. Real payment and printer behavior remain out of scope
for that phase.
