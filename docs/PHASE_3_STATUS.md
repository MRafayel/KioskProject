# Phase 3 status

- Date: 2026-07-15
- Status: complete
- Scope: QR claim and one private PDF/JPEG/PNG upload into quarantine

## What works now

1. The kiosk requests an authoritative temporary session from the local agent.
2. The API returns an opaque public route and a high-entropy upload token in the
   URL fragment.
3. The kiosk renders the QR URL. The unused numeric fallback is intentionally
   hidden until a secure manual-claim design is implemented.
4. A responsive Armenian/Russian/English phone page erases the complete URL
   fragment before importing React or application modules.
5. The phone atomically exchanges the token for a session-specific, host-only,
   HttpOnly, SameSite=Strict cookie and a derived CSRF token. The first phone
   wins; a second nonce cannot claim the same QR code. A lost response can be
   retried with the same in-memory token and nonce.
6. The phone streams one PDF, JPEG, or PNG as multipart data. It shows upload
   progress and can list or delete the safe server projection.
7. The API reserves count and byte quota before storage, enforces declared and
   actual byte limits while streaming, calculates SHA-256, and checks the exact
   extension/MIME/magic-signature combination.
8. Accepted bytes use opaque keys in a private MinIO quarantine prefix. They
   become `QUARANTINED`, never `READY` or printable in this phase.
9. The kiosk polls the loopback agent for the file snapshot. It shows uploading,
   checking, rejected, and cleanup states without receiving a customer filename
   or a mobile credential.
10. Cancellation, expiration, customer deletion, interrupted upload recovery,
    and a background janitor converge on object deletion. A one-day bucket
    lifecycle rule and incomplete-multipart abort are a final local backstop.

## Deliberate Phase 3 boundary

Phase 3 does **not** parse a PDF deeply, count pages, rasterize a preview, scan
for malware, or make a file printable. Those operations require a sandboxed
processing pipeline in Phase 5. Consequently, a real uploaded file remains in
the “checking” state and the print-settings button stays disabled. Phase 1's
settings/payment/printing screens remain test-only fixtures for now.

Phase 4 will replace one-second kiosk polling with authenticated, sequenced
events plus snapshot recovery. Redis is healthy but is not treated as durable
session truth in Phase 3.

## Security and privacy properties

- Raw QR tokens, mobile cookies, client nonces, kiosk keys, and idempotency keys
  are never stored directly in PostgreSQL; context-bound keyed digests are used.
- The QR token is never sent in an HTTP request URL, Referer header, object key,
  database replay response, audit event, or log field.
- Customer filenames are used only transiently for extension validation. API
  responses, database display names, storage keys, audit metadata, and kiosk UI
  use generated generic names.
- Mobile mutations require the exact configured Origin, a session-specific
  HttpOnly cookie, and the derived CSRF token. Cookie names are session-specific,
  so one browser can safely hold independent sessions from multiple kiosks.
- The first phone claim is serialized in PostgreSQL. Refresh uses the scoped
  cookie; a different phone receives `UPLOAD_GRANT_ALREADY_CLAIMED`.
- Object storage is private. The development API service account can put and
  delete quarantine objects but cannot read document contents.
- Uploads and deletes have bounded deadlines. Client disconnects abort stream
  processing and multipart storage. Cleanup retries are idempotent and use a
  compare-and-claim update so multiple API processes do not delete the same row
  concurrently.
- Cancellation revokes both the QR grant and mobile client. The kiosk retains
  the same cancellation idempotency key and does not claim success while server
  cleanup is uncertain.
- API logging disables automatic request logs and redacts Authorization,
  Cookie, CSRF, Idempotency-Key, and Set-Cookie values if logging is enabled.
- Ordinary API bodies are capped at 16 KiB. Only the authenticated multipart
  upload route opts into the configured file-sized body limit.
- Production configuration rejects known placeholders, reused cryptographic
  keys, insecure public origins, and unencrypted object writes. Use managed
  object storage with SSE-S3 or SSE-KMS; local MinIO is synthetic-data-only.
- The development seed accepts only its built-in loopback target or an explicit
  development/test loopback target; it cannot rotate a known development
  credential in a remote or production database.
- Mobile development responses include frame denial, no-referrer, no-sniff,
  restrictive CSP, permissions policy, and no-store API caching.

Secure deletion on SSDs and managed object storage is logical deletion, not a
guarantee that physical blocks are overwritten. Production retention, backup,
replication, and cryptographic-erasure policies remain mandatory before a
public pilot.

## API delivered

| Method   | Route                                      | Caller                        | Result                                      |
| -------- | ------------------------------------------ | ----------------------------- | ------------------------------------------- |
| `POST`   | `/v1/mobile-auth/exchange`                 | QR phone                      | Claims one grant and sets the scoped cookie |
| `GET`    | `/v1/mobile-auth/:publicSessionId/context` | Claimed phone                 | Restores safe session context after refresh |
| `POST`   | `/v1/sessions/:sessionId/files`            | Claimed phone                 | Streams exactly one file into quarantine    |
| `GET`    | `/v1/sessions/:sessionId/files`            | Claimed phone or owning kiosk | Returns safe file snapshots only            |
| `DELETE` | `/v1/sessions/:sessionId/files/:fileId`    | Claimed phone                 | Idempotently removes one owned file         |

The existing session create/read/cancel endpoints remain the authority. Upload
and file routes never accept a client-provided kiosk identity.

## Database and storage

