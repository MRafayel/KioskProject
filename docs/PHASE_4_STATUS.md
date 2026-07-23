# Phase 4 status

- Date: 2026-07-24
- Status: complete
- Scope: durable, authenticated kiosk updates with replay and safe mobile
  terminal notifications

## What works now

1. Session, phone, upload, rejection, deletion, cancellation, and expiration
   changes write an `outbox_events` row in the same PostgreSQL transaction as
   their authoritative state.
2. The worker claims outbox rows with a recoverable lease, creates an immutable
   `session_events` replay record, publishes a BullMQ delivery job, and only
   then marks the outbox row `PUBLISHED`.
3. The API consumes delivery jobs and emits each event to a private
   `kiosk:<kioskId>` Socket.IO room.
4. Only the local kiosk agent opens the cloud socket. It authenticates with the
   kiosk ID and device credential in the encrypted Socket.IO handshake; the
   browser never receives that credential.
5. The kiosk browser uses a loopback-only Server-Sent Events (SSE) endpoint on
   the agent. Each message contains a session ID and monotonically increasing
   sequence number, but no QR token, mobile cookie, filename, or kiosk key.
6. The agent treats Socket.IO as a wake-up signal, not as truth. It retrieves
   ordered events from `GET /v1/sessions/:id/events?after=<sequence>`, rejects
   gaps, deduplicates repeats, and replays after reconnect.
7. The kiosk performs an immediate file-snapshot refresh after relevant
   events. A 15-second snapshot reconciliation remains while connected, and a
   two-second fallback is used only while the local stream is unavailable.
8. `pnpm dev:kiosk` now starts the worker automatically with the API, agent,
   kiosk, and mobile page.
9. The mobile page has its own authenticated SSE stream, scoped by its dynamic
   HttpOnly session cookie. A kiosk cancellation disables file actions, clears
   misleading progress, and aborts an active browser upload instead of leaving
   it apparently frozen.
10. Push is an optimization, not authorization. The phone revalidates before
    upload and every 30 seconds, while the API independently verifies the
    session at reservation and finalization. Missing a notification can delay
    the closed message briefly, but cannot accept a file into a canceled
    session.
11. Mobile streams expire with the credential and are capped at two concurrent
    connections per mobile client. This permits a brief reload overlap without
    allowing one claimed QR session to hold unbounded server resources.
12. Deferred janitor cleanup now creates the same durable `file.rejected` or
    `file.deleted` event as the immediate path, exactly once.

## Delivery architecture

```text
State-changing API transaction
  ├── authoritative session/file row
  └── outbox_events(sequence N)
             |
             v
Worker: claim -> session_events -> BullMQ -> mark PUBLISHED
                                      |
                                      v
API realtime gateway
  ├── private kiosk:<kioskId> Socket.IO room
  |      └── authenticated device socket -> local kiosk agent
  |                                          └── loopback SSE -> kiosk browser
  └── local authenticated event bus -> mobile SSE -> phone

Local kiosk agent recovery on connect/gap:
  authenticated PostgreSQL replay endpoint -> snapshot reconciliation
```

PostgreSQL is the durable source of truth. Redis/BullMQ and Socket.IO improve
latency but can be cleared or disconnected without losing the event history or
changing session state.

## Event contract

The durable Phase 4 event types are:

- `session.created`
- `mobile.connected`
- `upload.started`
- `file.uploaded` — upload is safely quarantined, not yet printable
- `file.rejected`
- `file.deleted`
- `session.canceled`
- `session.expired`

Every event has an opaque UUID, owning session UUID, positive per-session
sequence, timestamp, discriminated type, and a schema-validated safe payload.
The outbox publisher removes extra internal fields before materialization.

Exact byte-level progress remains on the phone, where the XMLHttpRequest upload
already measures it accurately. The kiosk receives lifecycle progress
(`upload.started`, accepted/rejected, deleted), which avoids high-frequency
database writes and misleading recovery of stale percentages. A future
best-effort throttled progress channel may be added without changing durable
event ordering.

Phase 5 will add `file.ready` after sandboxed validation, malware scanning,
normalization, and preview generation. Until then, a genuine upload remains
`QUARANTINED` and cannot unlock print settings.

## Security and recovery properties

- Socket authentication uses the existing revocable kiosk credential and
  requires `sessions:read`.
- A caller cannot select another kiosk room: the room identity comes from the
  authenticated credential, and a mismatched claimed kiosk ID is rejected.
- The API key is held only by the local agent and is never placed in a browser
  URL, SSE payload, event payload, or replay response.
- Event replay first verifies that the authenticated kiosk owns the session.
  Missing and foreign sessions both remain outside the caller's visibility.
