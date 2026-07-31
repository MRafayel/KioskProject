-- Pages-per-sheet is withdrawn from the product. One selected page is always
-- one printed side, so the column and its check constraint no longer describe
-- anything a customer can choose.
--
-- Existing revisions are append-only history, but they are also unpayable
-- without a live quote, and the settings manifest version moved to 2 so no
-- stored manifest hash is compared against the new shape.

ALTER TABLE "print_setting_revisions"
  DROP CONSTRAINT IF EXISTS "print_setting_revisions_pages_per_sheet_check";

ALTER TABLE "print_setting_revisions"
  DROP COLUMN "pages_per_sheet";
