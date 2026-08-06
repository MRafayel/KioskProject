-- Phase 9 rolling-deployment compatibility.
--
-- Older workers do not know that retained settings now need their document
-- digests removed, and older API instances schedule file cleanup immediately.
-- Keep the invariants true at the database boundary until every application
-- instance has moved to the audited implementation.

-- Close the deployment window between the settings migration and this
-- compatibility migration. The existing append-only trigger admits exactly
-- this digest-removal transition and rejects every other rewrite.
UPDATE "print_setting_revisions" AS revision
  SET "selections" = (
        SELECT COALESCE(jsonb_agg("entry" - 'contentSha256' ORDER BY "ordinal"), '[]'::jsonb)
          FROM jsonb_array_elements(revision."selections")
            WITH ORDINALITY AS items("entry", "ordinal")
      ),
      "selections_redacted_at" = CURRENT_TIMESTAMP
  FROM "print_sessions" AS session
  WHERE session."id" = revision."session_id"
    AND session."state" IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED')
    AND revision."selections_redacted_at" IS NULL;

-- When an old worker records that metadata scrubbing was reached (or skips
-- directly to its DONE update), complete the new settings-redaction step in
-- the same transaction. The print-setting trigger remains the authority that
-- proves the transformation is exact and the parent is terminal.
CREATE OR REPLACE FUNCTION "cleanup_runs_redact_terminal_settings"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."checkpoint" IN ('METADATA_SCRUBBED', 'COMPLETED') OR NEW."status" = 'DONE' THEN
    UPDATE "print_setting_revisions" AS revision
      SET "selections" = (
            SELECT COALESCE(
              jsonb_agg("entry" - 'contentSha256' ORDER BY "ordinal"),
              '[]'::jsonb
            )
              FROM jsonb_array_elements(revision."selections")
                WITH ORDINALITY AS items("entry", "ordinal")
          ),
          "selections_redacted_at" = CURRENT_TIMESTAMP
      FROM "print_sessions" AS session
      WHERE session."id" = revision."session_id"
        AND revision."session_id" = NEW."session_id"
        AND session."state" IN (
          'COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED'
        )
        AND revision."selections_redacted_at" IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cleanup_runs_redact_settings_at_metadata"
  AFTER INSERT OR UPDATE OF "checkpoint", "status" ON "cleanup_runs"
  FOR EACH ROW EXECUTE FUNCTION "cleanup_runs_redact_terminal_settings"();

-- Close the equivalent deployment window after the one-time file deadline
-- backfill. This statement is intentionally repeated because an older API may
-- have written another early date after that migration committed.
UPDATE "uploaded_files" AS file
  SET "cleanup_due_at" = session."cleanup_due_at",
      "updated_at" = CURRENT_TIMESTAMP
  FROM "print_sessions" AS session
  WHERE session."id" = file."session_id"
    AND session."state" IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED')
    AND session."cleanup_due_at" IS NOT NULL
    AND file."status" IN ('DELETE_PENDING', 'DELETING')
    AND (
      file."cleanup_due_at" IS NULL
      OR file."cleanup_due_at" < session."cleanup_due_at"
    );

-- Clamp every later file insert/update from an older API or janitor. If the
-- file is written first while the parent has no schedule yet, the parent
-- trigger below closes the other ordering of the race.
CREATE OR REPLACE FUNCTION "uploaded_files_clamp_terminal_cleanup_due"() RETURNS TRIGGER AS $$
DECLARE
  parent_state VARCHAR(40);
  parent_due_at TIMESTAMPTZ;
BEGIN
  IF NEW."status" NOT IN ('DELETE_PENDING', 'DELETING') THEN
    RETURN NEW;
  END IF;

  SELECT "state", "cleanup_due_at"
    INTO parent_state, parent_due_at
    FROM "print_sessions"
    WHERE "id" = NEW."session_id";

  IF parent_state IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED')
    AND parent_due_at IS NOT NULL
    AND (NEW."cleanup_due_at" IS NULL OR NEW."cleanup_due_at" < parent_due_at)
  THEN
    NEW."cleanup_due_at" := parent_due_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "uploaded_files_clamp_terminal_cleanup_due"
  BEFORE INSERT OR UPDATE OF "session_id", "status", "cleanup_due_at" ON "uploaded_files"
  FOR EACH ROW EXECUTE FUNCTION "uploaded_files_clamp_terminal_cleanup_due"();

-- Clamp rows that were written before the terminal schedule in the same old
-- request, and rows whose parent grace date is later extended.
CREATE OR REPLACE FUNCTION "print_sessions_clamp_file_cleanup_due"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."state" IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED')
    AND NEW."cleanup_due_at" IS NOT NULL
  THEN
    UPDATE "uploaded_files"
      SET "cleanup_due_at" = NEW."cleanup_due_at",
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "session_id" = NEW."id"
        AND "status" IN ('DELETE_PENDING', 'DELETING')
        AND (
          "cleanup_due_at" IS NULL
          OR "cleanup_due_at" < NEW."cleanup_due_at"
        );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_sessions_clamp_file_cleanup_due"
  AFTER INSERT OR UPDATE OF "state", "cleanup_due_at" ON "print_sessions"
  FOR EACH ROW EXECUTE FUNCTION "print_sessions_clamp_file_cleanup_due"();