- The SSE listener is protected by the agent's loopback-only request guard.
- The phone never connects to the privileged kiosk SSE endpoint. Its status
  stream and status checks use only the scoped HttpOnly mobile cookie, and
  transient network errors are not confused with an authoritative
  cancellation.
- The API remains authoritative at upload authentication, reservation, and
  finalization. A cancellation therefore cannot create or accept a new file
  even if a backgrounded phone delays or misses its local event.
- Mobile stream expiry, per-client concurrency limits, a coalesced reconnect
  check, and low-frequency reconciliation prevent stale UI and unbounded
  long-lived connections.
- Socket payloads are capped, WebSocket-only, and schema validated at both
  ingress and egress.
- Outbox claims recover after a process crash. Publication attempts use bounded
  exponential backoff and become terminal only after 20 failures. A unique
  claim token prevents a stale publisher from completing or releasing work
  reclaimed by another publisher.
- Duplicate outbox work is harmless: `(session_id, sequence)` is unique, event
  materialization uses an upsert, and the BullMQ job ID is the event UUID.
- After a worker, API, agent, browser, Redis, or network restart, replay plus
  the authoritative file snapshot restores the correct visible state.

## Database migration

Migration `20260723010000_phase4_realtime_events` adds:

- `session_events`, uniquely indexed by `(session_id, sequence)`;
- `available_at`, `locked_at`, and `last_error_code` to `outbox_events`;
- recoverable `PROCESSING` and terminal `FAILED` outbox states;
- indexes for ordered replay and efficient publisher claims.

Migration `20260724010000_phase4_outbox_claim_token` additively adds the UUID
claim token. It is separate because the first Phase 4 migration had already
been applied locally; no reset or destructive migration is required. Both
migrations were applied successfully to the local PostgreSQL development
container.

## MVP deployment boundary

Phase 4 currently supports one API/realtime gateway replica. The mobile SSE bus
is deliberately hidden behind source/sink interfaces, but its implementation
is process-local. Before horizontally scaling the API, add Redis-backed fanout
so every gateway receives each wake-up (and configure the Socket.IO Redis
adapter for kiosk rooms). Keep PostgreSQL replay and the phone's low-frequency
context reconciliation: Redis must remain a latency aid, never the durable
source of truth. A production Redis service outside the kiosk host must use
`rediss://`; plaintext `redis://` is accepted only for a loopback sidecar.

## Run locally

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

Open `http://127.0.0.1:5173`. The worker is now part of `dev:kiosk`; starting
only the kiosk Vite package will not provide sessions or realtime delivery.

Useful checks:

```bash
curl -s http://127.0.0.1:3000/health/ready
curl -s http://127.0.0.1:3100/health/ready
pnpm infra:status
pnpm infra:logs
```

Worker logs safely show outbox event ID, session ID, and sequence. They do not
log event payloads or credentials. Use only synthetic documents in development.
The trusted phone HTTPS procedure remains in `docs/PHASE_3_STATUS.md`.

## Verification evidence

- Formatting and all 15 lint tasks pass.
- All 15 TypeScript tasks and all 10 production builds pass.
- 131 unit/component tests pass.
- All 17 PostgreSQL/MinIO/Redis integration tests pass.
- The realtime integration test proves authenticated connection, rejection of
  an invalid credential, publication after commit, private-room and local
  mobile-bus delivery, and PostgreSQL replay after disconnect.
- Unit tests cover outbox materialization order, duplicate/out-of-order event
  handling, ownership-safe lease recovery, deferred janitor finalization,
  stream credential expiry/concurrency, coalesced reconnect checks, gap
  recovery, pagination, and EventSource fallback.
- All 10 kiosk Playwright scenarios (five journeys at two kiosk resolutions)
  and all three mobile Playwright scenarios pass. Mobile coverage includes both
  preflight rejection and pushed cancellation aborting an already active
  upload.
- A live smoke returned API and agent readiness 200, claimed a synthetic
  session as a phone, and observed `session.canceled` through the real
  worker/API/authenticated-mobile-SSE path.
- All live test processes were stopped; ports 3000, 3100, 5173, and 5174 were
  confirmed closed afterwards.
- `pnpm audit --prod --audit-level=moderate` reports no known vulnerabilities.
  The newly published HTTP/2 denial-of-service advisory
  `GHSA-c96f-x56v-gq3h` is resolved by the `find-my-way` 9.7.0 override.
- The mobile production build still reports a non-blocking 537 kB chunk-size
  warning. Code splitting remains a later performance optimization; it does
  not change the Phase 4 security or workflow result.

## Next phase

Phase 5 turns untrusted quarantined bytes into bounded inert previews and a
canonical print-ready PDF. It adds sandboxed parsing, page and image limits,
malware scanning, normalization, preview authorization, and the real transition
to `READY` or a safe rejection code.
