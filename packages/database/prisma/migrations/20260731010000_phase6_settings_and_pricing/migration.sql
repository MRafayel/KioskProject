-- Phase 6 adds immutable print settings revisions, published pricing rules and
-- server-authoritative price quotes. Every addition is additive: existing
-- sessions keep a NULL settings revision and a NULL active quote until the
-- kiosk saves settings for the first time.

ALTER TABLE "print_sessions"
  ADD COLUMN "current_settings_revision" INTEGER,
  ADD COLUMN "active_quote_id" UUID;

ALTER TABLE "print_sessions"
  ADD CONSTRAINT "print_sessions_settings_revision_check"
  CHECK ("current_settings_revision" IS NULL OR "current_settings_revision" > 0);

CREATE TABLE "print_setting_revisions" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "copies" INTEGER NOT NULL,
  "duplex" VARCHAR(16) NOT NULL,
  "paper_size" VARCHAR(16) NOT NULL,
  "orientation" VARCHAR(16) NOT NULL,
  "pages_per_sheet" INTEGER NOT NULL,
  "scaling" VARCHAR(16) NOT NULL,
  "collate" BOOLEAN NOT NULL,
  "color_mode" VARCHAR(16) NOT NULL,
  "selections" JSONB NOT NULL,
  "selected_pages" INTEGER NOT NULL,
  "printed_sides" INTEGER NOT NULL,
  "physical_sheets" INTEGER NOT NULL,
  "capability_version" INTEGER NOT NULL,
  "manifest_hash" VARCHAR(64) NOT NULL,
  "created_by_actor_type" VARCHAR(32) NOT NULL,
  "created_by_actor_id" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "print_setting_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "print_setting_revisions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "print_setting_revisions_duplex_check"
    CHECK ("duplex" IN ('SIMPLEX', 'LONG_EDGE', 'SHORT_EDGE')),
  CONSTRAINT "print_setting_revisions_paper_size_check" CHECK ("paper_size" IN ('A4')),
  CONSTRAINT "print_setting_revisions_orientation_check"
    CHECK ("orientation" IN ('AUTO', 'PORTRAIT', 'LANDSCAPE')),
  CONSTRAINT "print_setting_revisions_scaling_check" CHECK ("scaling" IN ('FIT', 'ACTUAL_SIZE')),
  -- The product sells monochrome output only. The database refuses to record
  -- any other intent, whatever an API or client believes it requested.
  CONSTRAINT "print_setting_revisions_color_mode_check" CHECK ("color_mode" = 'MONOCHROME'),
  CONSTRAINT "print_setting_revisions_pages_per_sheet_check" CHECK ("pages_per_sheet" IN (1, 2)),
  CONSTRAINT "print_setting_revisions_counts_check" CHECK (
    "copies" BETWEEN 1 AND 100
    AND "selected_pages" > 0
    AND "printed_sides" > 0
    AND "physical_sheets" > 0
    AND "physical_sheets" <= "printed_sides"
    AND "capability_version" > 0
  ),
  CONSTRAINT "print_setting_revisions_manifest_hash_check"
    CHECK ("manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "print_setting_revisions_selections_check"
    CHECK (jsonb_typeof("selections") = 'array' AND jsonb_array_length("selections") > 0)
);

CREATE TABLE "pricing_rule_sets" (
  "id" UUID NOT NULL,
  "version" VARCHAR(40) NOT NULL,
  "scope" VARCHAR(24) NOT NULL,
  "scope_ref" VARCHAR(64) NOT NULL DEFAULT '',
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "rounding" VARCHAR(16) NOT NULL,
  "tax_mode" VARCHAR(16) NOT NULL,
  "minimum_application" VARCHAR(16) NOT NULL,
  "valid_from" TIMESTAMPTZ NOT NULL,
  "valid_until" TIMESTAMPTZ,
  "published_at" TIMESTAMPTZ,
  "archived_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pricing_rule_sets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pricing_rule_sets_scope_check" CHECK ("scope" IN ('GLOBAL', 'SITE', 'KIOSK')),
  CONSTRAINT "pricing_rule_sets_status_check"
    CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  CONSTRAINT "pricing_rule_sets_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "pricing_rule_sets_exponent_check" CHECK ("currency_exponent" BETWEEN 0 AND 4),
  CONSTRAINT "pricing_rule_sets_rounding_check"
    CHECK ("rounding" IN ('HALF_UP', 'HALF_EVEN', 'AWAY_FROM_ZERO', 'TOWARD_ZERO')),
  CONSTRAINT "pricing_rule_sets_tax_mode_check" CHECK ("tax_mode" IN ('EXCLUSIVE')),
  CONSTRAINT "pricing_rule_sets_minimum_application_check"
    CHECK ("minimum_application" IN ('BEFORE_TAX', 'AFTER_TAX')),
  CONSTRAINT "pricing_rule_sets_validity_check"
    CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
  CONSTRAINT "pricing_rule_sets_published_check"
    CHECK ("status" <> 'PUBLISHED' OR "published_at" IS NOT NULL)
);

