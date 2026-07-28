-- Phase 5 processing state is additive. Existing Phase 3 rows receive neutral
-- defaults and remain valid while quarantined files wait for dispatch.
ALTER TABLE "uploaded_files"
  ADD COLUMN "processing_revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "processing_generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processing_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processing_available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "processing_enqueued_at" TIMESTAMPTZ,
  ADD COLUMN "processing_claim_token" UUID,
  ADD COLUMN "processing_lease_expires_at" TIMESTAMPTZ,
  ADD COLUMN "processing_started_at" TIMESTAMPTZ,
  ADD COLUMN "processing_error_code" VARCHAR(80),
  ADD COLUMN "malware_scan_status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "page_count" INTEGER,
  ADD COLUMN "ready_at" TIMESTAMPTZ;

ALTER TABLE "uploaded_files"
  DROP CONSTRAINT "uploaded_files_status_check",
  DROP CONSTRAINT "uploaded_files_numeric_check",
  DROP CONSTRAINT "uploaded_files_lifecycle_check";

ALTER TABLE "uploaded_files"
  ADD CONSTRAINT "uploaded_files_status_check"
  CHECK ("status" IN (
    'UPLOADING',
    'QUARANTINED',
    'VALIDATING',
    'READY',
    'REJECTED',
    'DELETING',
    'DELETE_PENDING',
    'DELETED'
  )),
  ADD CONSTRAINT "uploaded_files_numeric_check"
  CHECK (
    "ordinal" >= 0
    AND "reserved_bytes" > 0
    AND ("size_bytes" IS NULL OR "size_bytes" BETWEEN 1 AND 104857600)
    AND "cleanup_attempts" >= 0
    AND "processing_revision" > 0
    AND "processing_generation" >= 0
    AND "processing_attempts" >= 0
    AND ("page_count" IS NULL OR "page_count" BETWEEN 1 AND 1000)
  ),
  ADD CONSTRAINT "uploaded_files_malware_scan_status_check"
  CHECK ("malware_scan_status" IN ('PENDING', 'SCANNING', 'CLEAN', 'INFECTED', 'ERROR')),
  ADD CONSTRAINT "uploaded_files_processing_error_check"
  CHECK (
    "processing_error_code" IS NULL
    OR "processing_error_code" ~ '^[A-Z][A-Z0-9_]{0,79}$'
  ),
  ADD CONSTRAINT "uploaded_files_processing_claim_check"
  CHECK (
    ("processing_claim_token" IS NULL) = ("processing_lease_expires_at" IS NULL)
    AND (
      "processing_claim_token" IS NULL
      OR "status" IN ('QUARANTINED', 'VALIDATING')
    )
    AND (
      "status" <> 'VALIDATING'
      OR (
        "processing_claim_token" IS NOT NULL
        AND "processing_started_at" IS NOT NULL
        AND "processing_lease_expires_at" > "processing_started_at"
      )
    )
  ),
  ADD CONSTRAINT "uploaded_files_lifecycle_check"
  CHECK (
    (
      "status" = 'UPLOADING'
      AND "quarantine_object_key" IS NOT NULL
      AND "size_bytes" IS NULL
      AND "content_sha256" IS NULL
      AND "rejection_code" IS NULL
      AND "processing_generation" = 0
      AND "processing_attempts" = 0
      AND "processing_enqueued_at" IS NULL
      AND "processing_started_at" IS NULL
      AND "processing_claim_token" IS NULL
      AND "processing_lease_expires_at" IS NULL
      AND "processing_error_code" IS NULL
      AND "malware_scan_status" = 'PENDING'
      AND "page_count" IS NULL
      AND "ready_at" IS NULL
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
      AND "rejection_code" IS NULL
      AND "processing_started_at" IS NULL
      AND "malware_scan_status" IN ('PENDING', 'ERROR')
      AND "page_count" IS NULL
      AND "ready_at" IS NULL
    )
    OR (
      "status" = 'VALIDATING'
      AND "kind" IS NOT NULL
      AND "detected_mime" IS NOT NULL
      AND "extension" IS NOT NULL
      AND "size_bytes" > 0
      AND "content_sha256" IS NOT NULL
      AND "quarantine_object_key" IS NOT NULL
      AND "quarantined_at" IS NOT NULL
      AND "rejection_code" IS NULL
      AND "processing_generation" > 0
      AND "processing_attempts" > 0
      AND "processing_claim_token" IS NOT NULL
      AND "processing_started_at" IS NOT NULL
      AND "processing_error_code" IS NULL
      AND "malware_scan_status" IN ('PENDING', 'SCANNING', 'CLEAN', 'ERROR')
      AND "page_count" IS NULL
      AND "ready_at" IS NULL
    )
    OR (
      "status" = 'READY'
      AND "kind" IS NOT NULL
      AND "detected_mime" IS NOT NULL
      AND "extension" IS NOT NULL
      AND "size_bytes" > 0
      AND "content_sha256" IS NOT NULL
      AND "quarantine_object_key" IS NOT NULL
      AND "quarantined_at" IS NOT NULL
      AND "rejection_code" IS NULL
      AND "processing_generation" > 0
      AND "processing_attempts" > 0
      AND "processing_started_at" IS NOT NULL
      AND "processing_claim_token" IS NULL
      AND "processing_lease_expires_at" IS NULL
      AND "processing_error_code" IS NULL
      AND "malware_scan_status" = 'CLEAN'
      AND "page_count" > 0
      AND "ready_at" IS NOT NULL
    )
    OR (
      "status" = 'REJECTED'
      AND "rejection_code" IS NOT NULL
      AND "processing_claim_token" IS NULL
      AND "processing_lease_expires_at" IS NULL
      AND "page_count" IS NULL
      AND "ready_at" IS NULL
      AND (
        (
          "quarantine_object_key" IS NULL
          AND "content_sha256" IS NULL
        )
        OR (
          "kind" IS NOT NULL
          AND "detected_mime" IS NOT NULL
          AND "extension" IS NOT NULL
          AND "size_bytes" > 0
          AND "content_sha256" IS NOT NULL
          AND "quarantine_object_key" IS NOT NULL
          AND "quarantined_at" IS NOT NULL
          AND "cleanup_due_at" IS NOT NULL
        )
      )
    )
    OR (
      "status" IN ('DELETING', 'DELETE_PENDING')
      AND "processing_claim_token" IS NULL
      AND "processing_lease_expires_at" IS NULL
    )
    OR (
      "status" = 'DELETED'
      AND "quarantine_object_key" IS NULL
      AND "content_sha256" IS NULL
      AND "processing_claim_token" IS NULL
      AND "processing_lease_expires_at" IS NULL
      AND "deleted_at" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "uploaded_files_processing_claim_token_key"
  ON "uploaded_files"("processing_claim_token");
CREATE INDEX "uploaded_files_status_processing_available_at_created_at_idx"
  ON "uploaded_files"("status", "processing_available_at", "created_at");
CREATE INDEX "uploaded_files_status_processing_lease_expires_at_idx"
  ON "uploaded_files"("status", "processing_lease_expires_at");

CREATE TABLE "file_derivatives" (
  "id" UUID NOT NULL,
  "file_id" UUID NOT NULL,
  "processing_revision" INTEGER NOT NULL,
  "type" VARCHAR(32) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "page_number" INTEGER NOT NULL DEFAULT 0,
  "object_key" VARCHAR(512) NOT NULL,
  "mime_type" VARCHAR(100) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "width_pixels" INTEGER,
  "height_pixels" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "file_derivatives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_derivatives_type_check"
    CHECK ("type" IN ('ORIGINAL', 'NORMALIZED_PDF', 'PAGE_PREVIEW')),
  CONSTRAINT "file_derivatives_status_check"
    CHECK ("status" IN ('STAGING', 'AVAILABLE', 'DELETE_PENDING', 'DELETING', 'DELETED')),
  CONSTRAINT "file_derivatives_numeric_check"
    CHECK (
      "processing_revision" > 0
      AND "page_number" BETWEEN 0 AND 1000
      AND "size_bytes" BETWEEN 1 AND 536870912
      AND ("width_pixels" IS NULL OR "width_pixels" BETWEEN 1 AND 100000)
      AND ("height_pixels" IS NULL OR "height_pixels" BETWEEN 1 AND 100000)
      AND ("width_pixels" IS NULL) = ("height_pixels" IS NULL)
    ),
  CONSTRAINT "file_derivatives_digest_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "file_derivatives_lifecycle_check"
    CHECK (
      (
      (
        "status" IN ('STAGING', 'AVAILABLE', 'DELETE_PENDING', 'DELETING')
        AND "deleted_at" IS NULL
      )
      OR (
        "status" = 'DELETED'
        AND "deleted_at" IS NOT NULL
      )
      )
      AND (
      (
        "type" = 'ORIGINAL'
        AND "page_number" = 0
        AND "mime_type" IN ('application/pdf', 'image/jpeg', 'image/png')
        AND "width_pixels" IS NULL
      )
      OR
      (
        "type" = 'NORMALIZED_PDF'
        AND "page_number" = 0
        AND "mime_type" = 'application/pdf'
        AND "width_pixels" IS NULL
      )
      OR (
        "type" = 'PAGE_PREVIEW'
        AND "page_number" > 0
        AND "mime_type" = 'image/webp'
        AND "width_pixels" IS NOT NULL
      )
      )
    ),
  CONSTRAINT "file_derivatives_object_key_check"
    CHECK (
      "object_key" !~ '(^/|(^|/)\.\.(/|$)|//)'
      AND "object_key" ~ '^[A-Za-z0-9._/-]{1,512}$'
      AND split_part("object_key", '/', 4) = "file_id"::text
      AND (
        (
          "type" = 'ORIGINAL'
          AND "object_key" ~ '^quarantine/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{16,128}$'
        )
        OR
        (
          "type" = 'NORMALIZED_PDF'
          AND split_part("object_key", '/', 5) = ('r' || "processing_revision"::text)
          AND "object_key" ~ '^normalized/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/r[1-9][0-9]*/g[1-9][0-9]*/document\.pdf$'
        )
        OR (
          "type" = 'PAGE_PREVIEW'
          AND split_part("object_key", '/', 5) = ('r' || "processing_revision"::text)
          AND "object_key" ~ '^previews/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/r[1-9][0-9]*/g[1-9][0-9]*/page-[1-9][0-9]*\.webp$'
          AND split_part("object_key", '/', 7) = ('page-' || "page_number"::text || '.webp')
        )
      )
    )
);

CREATE UNIQUE INDEX "file_derivatives_object_key_key"
  ON "file_derivatives"("object_key");
CREATE UNIQUE INDEX "file_derivatives_id_file_id_processing_revision_page_number_key"
  ON "file_derivatives"("id", "file_id", "processing_revision", "page_number");
CREATE UNIQUE INDEX "file_derivatives_file_id_type_processing_revision_page_number_key"
  ON "file_derivatives"("file_id", "type", "processing_revision", "page_number");
CREATE INDEX "file_derivatives_file_id_processing_revision_status_idx"
  ON "file_derivatives"("file_id", "processing_revision", "status");
CREATE INDEX "file_derivatives_status_created_at_idx"
  ON "file_derivatives"("status", "created_at");

CREATE TABLE "file_pages" (
  "id" UUID NOT NULL,
  "file_id" UUID NOT NULL,
  "processing_revision" INTEGER NOT NULL,
  "page_number" INTEGER NOT NULL,
  "width_pixels" INTEGER NOT NULL,
  "height_pixels" INTEGER NOT NULL,
  "preview_derivative_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_pages_numeric_check"
    CHECK (
      "processing_revision" > 0
      AND "page_number" BETWEEN 1 AND 1000
      AND "width_pixels" BETWEEN 1 AND 100000
      AND "height_pixels" BETWEEN 1 AND 100000
    )
);

CREATE UNIQUE INDEX "file_pages_file_id_processing_revision_page_number_key"
  ON "file_pages"("file_id", "processing_revision", "page_number");
CREATE UNIQUE INDEX "file_pages_preview_derivative_id_file_id_processing_revision_page_number_key"
  ON "file_pages"(
    "preview_derivative_id",
    "file_id",
    "processing_revision",
    "page_number"
  );
CREATE INDEX "file_pages_file_id_processing_revision_idx"
  ON "file_pages"("file_id", "processing_revision");

ALTER TABLE "file_derivatives"
  ADD CONSTRAINT "file_derivatives_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "uploaded_files"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "file_pages"
  ADD CONSTRAINT "file_pages_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "uploaded_files"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "file_pages"
  ADD CONSTRAINT "file_pages_preview_derivative_fkey"
  FOREIGN KEY (
    "preview_derivative_id",
    "file_id",
    "processing_revision",
    "page_number"
  )
  REFERENCES "file_derivatives"(
    "id",
    "file_id",
    "processing_revision",
    "page_number"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- READY's cross-table completeness (one original, one normalized PDF and one
-- AVAILABLE preview per page) is finalized in one serializable transaction.
-- PostgreSQL CHECK constraints cannot safely express that cross-table rule.

-- Materialized and not-yet-published Phase 3 events contain the old six-field
-- public file snapshot. Supply safe defaults before the stricter Phase 5 event
-- parser is deployed. Existing Phase 5 keys, if present during a rolling
-- deployment, win because the stored object is merged on the right.
UPDATE "session_events"
SET "payload" = jsonb_set(
  "payload",
  '{file}',
  jsonb_build_object(
    'processingRevision', 1,
    'pageCount', NULL,
    'rejectionCode',
      CASE WHEN "type" = 'file.rejected' THEN 'UPLOAD_FAILED' ELSE NULL END
  ) || ("payload" -> 'file'),
  true
)
WHERE "type" IN ('upload.started', 'file.uploaded', 'file.rejected')
  AND jsonb_typeof("payload" -> 'file') = 'object';

UPDATE "outbox_events"
SET "payload" = jsonb_set(
  "payload",
  '{file}',
  jsonb_build_object(
    'processingRevision', 1,
    'pageCount', NULL,
    'rejectionCode',
      CASE WHEN "type" = 'file.rejected' THEN 'UPLOAD_FAILED' ELSE NULL END
  ) || ("payload" -> 'file'),
  true
)
WHERE "status" IN ('PENDING', 'PROCESSING')
  AND "type" IN ('upload.started', 'file.uploaded', 'file.rejected')
  AND jsonb_typeof("payload" -> 'file') = 'object';

-- Preserve still-live Phase 3 idempotency rows while allowing the expanded
-- Phase 5 public snapshot. Both forms are exact allowlists with no private
-- object keys, hashes, names, parser errors or scanner details.
ALTER TABLE "idempotency_records"
  DROP CONSTRAINT "idempotency_records_file_response_sanitized_check";

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_file_response_sanitized_check"
  CHECK (
    "action" NOT LIKE 'files.upload:%'
    OR (
      jsonb_typeof("response_body") = 'object'
      AND ("response_body" - 'file') = '{}'::jsonb
      AND jsonb_typeof("response_body" -> 'file') = 'object'
      AND (
        (
          ("response_body" -> 'file') ?& ARRAY[
            'id', 'ordinal', 'status', 'kind', 'sizeBytes', 'createdAt'
          ]::text[]
          AND (("response_body" -> 'file') - ARRAY[
            'id', 'ordinal', 'status', 'kind', 'sizeBytes', 'createdAt'
          ]::text[]) = '{}'::jsonb
        )
        OR (
          ("response_body" -> 'file') ?& ARRAY[
            'id',
            'ordinal',
            'status',
            'kind',
            'sizeBytes',
            'processingRevision',
            'pageCount',
            'rejectionCode',
            'createdAt'
          ]::text[]
          AND (("response_body" -> 'file') - ARRAY[
            'id',
            'ordinal',
            'status',
            'kind',
            'sizeBytes',
            'processingRevision',
            'pageCount',
            'rejectionCode',
            'createdAt'
          ]::text[]) = '{}'::jsonb
        )
      )
    )
  );
