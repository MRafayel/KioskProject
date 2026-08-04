-- Phase 9: expiration and idempotent cleanup.
--
-- A finished session's documents are removed by a durable, resumable workflow
-- rather than by whoever happened to end the session. This migration adds the
-- schedule the workflow reads, the run record it checkpoints against, and the
-- database-level guarantees that a session marked "documents deleted" really
-- has none left and can never receive another one.

-- ---------------------------------------------------------------------------
-- The schedule, on the session itself.
-- ---------------------------------------------------------------------------

ALTER TABLE "print_sessions"
  ADD COLUMN "cleanup_status" VARCHAR(24) NOT NULL DEFAULT 'NOT_DUE',
  ADD COLUMN "cleanup_due_at" TIMESTAMPTZ,
  ADD COLUMN "files_deleted_at" TIMESTAMPTZ;

ALTER TABLE "print_sessions"
  ADD CONSTRAINT "print_sessions_cleanup_status_check"
    CHECK ("cleanup_status" IN ('NOT_DUE', 'PENDING', 'IN_PROGRESS', 'DONE', 'DEAD_LETTER')),
  -- A schedule without a due time could never run; a due time without a
  -- schedule would make an untouched session look overdue.
  ADD CONSTRAINT "print_sessions_cleanup_schedule_check"
    CHECK (("cleanup_status" = 'NOT_DUE') = ("cleanup_due_at" IS NULL)),
  -- Documents are only ever declared gone by a run that finished.
  ADD CONSTRAINT "print_sessions_files_deleted_check"
    CHECK ("files_deleted_at" IS NULL OR "cleanup_status" = 'DONE');

CREATE INDEX "print_sessions_cleanup_due_idx"
  ON "print_sessions" ("cleanup_status", "cleanup_due_at");

-- Everything already in a terminal state when this migration is applied is
-- overdue by definition: its customer left before retention existed.
UPDATE "print_sessions"
  SET "cleanup_status" = 'PENDING', "cleanup_due_at" = now()
  WHERE "state" IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED');

-- ---------------------------------------------------------------------------
-- The run record: one per session, leased, checkpointed and retryable.
-- ---------------------------------------------------------------------------

CREATE TABLE "cleanup_runs" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "reason" VARCHAR(40) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "checkpoint" VARCHAR(32) NOT NULL DEFAULT 'SCHEDULED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "last_error_code" VARCHAR(80),
  "objects_deleted" INTEGER NOT NULL DEFAULT 0,
  "orphan_objects_deleted" INTEGER NOT NULL DEFAULT 0,
  "multipart_uploads_aborted" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "dead_lettered_at" TIMESTAMPTZ,

  CONSTRAINT "cleanup_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cleanup_runs_status_check"
    CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'DONE', 'DEAD_LETTER')),
  CONSTRAINT "cleanup_runs_checkpoint_check"
    CHECK ("checkpoint" IN (
      'SCHEDULED', 'ACCESS_REVOKED', 'ARTIFACTS_DELETED',
      'STORAGE_RECONCILED', 'METADATA_SCRUBBED', 'COMPLETED'
    )),
  CONSTRAINT "cleanup_runs_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "cleanup_runs_counts_check"
    CHECK ("objects_deleted" >= 0 AND "orphan_objects_deleted" >= 0
      AND "multipart_uploads_aborted" >= 0),
  -- A half-written lease is a run two workers could both believe they hold.
  CONSTRAINT "cleanup_runs_lease_check"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "cleanup_runs_done_check"
    CHECK (("status" = 'DONE') = ("completed_at" IS NOT NULL)),
  CONSTRAINT "cleanup_runs_dead_letter_check"
    CHECK (("status" = 'DEAD_LETTER') = ("dead_lettered_at" IS NOT NULL)),
  -- A finished run is not holding anything and has nothing left to do.
  CONSTRAINT "cleanup_runs_settled_lease_check"
    CHECK ("status" <> 'DONE' OR ("lease_token" IS NULL AND "checkpoint" = 'COMPLETED'))
);

