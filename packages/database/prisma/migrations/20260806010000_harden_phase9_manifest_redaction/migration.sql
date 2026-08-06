-- A redaction timestamp is meaningful only when the sensitive manifest is
-- replaced in the same update. The original Phase 9 trigger allowed the
-- timestamp to be set by itself, after which cleanup skipped the still-raw
-- manifest and the finality rule prevented a later repair.

-- New jobs must always start with their operational manifest. A caller cannot
-- bypass the update-time redaction checks by inserting a marker (or a
-- redaction timestamp) up front.
CREATE OR REPLACE FUNCTION "print_jobs_reject_pre_redacted_insert"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."manifest_redacted_at" IS NOT NULL
    OR NEW."job_manifest" @> '{"redacted":true}'::jsonb
  THEN
    RAISE EXCEPTION 'a print job must be inserted with its unredacted manifest'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_jobs_no_pre_redacted_insert"
  BEFORE INSERT ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION "print_jobs_reject_pre_redacted_insert"();

-- Refuse to guess when historical data has already lost the raw manifest, has
-- an ambiguous marker, or was marked while still operational. A raw terminal
-- manifest with a documents array is recoverable: its exact document count is
-- still present and is repaired below. Raising restrict_violation leaves the
-- migration unapplied and all bytes untouched for operator investigation.
DO $$
DECLARE
  candidate RECORD;
  document_count NUMERIC;
BEGIN
  FOR candidate IN
    SELECT "id", "status", "job_manifest", "manifest_redacted_at"
      FROM "print_jobs"
      WHERE "manifest_redacted_at" IS NOT NULL
         OR "job_manifest" @> '{"redacted":true}'::jsonb
  LOOP
    IF candidate."manifest_redacted_at" IS NULL THEN
      RAISE EXCEPTION 'print job % has a pre-redacted manifest without a timestamp', candidate."id"
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF candidate."status" NOT IN ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED') THEN
      RAISE EXCEPTION 'print job % was redacted before settlement', candidate."id"
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF jsonb_typeof(candidate."job_manifest") = 'object'
      AND (SELECT count(*) FROM jsonb_object_keys(candidate."job_manifest")) = 2
      AND jsonb_typeof(candidate."job_manifest"->'redacted') = 'boolean'
      AND candidate."job_manifest"->'redacted' = 'true'::jsonb
      AND jsonb_typeof(candidate."job_manifest"->'documentCount') = 'number'
    THEN
      document_count := (candidate."job_manifest"->>'documentCount')::numeric;
      IF document_count < 0 OR trunc(document_count) <> document_count THEN
        RAISE EXCEPTION 'print job % has an invalid redaction document count', candidate."id"
          USING ERRCODE = 'restrict_violation';
      END IF;

      CONTINUE;
    END IF;

    IF jsonb_typeof(candidate."job_manifest") IS DISTINCT FROM 'object'
      OR candidate."job_manifest" ? 'redacted'
      OR jsonb_typeof(candidate."job_manifest"->'documents') IS DISTINCT FROM 'array'
    THEN
      RAISE EXCEPTION 'print job % has no recoverable document count', candidate."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
END;
$$;