CREATE TABLE "pricing_rules" (
  "id" UUID NOT NULL,
  "rule_set_id" UUID NOT NULL,
  "service" VARCHAR(24) NOT NULL,
  "paper_size" VARCHAR(16) NOT NULL,
  "color_mode" VARCHAR(16) NOT NULL,
  "unit_amount_minor" INTEGER NOT NULL,
  "duplex_adjustment_basis_points" INTEGER NOT NULL DEFAULT 0,
  "service_fee_minor" INTEGER NOT NULL DEFAULT 0,
  "minimum_amount_minor" INTEGER NOT NULL DEFAULT 0,
  "tax_basis_points" INTEGER NOT NULL DEFAULT 0,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pricing_rules_service_check" CHECK ("service" IN ('PRINT')),
  CONSTRAINT "pricing_rules_paper_size_check" CHECK ("paper_size" IN ('A4')),
  CONSTRAINT "pricing_rules_color_mode_check" CHECK ("color_mode" = 'MONOCHROME'),
  CONSTRAINT "pricing_rules_amounts_check" CHECK (
    "unit_amount_minor" >= 0
    AND "unit_amount_minor" <= 100000000
    AND "service_fee_minor" >= 0
    AND "service_fee_minor" <= 100000000
    AND "minimum_amount_minor" >= 0
    AND "minimum_amount_minor" <= 100000000
    AND "tax_basis_points" BETWEEN 0 AND 10000
    AND "duplex_adjustment_basis_points" BETWEEN -10000 AND 10000
  )
);

CREATE TABLE "price_quotes" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "settings_revision" INTEGER NOT NULL,
  "manifest_hash" VARCHAR(64) NOT NULL,
  "rule_set_id" UUID NOT NULL,
  "pricing_version" VARCHAR(40) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" INTEGER NOT NULL,
  "selected_pages" INTEGER NOT NULL,
  "printed_sides" INTEGER NOT NULL,
  "physical_sheets" INTEGER NOT NULL,
  "print_amount_minor" INTEGER NOT NULL,
  "duplex_adjustment_minor" INTEGER NOT NULL,
  "service_fee_minor" INTEGER NOT NULL,
  "minimum_adjustment_minor" INTEGER NOT NULL,
  "subtotal_minor" INTEGER NOT NULL,
  "tax_minor" INTEGER NOT NULL,
  "total_minor" INTEGER NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidated_at" TIMESTAMPTZ,
  "invalidation_reason" VARCHAR(32),
  CONSTRAINT "price_quotes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "price_quotes_status_check"
    CHECK ("status" IN ('ACTIVE', 'INVALIDATED', 'EXPIRED', 'CONSUMED')),
  CONSTRAINT "price_quotes_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "price_quotes_exponent_check" CHECK ("currency_exponent" BETWEEN 0 AND 4),
  CONSTRAINT "price_quotes_manifest_hash_check" CHECK ("manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "price_quotes_counts_check" CHECK (
    "settings_revision" > 0
    AND "selected_pages" > 0
    AND "printed_sides" > 0
    AND "physical_sheets" > 0
    AND "physical_sheets" <= "printed_sides"
  ),
  -- Money is integer minor units only. The stored breakdown must reconstruct
  -- the stored total exactly, so an inconsistent write cannot be paid. The
  -- minimum adjustment is charged either before or after tax depending on the
  -- published rule set, so the identity accounts for both placements.
  CONSTRAINT "price_quotes_amounts_check" CHECK (
    "print_amount_minor" >= 0
    AND "service_fee_minor" >= 0
    AND "minimum_adjustment_minor" >= 0
    AND "subtotal_minor" >= 0
    AND "tax_minor" >= 0
    AND "total_minor" >= 0
    AND "total_minor" <= 100000000
    AND "subtotal_minor" >=
      GREATEST("print_amount_minor" + "duplex_adjustment_minor" + "service_fee_minor", 0)
    AND "total_minor" >= "subtotal_minor" + "tax_minor"
    AND "minimum_adjustment_minor" = (
      "subtotal_minor"
      - GREATEST("print_amount_minor" + "duplex_adjustment_minor" + "service_fee_minor", 0)
    ) + ("total_minor" - "subtotal_minor" - "tax_minor")
  ),
  -- A quote that simply ran out of time records when, not why: the reason
  -- column exists to explain the cases where something the customer or the
  -- session did made the price wrong before its deadline.
  CONSTRAINT "price_quotes_invalidation_check" CHECK (
    ("status" IN ('ACTIVE', 'CONSUMED') AND "invalidated_at" IS NULL AND "invalidation_reason" IS NULL)
    OR ("status" = 'EXPIRED' AND "invalidated_at" IS NOT NULL AND "invalidation_reason" IS NULL)
    OR (
      "status" = 'INVALIDATED'
      AND "invalidated_at" IS NOT NULL
      AND "invalidation_reason" IN (
        'SETTINGS_CHANGED',
        'DOCUMENTS_CHANGED',
        'SUPERSEDED',
        'SESSION_TERMINAL'
      )
    )
  )
);