Phase 3 adds `mobile_clients` and `uploaded_files`, claim metadata on
`session_upload_grants`, and an independent monotonic `event_sequence` on
`print_sessions`. Migrations:

- `20260715120000_phase3_mobile_upload`
- `20260715180000_phase3_hardening`

Constraints bind each object key to its real session and file UUID, restrict
status/lifecycle combinations, allow only one active mobile client and one
active writer per session, and prevent secret-bearing file idempotency bodies.
Rejected/deleted rows remain as private lifecycle records, do not consume upload
quota, and receive monotonically increasing ordinals when replaced.

## Run locally on this computer

On a first checkout, copy `.env.example` to the ignored `.env` file. Generate a
different value for each `replace-with-...` secret with
`openssl rand -base64 48`. The development seed accepts the built-in loopback
default on a clean checkout. Any explicitly configured database requires
`NODE_ENV=development` or `test`, and every seed target must be on loopback.

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Open `http://127.0.0.1:5173` and start a session. For synthetic same-computer
testing only, inspect the `POST /agent/v1/sessions` response in the kiosk
browser's Network panel, copy `upload.qrUrl`, and open it in a separate private
browser profile. Treat the URL as a temporary bearer secret and close the
Network panel afterward. For a real phone, use the trusted HTTPS procedure
below. The root `.env` file is loaded consistently even though pnpm runs API,
agent, worker, and Prisma commands from different package directories.

Useful checks while it runs:

```bash
curl -s http://127.0.0.1:3000/health/ready
curl -s http://127.0.0.1:3100/health/ready
pnpm infra:status
pnpm infra:logs
```

MinIO console is development-only at `http://127.0.0.1:9001`. Do not upload a
real private document; use a synthetic test PDF or image.

## Test from a phone on the same Wi-Fi with HTTPS

The phone must not receive a `localhost` QR URL—on a phone, `localhost` means
the phone itself. Keep the API and MinIO bound to laptop loopback; only Vite's
mobile origin needs to be reachable because it proxies `/v1` to the loopback
API.

1. Install `mkcert` and find the laptop's Wi-Fi address:

   ```bash
   brew install mkcert
   mkcert -install
   ipconfig getifaddr en0
   ```

2. Replace `192.168.1.50` below with that address and create a certificate:

   ```bash
   mkdir -p .certs
   mkcert -cert-file .certs/dev.pem -key-file .certs/dev-key.pem \
     localhost 127.0.0.1 ::1 192.168.1.50
   ```

3. Copy `.env.example` to the ignored `.env`. Generate a different value for
   every development secret with `openssl rand -base64 48`, then set:

   ```dotenv
   UPLOAD_ORIGIN=https://192.168.1.50:5174
   PUBLIC_UPLOAD_ORIGIN=https://192.168.1.50:5174
   DEV_HTTPS_CERT_PATH=.certs/dev.pem
   DEV_HTTPS_KEY_PATH=.certs/dev-key.pem
   ```

4. Install and explicitly trust mkcert's local root CA on the test phone. Find
   it with `mkcert -CAROOT`. Never share that CA private key.
5. Restart `pnpm dev:kiosk`, permit inbound port `5174` in the laptop firewall,
   and confirm the phone can open `https://192.168.1.50:5174`.
6. Start at the kiosk and scan the new QR. Guest Wi-Fi client isolation can
   prevent phone-to-laptop traffic even when both devices show the same SSID.

Do not expose ports `3000`, `5432`, `6379`, `9000`, or `9001` to the LAN. An
authenticated development tunnel is an alternative for synthetic fixtures,
but it is never production hosting.

## Verification evidence

- 101 unit/component tests and 9 Playwright browser scenarios pass. Formatting,
  all 15 lint tasks, all 15 typecheck tasks, and all 10 production builds pass.
- 14 PostgreSQL/MinIO integration tests pass, covering session concurrency and
  expiry, first-phone claim and same-nonce replay, exact Origin, private object
  access, upload replay, spoofed signatures, multiple multipart parts, count
  limits, CSRF, replacement after deletion/rejection, revocation, and cleanup.
- API tests cover bounded stream inspection, source interruption, S3 abort,
  multipart cleanup, encrypted upload parameters, delete deadlines, safe
  multipart errors, and preserved 429 responses.
- Mobile tests cover fragment capture, same-nonce retry, request/upload timeout,
  cryptographic UUID fallback, locale continuity, translated errors, list,
  upload, and delete behavior.
- Mobile Playwright coverage runs at 390×844 and verifies fragment removal
  before token exchange, responsive layout, synthetic upload/list/delete,
  cookie refresh, strict CSP, and token non-exposure in URLs, DOM, and browser
  storage.
- Kiosk tests cover safe polling, rejection, fail-closed unknown status,
  cancellation retry, stable idempotency, active-upload inactivity handling,
  and hidden numeric code.
- The migration was applied to the local PostgreSQL container. MinIO reports a
  private bucket and a successfully imported quarantine lifecycle policy.
- A live local smoke verified API/agent readiness, both Vite applications,
  strict mobile CSP, real session creation, QR shape, file listing, and clean
  cancellation through the loopback agent.
- `pnpm audit --prod --audit-level=moderate` reports no known production
  dependency vulnerabilities at the completion date.

## Next phase

Phase 4 adds the durable real-time path: transactional outbox publishing,
authenticated agent connection, per-session event sequencing, reconnect replay,
and snapshot resynchronization. PostgreSQL remains authoritative throughout.