-- This first form admits one narrowly-scoped repair of the vulnerable Phase 9
-- state: a settled row whose timestamp is already set may replace its raw
-- manifest with the exact marker while preserving that timestamp. It is
-- replaced by the final function immediately after the backfill.
CREATE OR REPLACE FUNCTION "print_jobs_assert_immutable_snapshot"() RETURNS TRIGGER AS $$
DECLARE
  redacting BOOLEAN :=
    OLD."manifest_redacted_at" IS NULL AND NEW."manifest_redacted_at" IS NOT NULL;
  repairing BOOLEAN :=
    OLD."manifest_redacted_at" IS NOT NULL
    AND NEW."manifest_redacted_at" IS NOT DISTINCT FROM OLD."manifest_redacted_at"
    AND jsonb_typeof(OLD."job_manifest"->'documents') = 'array';
  manifest_changed BOOLEAN :=
    NEW."job_manifest" IS DISTINCT FROM OLD."job_manifest";
  document_count NUMERIC;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
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

  IF OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED')
    AND (to_jsonb(NEW) - 'job_manifest' - 'manifest_redacted_at' - 'updated_at')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'job_manifest' - 'manifest_redacted_at' - 'updated_at')
  THEN
    RAISE EXCEPTION 'settled print job evidence is final'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (redacting OR repairing) AND NOT manifest_changed THEN
    RAISE EXCEPTION 'a print manifest redaction timestamp requires a marker replacement'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF manifest_changed THEN
    IF NOT redacting AND NOT repairing THEN
      RAISE EXCEPTION 'a print job snapshot cannot be rewritten'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."status" NOT IN ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED') THEN
      RAISE EXCEPTION 'an unsettled print job manifest cannot be redacted'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF jsonb_typeof(OLD."job_manifest"->'documents') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW."job_manifest") IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW."job_manifest")) <> 2
      OR jsonb_typeof(NEW."job_manifest"->'redacted') IS DISTINCT FROM 'boolean'
      OR NEW."job_manifest"->'redacted' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(NEW."job_manifest"->'documentCount') IS DISTINCT FROM 'number'
    THEN
      RAISE EXCEPTION 'a redacted print manifest must be the redaction marker'
        USING ERRCODE = 'restrict_violation';
    END IF;

    document_count := (NEW."job_manifest"->>'documentCount')::numeric;
    IF document_count < 0
      OR trunc(document_count) <> document_count
      OR document_count <> jsonb_array_length(OLD."job_manifest"->'documents')
    THEN
      RAISE EXCEPTION 'a redacted print manifest document count must match the manifest'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF OLD."manifest_redacted_at" IS NOT NULL
    AND NOT repairing
    AND NEW."manifest_redacted_at" IS DISTINCT FROM OLD."manifest_redacted_at"
  THEN
    RAISE EXCEPTION 'a redacted print manifest is final'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

UPDATE "print_jobs"
  SET "job_manifest" = jsonb_build_object(
    'redacted', true,
    'documentCount', jsonb_array_length("job_manifest"->'documents')
  )
  WHERE "manifest_redacted_at" IS NOT NULL
    AND "job_manifest" ? 'documents';

-- Final form: no repair exception remains. Active job progress may still move
-- forward under the status trigger, but once a job is terminal every outcome
-- and progress field is frozen. Only the exact one-time manifest redaction and
-- Prisma's accompanying updated_at write are permitted.
CREATE OR REPLACE FUNCTION "print_jobs_assert_immutable_snapshot"() RETURNS TRIGGER AS $$
DECLARE
  redacting BOOLEAN :=
    OLD."manifest_redacted_at" IS NULL AND NEW."manifest_redacted_at" IS NOT NULL;
  manifest_changed BOOLEAN :=
    NEW."job_manifest" IS DISTINCT FROM OLD."job_manifest";
  document_count NUMERIC;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
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

  IF OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED')
    AND (to_jsonb(NEW) - 'job_manifest' - 'manifest_redacted_at' - 'updated_at')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'job_manifest' - 'manifest_redacted_at' - 'updated_at')
  THEN
    RAISE EXCEPTION 'settled print job evidence is final'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF redacting AND NOT manifest_changed THEN
    RAISE EXCEPTION 'a print manifest redaction timestamp requires a marker replacement'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF manifest_changed THEN
    IF NOT redacting THEN
      RAISE EXCEPTION 'a print job snapshot cannot be rewritten'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."status" NOT IN ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED') THEN
      RAISE EXCEPTION 'an unsettled print job manifest cannot be redacted'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF jsonb_typeof(OLD."job_manifest"->'documents') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW."job_manifest") IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW."job_manifest")) <> 2
      OR jsonb_typeof(NEW."job_manifest"->'redacted') IS DISTINCT FROM 'boolean'
      OR NEW."job_manifest"->'redacted' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(NEW."job_manifest"->'documentCount') IS DISTINCT FROM 'number'
    THEN
      RAISE EXCEPTION 'a redacted print manifest must be the redaction marker'
        USING ERRCODE = 'restrict_violation';
    END IF;

    document_count := (NEW."job_manifest"->>'documentCount')::numeric;
    IF document_count < 0
      OR trunc(document_count) <> document_count
      OR document_count <> jsonb_array_length(OLD."job_manifest"->'documents')
    THEN
      RAISE EXCEPTION 'a redacted print manifest document count must match the manifest'
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