CREATE UNIQUE INDEX "print_setting_revisions_session_id_revision_key"
  ON "print_setting_revisions"("session_id", "revision");
CREATE INDEX "print_setting_revisions_session_id_created_at_idx"
  ON "print_setting_revisions"("session_id", "created_at");

CREATE UNIQUE INDEX "pricing_rule_sets_version_key" ON "pricing_rule_sets"("version");
CREATE INDEX "pricing_rule_sets_status_valid_from_idx"
  ON "pricing_rule_sets"("status", "valid_from");
-- At most one published rule set per pricing scope. This is what makes the
-- validity windows of published sets non-overlapping in the MVP.
CREATE UNIQUE INDEX "pricing_rule_sets_published_scope_idx"
  ON "pricing_rule_sets"("scope", "scope_ref") WHERE "status" = 'PUBLISHED';

CREATE UNIQUE INDEX "pricing_rules_rule_set_id_service_paper_size_color_mode_key"
  ON "pricing_rules"("rule_set_id", "service", "paper_size", "color_mode");

CREATE UNIQUE INDEX "price_quotes_id_session_id_key" ON "price_quotes"("id", "session_id");
CREATE INDEX "price_quotes_session_id_created_at_idx" ON "price_quotes"("session_id", "created_at");
CREATE INDEX "price_quotes_status_expires_at_idx" ON "price_quotes"("status", "expires_at");
-- One live price per session. A second active quote cannot be created without
-- first invalidating the previous one in the same transaction.
CREATE UNIQUE INDEX "price_quotes_one_active_per_session_idx"
  ON "price_quotes"("session_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "print_sessions_active_quote_id_key"
  ON "print_sessions"("active_quote_id");

ALTER TABLE "print_setting_revisions"
  ADD CONSTRAINT "print_setting_revisions_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pricing_rules"
  ADD CONSTRAINT "pricing_rules_rule_set_id_fkey"
  FOREIGN KEY ("rule_set_id") REFERENCES "pricing_rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_quotes"
  ADD CONSTRAINT "price_quotes_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_quotes"
  ADD CONSTRAINT "price_quotes_settings_fkey"
  FOREIGN KEY ("session_id", "settings_revision")
  REFERENCES "print_setting_revisions"("session_id", "revision")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_quotes"
  ADD CONSTRAINT "price_quotes_rule_set_id_fkey"
  FOREIGN KEY ("rule_set_id") REFERENCES "pricing_rule_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_sessions"
  ADD CONSTRAINT "print_sessions_active_quote_id_fkey"
  FOREIGN KEY ("active_quote_id") REFERENCES "price_quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Immutability is enforced by the database, not only by application code. A
-- future admin tool, a migration script, or a mistaken query must not be able
-- to reprice a settled quote or edit a published tariff in place.
CREATE OR REPLACE FUNCTION "print_setting_revisions_reject_update"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'print_setting_revisions rows are append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_setting_revisions_no_update"
  BEFORE UPDATE ON "print_setting_revisions"
  FOR EACH ROW EXECUTE FUNCTION "print_setting_revisions_reject_update"();

CREATE OR REPLACE FUNCTION "pricing_rule_sets_reject_published_update"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'PUBLISHED' THEN
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('PUBLISHED', 'ARCHIVED')
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."scope_ref" IS DISTINCT FROM OLD."scope_ref"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."currency_exponent" IS DISTINCT FROM OLD."currency_exponent"
    OR NEW."rounding" IS DISTINCT FROM OLD."rounding"
    OR NEW."tax_mode" IS DISTINCT FROM OLD."tax_mode"
    OR NEW."minimum_application" IS DISTINCT FROM OLD."minimum_application"
    OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
    OR NEW."valid_until" IS DISTINCT FROM OLD."valid_until"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
  THEN
    RAISE EXCEPTION 'published pricing rule sets are immutable; publish a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pricing_rule_sets_immutable_when_published"
  BEFORE UPDATE ON "pricing_rule_sets"
  FOR EACH ROW EXECUTE FUNCTION "pricing_rule_sets_reject_published_update"();

CREATE OR REPLACE FUNCTION "pricing_rules_reject_published_change"() RETURNS TRIGGER AS $$
DECLARE
  parent_status VARCHAR(16);
  parent_id UUID;
BEGIN
  parent_id := COALESCE(NEW."rule_set_id", OLD."rule_set_id");
  SELECT "status" INTO parent_status FROM "pricing_rule_sets" WHERE "id" = parent_id;
  IF parent_status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'pricing rules of a published rule set are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pricing_rules_immutable_when_published"
  BEFORE UPDATE OR DELETE ON "pricing_rules"
  FOR EACH ROW EXECUTE FUNCTION "pricing_rules_reject_published_change"();