-- One run per session. A second scheduler that raced the first inserts nothing
-- rather than creating a rival lease over the same documents.
CREATE UNIQUE INDEX "cleanup_runs_session_id_key" ON "cleanup_runs" ("session_id");
CREATE UNIQUE INDEX "cleanup_runs_lease_token_key" ON "cleanup_runs" ("lease_token");
CREATE INDEX "cleanup_runs_due_idx" ON "cleanup_runs" ("status", "available_at");
CREATE INDEX "cleanup_runs_lease_idx" ON "cleanup_runs" ("status", "lease_expires_at");

ALTER TABLE "cleanup_runs"
  ADD CONSTRAINT "cleanup_runs_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A run's progress only moves forwards, and a finished run is final. Without
-- this, a worker holding an expired lease could write an earlier checkpoint on
-- top of a newer one and send the run round the loop again.
CREATE OR REPLACE FUNCTION "cleanup_runs_assert_progress"() RETURNS TRIGGER AS $$
DECLARE
  checkpoints CONSTANT TEXT[] := ARRAY[
    'SCHEDULED', 'ACCESS_REVOKED', 'ARTIFACTS_DELETED',
    'STORAGE_RECONCILED', 'METADATA_SCRUBBED', 'COMPLETED'
  ];
BEGIN
  IF NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'a cleanup run cannot be reassigned'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" = 'DONE' THEN
    RAISE EXCEPTION 'a finished cleanup run is final'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF array_position(checkpoints, NEW."checkpoint")
     < array_position(checkpoints, OLD."checkpoint")
  THEN
    RAISE EXCEPTION 'a cleanup run cannot move backwards'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'cleanup attempts cannot be rewound'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cleanup_runs_progress_is_monotonic"
  BEFORE UPDATE ON "cleanup_runs"
  FOR EACH ROW EXECUTE FUNCTION "cleanup_runs_assert_progress"();

-- ---------------------------------------------------------------------------
-- What "deleted" has to mean.
-- ---------------------------------------------------------------------------

