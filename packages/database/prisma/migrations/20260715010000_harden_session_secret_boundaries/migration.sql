-- Legacy upload grants were generated randomly and cannot be reconstructed by
-- the secure replay design. Revoke both usable legacy states; the preceding
-- migration already canceled their nonterminal sessions.
UPDATE "session_upload_grants"
SET "status" = 'REVOKED', "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP)
WHERE "status" IN ('ACTIVE', 'CLAIMED');

-- A create replay may persist only the exact public session snapshot. Keeping
-- an exact key allowlist prevents raw upload credentials from being hidden
-- below the session key if application validation ever regresses.
ALTER TABLE "idempotency_records"
  DROP CONSTRAINT "idempotency_records_create_response_sanitized_check";

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_create_response_sanitized_check"
  CHECK (
    "action" <> 'sessions.create'
    OR (
      jsonb_typeof("response_body") = 'object'
      AND ("response_body" - 'session') = '{}'::jsonb
      AND jsonb_typeof("response_body" -> 'session') = 'object'
      AND ("response_body" -> 'session') ?& ARRAY[
        'id',
        'publicId',
        'kioskId',
        'locale',
        'state',
        'version',
        'expiresAt',
        'hardExpiresAt',
        'createdAt',
        'canceledAt'
      ]::text[]
      AND (("response_body" -> 'session') - ARRAY[
        'id',
        'publicId',
        'kioskId',
        'locale',
        'state',
        'version',
        'expiresAt',
        'hardExpiresAt',
        'createdAt',
        'canceledAt'
      ]::text[]) = '{}'::jsonb
    )
  );
