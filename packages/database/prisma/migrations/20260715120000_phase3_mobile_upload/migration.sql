ALTER TABLE "print_sessions"
  ADD COLUMN "event_sequence" INTEGER NOT NULL DEFAULT 1;

UPDATE "print_sessions" AS "session"
SET "event_sequence" = GREATEST(
  "session"."state_version",
  COALESCE((
    SELECT MAX("event"."sequence")
    FROM "outbox_events" AS "event"
    WHERE "event"."aggregate_id" = "session"."id"
  ), 1)
);

ALTER TABLE "print_sessions"
  ADD CONSTRAINT "print_sessions_event_sequence_check"
  CHECK ("event_sequence" > 0);

ALTER TABLE "session_upload_grants"
  ADD COLUMN "claimed_client_id" UUID,
  ADD COLUMN "claimed_at" TIMESTAMPTZ;

DROP INDEX "session_upload_grants_session_id_key";
DROP INDEX "session_upload_grants_short_code_digest_key";

CREATE TABLE "mobile_clients" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "cookie_digest" VARCHAR(64) NOT NULL,
  "client_nonce_digest" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "expires_at" TIMESTAMPTZ NOT NULL,
  "last_seen_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "mobile_clients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mobile_clients_status_check"
    CHECK ("status" IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  CONSTRAINT "mobile_clients_cookie_digest_check"
    CHECK ("cookie_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mobile_clients_nonce_digest_check"
    CHECK ("client_nonce_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mobile_clients_lifecycle_check"
    CHECK (
      ("status" = 'ACTIVE' AND "revoked_at" IS NULL)
      OR ("status" IN ('REVOKED', 'EXPIRED') AND "revoked_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "mobile_clients_cookie_digest_key"
  ON "mobile_clients"("cookie_digest");
CREATE UNIQUE INDEX "mobile_clients_id_session_id_key"
  ON "mobile_clients"("id", "session_id");
CREATE UNIQUE INDEX "mobile_clients_session_id_client_nonce_digest_key"
  ON "mobile_clients"("session_id", "client_nonce_digest");
CREATE UNIQUE INDEX "mobile_clients_one_active_per_session_idx"
  ON "mobile_clients"("session_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "mobile_clients_session_id_status_idx"
  ON "mobile_clients"("session_id", "status");
CREATE INDEX "mobile_clients_status_expires_at_idx"
  ON "mobile_clients"("status", "expires_at");

CREATE UNIQUE INDEX "session_upload_grants_claimed_client_id_session_id_key"
  ON "session_upload_grants"("claimed_client_id", "session_id");
CREATE UNIQUE INDEX "session_upload_grants_one_usable_per_session_idx"
  ON "session_upload_grants"("session_id")
  WHERE "status" IN ('ACTIVE', 'CLAIMED');
CREATE UNIQUE INDEX "session_upload_grants_active_short_code_digest_idx"
  ON "session_upload_grants"("short_code_digest")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "session_upload_grants"
  ADD CONSTRAINT "session_upload_grants_claim_consistency_check"
  CHECK (
    (
      "status" = 'ACTIVE'
      AND "claimed_client_id" IS NULL
      AND "claimed_at" IS NULL
      AND "revoked_at" IS NULL
    )
    OR (
      "status" = 'CLAIMED'
      AND "claimed_client_id" IS NOT NULL
      AND "claimed_at" IS NOT NULL
      AND "revoked_at" IS NULL
    )
    OR (
      "status" IN ('REVOKED', 'EXPIRED')
      AND "revoked_at" IS NOT NULL
    )
  );

CREATE TABLE "uploaded_files" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "uploaded_by_client_id" UUID NOT NULL,
  "client_file_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "display_name" VARCHAR(160) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "kind" VARCHAR(12),
  "declared_mime" VARCHAR(100),
  "detected_mime" VARCHAR(100),
  "extension" VARCHAR(10),
  "reserved_bytes" INTEGER NOT NULL,
  "size_bytes" INTEGER,
  "content_sha256" VARCHAR(64),
  "quarantine_object_key" VARCHAR(512),
  "rejection_code" VARCHAR(80),
  "cleanup_attempts" INTEGER NOT NULL DEFAULT 0,
  "cleanup_due_at" TIMESTAMPTZ,
  "cleanup_error_code" VARCHAR(80),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "quarantined_at" TIMESTAMPTZ,
  "delete_requested_at" TIMESTAMPTZ,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uploaded_files_status_check"
    CHECK ("status" IN (
      'UPLOADING',
      'QUARANTINED',
      'REJECTED',
      'DELETING',
      'DELETE_PENDING',
      'DELETED'
    )),
  CONSTRAINT "uploaded_files_numeric_check"
    CHECK (
      "ordinal" >= 0
      AND "reserved_bytes" > 0
      AND ("size_bytes" IS NULL OR "size_bytes" BETWEEN 1 AND 104857600)
      AND "cleanup_attempts" >= 0
    ),
  CONSTRAINT "uploaded_files_digest_check"
    CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "uploaded_files_object_key_check"
    CHECK (
      "quarantine_object_key" IS NULL
      OR "quarantine_object_key" ~ '^quarantine/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{16,128}$'
    ),
  CONSTRAINT "uploaded_files_lifecycle_check"
    CHECK (
      (
        "status" = 'UPLOADING'
        AND "quarantine_object_key" IS NOT NULL
        AND "size_bytes" IS NULL
        AND "content_sha256" IS NULL
      )
      OR (
        "status" = 'QUARANTINED'
        AND "kind" IS NOT NULL
        AND "detected_mime" IS NOT NULL
        AND "extension" IS NOT NULL
        AND "size_bytes" > 0
        AND "content_sha256" IS NOT NULL
        AND "quarantine_object_key" IS NOT NULL
        AND "quarantined_at" IS NOT NULL
      )
      OR (
        "status" = 'REJECTED'
        AND "rejection_code" IS NOT NULL
        AND "quarantine_object_key" IS NULL
        AND "content_sha256" IS NULL
      )
      OR "status" IN ('DELETING', 'DELETE_PENDING')
      OR (
        "status" = 'DELETED'
        AND "quarantine_object_key" IS NULL
        AND "content_sha256" IS NULL
        AND "deleted_at" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "uploaded_files_quarantine_object_key_key"
  ON "uploaded_files"("quarantine_object_key");
CREATE UNIQUE INDEX "uploaded_files_session_id_client_file_id_key"
  ON "uploaded_files"("session_id", "client_file_id");
CREATE UNIQUE INDEX "uploaded_files_session_id_ordinal_key"
  ON "uploaded_files"("session_id", "ordinal");
CREATE UNIQUE INDEX "uploaded_files_one_uploading_per_session_idx"
  ON "uploaded_files"("session_id") WHERE "status" = 'UPLOADING';
CREATE INDEX "uploaded_files_session_id_status_ordinal_idx"
  ON "uploaded_files"("session_id", "status", "ordinal");
CREATE INDEX "uploaded_files_status_updated_at_idx"
  ON "uploaded_files"("status", "updated_at");
CREATE INDEX "uploaded_files_cleanup_due_at_idx"
  ON "uploaded_files"("cleanup_due_at");

ALTER TABLE "mobile_clients"
  ADD CONSTRAINT "mobile_clients_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session_upload_grants"
  ADD CONSTRAINT "session_upload_grants_claimed_client_id_session_id_fkey"
  FOREIGN KEY ("claimed_client_id", "session_id")
  REFERENCES "mobile_clients"("id", "session_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "uploaded_files"
  ADD CONSTRAINT "uploaded_files_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "uploaded_files"
  ADD CONSTRAINT "uploaded_files_uploaded_by_client_id_session_id_fkey"
  FOREIGN KEY ("uploaded_by_client_id", "session_id")
  REFERENCES "mobile_clients"("id", "session_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_file_response_sanitized_check"
  CHECK (
    "action" NOT LIKE 'files.upload:%'
    OR (
      jsonb_typeof("response_body") = 'object'
      AND ("response_body" - 'file') = '{}'::jsonb
      AND jsonb_typeof("response_body" -> 'file') = 'object'
      AND ("response_body" -> 'file') ?& ARRAY[
        'id', 'ordinal', 'status', 'kind', 'sizeBytes', 'createdAt'
      ]::text[]
      AND (("response_body" -> 'file') - ARRAY[
        'id', 'ordinal', 'status', 'kind', 'sizeBytes', 'createdAt'
      ]::text[]) = '{}'::jsonb
    )
  );

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_file_delete_sanitized_check"
  CHECK (
    "action" NOT LIKE 'files.delete:%'
    OR "response_body" = '{}'::jsonb
  );
