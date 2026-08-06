-- Print-setting selections retain the exact paper/range choices that were
-- priced, but they must not retain a raw SHA-256 fingerprint of each document
-- after Phase 9 cleanup. Allow one narrowly-defined amendment to the otherwise
-- append-only snapshot: remove only `contentSha256` from each selection and
-- record when that happened.

ALTER TABLE "print_setting_revisions"
  ADD COLUMN "selections_redacted_at" TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION "print_setting_revisions_reject_update"() RETURNS TRIGGER AS $$
DECLARE
  redacting BOOLEAN :=
    OLD."selections_redacted_at" IS NULL AND NEW."selections_redacted_at" IS NOT NULL;
  expected_selections JSONB;
  parent_state VARCHAR(40);
BEGIN
  -- A completed redaction is final, and every ordinary update remains
  -- forbidden. Comparing the complete row minus the two permitted fields also
  -- keeps future columns immutable by default.
  IF OLD."selections_redacted_at" IS NOT NULL OR NOT redacting THEN
    RAISE EXCEPTION 'print_setting_revisions rows are append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (to_jsonb(NEW) - 'selections' - 'selections_redacted_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'selections' - 'selections_redacted_at')
  THEN
    RAISE EXCEPTION 'a print settings snapshot cannot be rewritten during redaction'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "state" INTO parent_state
    FROM "print_sessions" WHERE "id" = OLD."session_id";
  IF parent_state NOT IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED') THEN
    RAISE EXCEPTION 'an active print settings snapshot cannot be redacted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT COALESCE(jsonb_agg("entry" - 'contentSha256' ORDER BY "ordinal"), '[]'::jsonb)
    INTO expected_selections
    FROM jsonb_array_elements(OLD."selections") WITH ORDINALITY AS items("entry", "ordinal");

  IF NEW."selections" IS DISTINCT FROM expected_selections THEN
    RAISE EXCEPTION 'settings redaction may only remove document content digests'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A new revision is operational input and therefore must contain the raw
-- digest for every selection. Retention is the only path that may insert the
-- redaction timestamp or remove those digests later.
CREATE OR REPLACE FUNCTION "print_setting_revisions_reject_pre_redacted_insert"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."selections_redacted_at" IS NOT NULL
    OR jsonb_typeof(NEW."selections") IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(NEW."selections") AS item("entry")
        WHERE jsonb_typeof(item."entry") IS DISTINCT FROM 'object'
          OR jsonb_typeof(item."entry"->'contentSha256') IS DISTINCT FROM 'string'
          OR item."entry"->>'contentSha256' !~ '^[0-9a-f]{64}$'
    )
  THEN
    RAISE EXCEPTION 'a print settings revision must be inserted with document digests'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_setting_revisions_no_pre_redacted_insert"
  BEFORE INSERT ON "print_setting_revisions"
  FOR EACH ROW EXECUTE FUNCTION "print_setting_revisions_reject_pre_redacted_insert"();

-- A terminal session may already have completed cleanup, dead-lettered after
-- metadata scrubbing, or be waiting at a checkpoint that will not replay this
-- newly-added step. Redact every existing terminal revision during the schema
-- upgrade so none of those paths retains a document fingerprint indefinitely.
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
