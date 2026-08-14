-- Copies, sides and orientation describe a document, not a job.
--
-- A session carries several documents, and a customer printing a contract and
-- a photo wants two double-sided copies of one and a single landscape copy of
-- the other. A job-wide column could only ever be right for one of them, so
-- these three move onto each entry of the `selections` snapshot, which is
-- already the per-document record.
--
-- Nothing is lost: every existing revision is rewritten so each of its
-- documents carries the values the whole job used to have, which is exactly
-- what that revision meant. The priced aggregates -- selected_pages,
-- printed_sides, physical_sheets -- are untouched, so no historical quote,
-- payment or print job changes value.

-- The rewrite and the column drops run only while the columns are still there,
-- so re-running this migration over a database that already has the new shape
-- is a no-op rather than an error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
      WHERE table_name = 'print_setting_revisions' AND column_name = 'copies'
  ) THEN
    -- The snapshot is append-only, enforced by a trigger. The backfill is a
    -- migration rather than an amendment, so the trigger is stood down for the
    -- rewrite and restored immediately afterwards.
    ALTER TABLE "print_setting_revisions" DISABLE TRIGGER "print_setting_revisions_no_update";

    UPDATE "print_setting_revisions" AS r
    SET "selections" = COALESCE(
      (
        SELECT jsonb_agg(
          item."entry" || jsonb_build_object(
            'copies', r."copies",
            'duplex', r."duplex",
            'orientation', r."orientation",
            -- What this document contributed on its own. Every document was
            -- printed with the same job-wide copies before this migration, so
            -- its own totals are its per-copy counts times that number.
            'printedSides', COALESCE((item."entry"->>'selectedPages')::INTEGER, 0) * r."copies",
            'physicalSheets',
              CASE
                WHEN r."duplex" = 'SIMPLEX'
                  THEN COALESCE((item."entry"->>'selectedPages')::INTEGER, 0) * r."copies"
                ELSE CEIL(COALESCE((item."entry"->>'selectedPages')::NUMERIC, 0) / 2)::INTEGER
                     * r."copies"
              END
          )
          ORDER BY item."ordinal"
        )
        FROM jsonb_array_elements(r."selections") WITH ORDINALITY AS item("entry", "ordinal")
      ),
      r."selections"
    );

    ALTER TABLE "print_setting_revisions" ENABLE TRIGGER "print_setting_revisions_no_update";

    ALTER TABLE "print_setting_revisions"
      DROP CONSTRAINT IF EXISTS "print_setting_revisions_duplex_check",
      DROP CONSTRAINT IF EXISTS "print_setting_revisions_orientation_check";

    ALTER TABLE "print_setting_revisions"
      DROP COLUMN "copies",
      DROP COLUMN "duplex",
      DROP COLUMN "orientation";
  END IF;
END $$;

-- The aggregate invariants stay; they simply no longer mention a job-wide copy
-- count, because there is not one.
ALTER TABLE "print_setting_revisions"
  DROP CONSTRAINT IF EXISTS "print_setting_revisions_counts_check";

ALTER TABLE "print_setting_revisions"
  ADD CONSTRAINT "print_setting_revisions_counts_check" CHECK (
    "selected_pages" > 0
    AND "printed_sides" > 0
    AND "physical_sheets" > 0
    AND "physical_sheets" <= "printed_sides"
    AND "capability_version" > 0
  );

-- Every document in a revision must describe itself completely. This is the
-- same guarantee the dropped column checks gave, applied where the values now
-- live, so a client cannot write a revision the printer could not carry out.
-- It is a trigger rather than a CHECK because the test has to walk the JSON
-- array, and a CHECK constraint may not contain a subquery.
CREATE OR REPLACE FUNCTION "print_setting_revisions_reject_invalid_document_settings"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW."selections") AS item("entry")
      WHERE jsonb_typeof(item."entry"->'copies') IS DISTINCT FROM 'number'
        OR (item."entry"->>'copies')::NUMERIC NOT BETWEEN 1 AND 100
        OR item."entry"->>'duplex' NOT IN ('SIMPLEX', 'LONG_EDGE', 'SHORT_EDGE')
        OR item."entry"->>'orientation' NOT IN ('AUTO', 'PORTRAIT', 'LANDSCAPE')
        OR jsonb_typeof(item."entry"->'printedSides') IS DISTINCT FROM 'number'
        OR jsonb_typeof(item."entry"->'physicalSheets') IS DISTINCT FROM 'number'
        OR (item."entry"->>'physicalSheets')::NUMERIC > (item."entry"->>'printedSides')::NUMERIC
  )
  THEN
    RAISE EXCEPTION 'every print settings document must carry its own printable settings'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "print_setting_revisions_document_settings"
  ON "print_setting_revisions";

CREATE TRIGGER "print_setting_revisions_document_settings"
  BEFORE INSERT ON "print_setting_revisions"
  FOR EACH ROW EXECUTE FUNCTION "print_setting_revisions_reject_invalid_document_settings"();