-- Setting files_deleted_at is the claim that no copy of this session's
-- documents remains. Application code checks that before it writes; this is
-- what makes it true for every writer, including a future admin tool or a
-- mistaken query. The artifact ledger is deliberately consulted rather than
-- trusted to have been deleted first: a row that still names an object key is
-- the only record of a document that still exists.
CREATE OR REPLACE FUNCTION "print_sessions_assert_documents_removed"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."files_deleted_at" IS NULL THEN
    IF OLD."files_deleted_at" IS NOT NULL THEN
      RAISE EXCEPTION 'a cleaned session cannot be reopened'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."files_deleted_at" IS NOT NULL THEN
    IF NEW."files_deleted_at" IS DISTINCT FROM OLD."files_deleted_at" THEN
      RAISE EXCEPTION 'a cleaned session cannot be cleaned again'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."state" NOT IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED') THEN
    RAISE EXCEPTION 'only a finished session can have its documents deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "uploaded_files"
      WHERE "session_id" = NEW."id"
        AND ("quarantine_object_key" IS NOT NULL
          OR "status" IN ('UPLOADING', 'QUARANTINED', 'VALIDATING', 'READY',
                          'DELETE_PENDING', 'DELETING'))
  ) THEN
    RAISE EXCEPTION 'a session still holding documents cannot be marked deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "file_derivatives" "d"
      JOIN "uploaded_files" "f" ON "f"."id" = "d"."file_id"
      WHERE "f"."session_id" = NEW."id"
  ) OR EXISTS (
    SELECT 1 FROM "file_pages" "p"
      JOIN "uploaded_files" "f" ON "f"."id" = "p"."file_id"
      WHERE "f"."session_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'a session still holding derivatives cannot be marked deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_sessions_documents_are_removed"
  BEFORE UPDATE ON "print_sessions"
  FOR EACH ROW EXECUTE FUNCTION "print_sessions_assert_documents_removed"();

-- ---------------------------------------------------------------------------
-- Redacting a print job's document manifest.
-- ---------------------------------------------------------------------------

-- A print manifest names each document by content digest. That digest is a
-- fingerprint: it confirms possession of a particular file long after the file
-- itself is gone, so it belongs with the documents rather than with the money.
-- What stays is the hash over the manifest, the counts, the confidence and the
-- outcome — enough to prove what was paid for and what the device reported,
-- and not enough to identify what was printed.
ALTER TABLE "print_jobs" ADD COLUMN "manifest_redacted_at" TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION "print_jobs_assert_immutable_snapshot"() RETURNS TRIGGER AS $$
DECLARE
  redacting BOOLEAN :=
    OLD."manifest_redacted_at" IS NULL AND NEW."manifest_redacted_at" IS NOT NULL;
BEGIN
  IF NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."kiosk_id" IS DISTINCT FROM OLD."kiosk_id"
    OR NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
    OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
    OR NEW."settings_revision" IS DISTINCT FROM OLD."settings_revision"
    OR NEW."settings_manifest_hash" IS DISTINCT FROM OLD."settings_manifest_hash"
    OR NEW."job_manifest_hash" IS DISTINCT FROM OLD."job_manifest_hash"
    OR NEW."simulated_outcome" IS DISTINCT FROM OLD."simulated_outcome"
    OR NEW."copies" IS DISTINCT FROM OLD."copies"
    OR NEW."printed_sides" IS DISTINCT FROM OLD."printed_sides"
    OR NEW."physical_sheets" IS DISTINCT FROM OLD."physical_sheets"
    OR NEW."deadline_at" IS DISTINCT FROM OLD."deadline_at"
    OR NEW."created_by_actor_type" IS DISTINCT FROM OLD."created_by_actor_type"
    OR NEW."created_by_actor_id" IS DISTINCT FROM OLD."created_by_actor_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'a print job snapshot cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Redaction happens once, only on a settled job, and only into the marker.
  -- Anything else touching the manifest is still a rewrite.
  IF NEW."job_manifest"::text IS DISTINCT FROM OLD."job_manifest"::text THEN
    IF NOT redacting THEN
      RAISE EXCEPTION 'a print job snapshot cannot be rewritten'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."status" NOT IN ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED') THEN
      RAISE EXCEPTION 'an unsettled print job manifest cannot be redacted'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF jsonb_typeof(NEW."job_manifest") <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW."job_manifest")) <> 2
      OR NEW."job_manifest"->>'redacted' IS DISTINCT FROM 'true'
      OR jsonb_typeof(NEW."job_manifest"->'documentCount') <> 'number'
    THEN
      RAISE EXCEPTION 'a redacted print manifest must be the redaction marker'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF OLD."manifest_redacted_at" IS NOT NULL
    AND NEW."manifest_redacted_at" IS DISTINCT FROM OLD."manifest_redacted_at"
  THEN
    RAISE EXCEPTION 'a redacted print manifest is final'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Cleanup revokes every credential that could reach the session, so an upload
-- after it should be impossible. This closes the gap between the two: a
-- request that somehow arrives with a live cookie cannot recreate a document
-- under a prefix nothing will ever sweep again.
CREATE OR REPLACE FUNCTION "uploaded_files_reject_cleaned_session"() RETURNS TRIGGER AS $$
DECLARE
  cleaned TIMESTAMPTZ;
BEGIN
  SELECT "files_deleted_at" INTO cleaned
    FROM "print_sessions" WHERE "id" = NEW."session_id";

  IF cleaned IS NOT NULL THEN
    RAISE EXCEPTION 'a cleaned session cannot accept another document'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "uploaded_files_refuse_cleaned_session"
  BEFORE INSERT ON "uploaded_files"
  FOR EACH ROW EXECUTE FUNCTION "uploaded_files_reject_cleaned_session"();
