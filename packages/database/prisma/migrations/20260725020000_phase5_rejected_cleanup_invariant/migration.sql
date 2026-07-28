-- A REJECTED row is a public, terminal rejection only after all private bytes
-- have been removed. Normalize any transitional rows admitted by the first
-- Phase 5 migration back into the durable janitor queue before tightening the
-- invariant. This follow-up is additive because 20260725010000 may already be
-- applied in developer and rolling-deployment databases.
UPDATE "uploaded_files"
SET
  "status" = 'DELETE_PENDING',
  "processing_claim_token" = NULL,
  "processing_lease_expires_at" = NULL,
  "processing_enqueued_at" = NULL,
  "cleanup_due_at" = COALESCE("cleanup_due_at", CURRENT_TIMESTAMP),
  "cleanup_error_code" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "status" = 'REJECTED'
  AND (
    "quarantine_object_key" IS NOT NULL
    OR "content_sha256" IS NOT NULL
  );

ALTER TABLE "uploaded_files"
  ADD CONSTRAINT "uploaded_files_rejected_bytes_scrubbed_check"
  CHECK (
    "status" <> 'REJECTED'
    OR (
      "quarantine_object_key" IS NULL
      AND "content_sha256" IS NULL
    )
  );
