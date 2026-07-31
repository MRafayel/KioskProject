-- Phase 6 hardening: close two gaps in the published-tariff guarantees.
--
-- 1. The immutability trigger on "pricing_rules" fired BEFORE UPDATE OR DELETE
--    only, so a rule could still be INSERTed into an already-published rule
--    set. That is the same act as editing a published tariff: it changes what
--    a published version charges after the fact. Today the per-rule-set unique
--    key and the single-value CHECK constraints on service, paper size and
--    colour mode happen to leave no room for a second PRINT/A4/MONOCHROME row,
--    so the hole is not yet reachable for repricing — it opens the moment a
--    second service or paper size is introduced. Close it now, while the
--    correct publication order (draft, then rules, then publish) is still
--    cheap to adopt.
--
-- 2. "GLOBAL" is the fallback pricing scope the API looks up. The partial
--    unique index permits one published set per (scope, scope_ref) pair, so
--    two published GLOBAL sets carrying different scope_ref values could
--    coexist and the lookup would have to choose between them arbitrarily. A
--    GLOBAL set has nothing to refer to, so its scope_ref is now required to
--    be empty and the index once again means one published global tariff.

ALTER TABLE "pricing_rule_sets"
  ADD CONSTRAINT "pricing_rule_sets_global_scope_ref_check"
  CHECK ("scope" <> 'GLOBAL' OR "scope_ref" = '');

CREATE OR REPLACE FUNCTION "pricing_rules_reject_published_change"() RETURNS TRIGGER AS $$
DECLARE
  parent_status VARCHAR(16);
BEGIN
  -- OLD is unassigned on INSERT and NEW is unassigned on DELETE, so the parent
  -- is resolved per operation rather than with COALESCE over the two records.
  IF TG_OP <> 'DELETE' THEN
    SELECT "status" INTO parent_status
      FROM "pricing_rule_sets" WHERE "id" = NEW."rule_set_id";
    IF parent_status = 'PUBLISHED' THEN
      RAISE EXCEPTION 'pricing rules of a published rule set are immutable; publish a new version'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Moving a rule out of a published set, or deleting one, changes that set
  -- just as much as writing into it.
  IF TG_OP <> 'INSERT' THEN
    SELECT "status" INTO parent_status
      FROM "pricing_rule_sets" WHERE "id" = OLD."rule_set_id";
    IF parent_status = 'PUBLISHED' THEN
      RAISE EXCEPTION 'pricing rules of a published rule set are immutable; publish a new version'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "pricing_rules_immutable_when_published" ON "pricing_rules";
CREATE TRIGGER "pricing_rules_immutable_when_published"
  BEFORE INSERT OR UPDATE OR DELETE ON "pricing_rules"
  FOR EACH ROW EXECUTE FUNCTION "pricing_rules_reject_published_change"();
