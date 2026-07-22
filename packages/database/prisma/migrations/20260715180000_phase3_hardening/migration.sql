DROP INDEX "session_upload_grants_active_short_code_digest_idx";

CREATE UNIQUE INDEX "session_upload_grants_usable_short_code_digest_idx"
  ON "session_upload_grants"("short_code_digest")
  WHERE "status" IN ('ACTIVE', 'CLAIMED');

ALTER TABLE "uploaded_files"
  DROP CONSTRAINT "uploaded_files_object_key_check";

ALTER TABLE "uploaded_files"
  ADD CONSTRAINT "uploaded_files_object_key_check"
  CHECK (
    "quarantine_object_key" IS NULL
    OR (
      "quarantine_object_key" ~ '^quarantine/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{16,128}$'
      AND split_part("quarantine_object_key", '/', 3) = "session_id"::text
      AND split_part("quarantine_object_key", '/', 4) = "id"::text
    )
  );
