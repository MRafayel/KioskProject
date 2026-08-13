-- Admin control plane, Phase 5: publishing a tariff.
--
-- Everything the control plane can do is one Admin's decision, bounded to one
-- print, one obligation, one session or one colleague. Publishing a tariff is not
-- bounded to anything: it decides what every future customer is charged, at every
-- kiosk, from the instant it commits, and the person paying cannot see that it
-- changed. It is still one Admin's decision — this system has one Admin, and a
-- rule that waited for a second one would be a stoppage rather than a control.
--
-- So the protection here is not prevention by a second person. It is evidence
-- that cannot be forged or quietly removed by the connection performing the act:
--
--   admin_change_executions   who published which tariff, when, why, against
--                             which previous one, and what it produced. Append
--                             only: no UPDATE, no DELETE, no TRUNCATE, by
--                             trigger, for every role including the owner's.
--
-- The table is owned by `printing_kiosk_migrator`, so this migration runs as that
-- role: `pnpm db:migrate:owner`. Running it on the application connection will
-- fail, and that failure is the ownership separation working.
--
-- The properties enforced here rather than only in the application, each one a
-- way a compromised admin backend holding the pricing credential could otherwise
-- move every price in the estate without a trace:
--
--   1. A tariff written by the control plane must, at COMMIT, be exactly the
--      tariff a publication record accounts for — recomputed from the rows that
--      were actually written, not taken on trust from the code that wrote them.
--      "Confirm one tariff, publish another" is therefore not a thing the API can
--      do wrong.
--   2. Every publication record names an active Admin. Not the role the session
--      claimed: the role on the account row, re-read inside the transaction.
--   3. The record cannot be edited or deleted afterwards, and the tariff it names
--      cannot be deleted while it stands (ON DELETE RESTRICT).
--   4. The control plane may move a tariff in exactly two directions — publish a
--      draft it just wrote, and archive the one it replaces. Nothing it holds can
--      bring an archived tariff back, edit a published one, or leave the estate
--      with no tariff at all.
--
-- What is deliberately absent: no proposal state, no approval queue, no pending
-- anything. A change is written by the request that performs it, in the same
-- transaction, so there is no state for a background job to advance and no row
-- that means "somebody intended this once". And no way to schedule a publication
-- for later — a published tariff takes effect when it commits, because the quote
-- path answers "no tariff covers now" with a 503, and a priced-out kiosk is a
-- stopped kiosk.

-- ---------------------------------------------------------------------------
-- What an Admin published
-- ---------------------------------------------------------------------------

CREATE TABLE "admin_change_executions" (
  "id" UUID NOT NULL,
  "kind" VARCHAR(40) NOT NULL,
  -- The change as submitted, kept verbatim so the row can be read years later
  -- without reconstructing it from the tariff it produced. The digest below is
  -- what anything actually depends on; this is the human-readable copy.
  "payload" JSONB NOT NULL,
  "payload_digest" VARCHAR(64) NOT NULL,
  -- The tariff this replaced. Recorded so the sequence of published tariffs is a
  -- checkable chain rather than a list of rows that happen to be in order: each
  -- record names the digest of the state it was written against.
  "baseline_digest" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(280) NOT NULL,
  "published_by_admin_id" UUID NOT NULL,
  "published_by_role" VARCHAR(24) NOT NULL,
  -- What this produced. The rule set is named so the deferred check below can
  -- recompute what was published and compare it with what was recorded.
  "result_rule_set_id" UUID,
  "result_ref" VARCHAR(64),
  -- The version it replaced, so the log reads without joining to a tariff that
  -- may since have been archived twice over.
  "replaced_ref" VARCHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_change_executions_pkey" PRIMARY KEY ("id")
);

-- One record per published tariff. A second record naming the same rule set
-- would be two accounts of one act, and the deferred check below could then be
-- satisfied by whichever one happened to match.
CREATE UNIQUE INDEX "admin_change_executions_result_rule_set_id_key"
  ON "admin_change_executions" ("result_rule_set_id");

CREATE INDEX "admin_change_executions_kind_created_at_idx"
  ON "admin_change_executions" ("kind", "created_at");

CREATE INDEX "admin_change_executions_published_by_admin_id_idx"
  ON "admin_change_executions" ("published_by_admin_id");

ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_published_by_admin_id_fkey"
  FOREIGN KEY ("published_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT rather than CASCADE, in both directions of the relationship: a
-- published tariff cannot be removed while the record of who published it
-- stands, and the record cannot be removed at all.
ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_result_rule_set_id_fkey"
  FOREIGN KEY ("result_rule_set_id") REFERENCES "pricing_rule_sets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A closed vocabulary, so a kind nobody reviewed is a failed insert rather than
-- a change log with no rules about what may appear in it.
ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_kind_check"
  CHECK ("kind" IN ('PRICING_PUBLISH'));

-- Pricing is an operational decision, so it is an Admin's — never the support
-- role's. Written as a check constraint as well as a capability, so the
-- separation survives an endpoint that forgets which capability it meant to
-- require.
ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_role_check"
  CHECK ("published_by_role" = 'ADMIN');

ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_reason_check"
  CHECK (length(btrim("reason")) >= 8);

ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_payload_digest_check"
  CHECK ("payload_digest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_baseline_digest_check"
  CHECK ("baseline_digest" ~ '^[0-9a-f]{64}$');

-- A pricing publication produced a tariff, or it produced nothing and should not
-- exist. Stated as a constraint so a future kind that legitimately produces no
-- row has to say so here rather than by omission.
ALTER TABLE "admin_change_executions"
  ADD CONSTRAINT "admin_change_executions_result_check" CHECK (
    "kind" <> 'PRICING_PUBLISH'
    OR ("result_rule_set_id" IS NOT NULL AND "result_ref" IS NOT NULL)
  );

-- Who may publish.
--
-- Note what this does *not* do: it does not lock the account row, which every
-- identity-touching trigger before it does. `SELECT ... FOR UPDATE` requires
-- UPDATE privilege on the table, and the role that runs this trigger holds none
-- on `admin_users` — which is a property worth more than the lock. The race it
-- would close is a publication recorded in the same instant its author is
-- suspended, and that is already bounded from both sides: suspending revokes
-- every session, so the request would not authorize, and the account is re-read
-- here inside the transaction that writes.
CREATE OR REPLACE FUNCTION "admin_change_executions_assert_author"() RETURNS TRIGGER AS $$
DECLARE
  "author_role" VARCHAR(24);
  "author_status" VARCHAR(24);
BEGIN
  SELECT "role", "status" INTO "author_role", "author_status"
  FROM "admin_users"
  WHERE "id" = NEW."published_by_admin_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a change must name an existing account'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The role on the account row, not the one the session presented. A session
  -- that outlived a demotion, or a bug that trusted a claim, is refused here.
  IF "author_role" <> 'ADMIN' OR "author_status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a change must be published by an active Admin'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_change_executions_author"
  BEFORE INSERT ON "admin_change_executions"
  FOR EACH ROW EXECUTE FUNCTION "admin_change_executions_assert_author"();

-- Append-only, for every role including the table's owner. A record of what the
-- prices did that could be rewritten afterwards is not a record.
CREATE OR REPLACE FUNCTION "admin_change_executions_reject_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_change_executions is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_change_executions_no_update"
  BEFORE UPDATE ON "admin_change_executions"
  FOR EACH ROW EXECUTE FUNCTION "admin_change_executions_reject_rewrite"();

CREATE TRIGGER "admin_change_executions_no_delete"
  BEFORE DELETE ON "admin_change_executions"
  FOR EACH ROW EXECUTE FUNCTION "admin_change_executions_reject_rewrite"();

CREATE TRIGGER "admin_change_executions_no_truncate"
  BEFORE TRUNCATE ON "admin_change_executions"
  FOR EACH STATEMENT EXECUTE FUNCTION "admin_change_executions_reject_rewrite"();

-- ---------------------------------------------------------------------------
-- What the control plane may do to a tariff
-- ---------------------------------------------------------------------------

-- The canonical text a pricing change's digest is taken over.
--
-- This is the SQL half of `canonicalPricingPublishText` in
-- `@printing-kiosk/admin-access`, and the two must produce byte-identical output
-- or every publication fails closed. That is the intended failure direction, and
-- an integration test asserts a real round trip rather than trusting it.
--
-- Recomputing the digest from the stored rows — rather than trusting the digest
-- the application supplies — is what makes "confirm one tariff, publish another"
-- impossible instead of merely unlikely. The rule line is built from the rules
-- actually attached to the set, so a second rule slipped in afterwards changes
-- the digest and the check that was already satisfied stops being satisfied.
CREATE OR REPLACE FUNCTION "pricing_rule_sets_canonical_text"("set_id" UUID)
  RETURNS TEXT AS $$
DECLARE
  "header" TEXT;
  "rules" TEXT;
BEGIN
  SELECT 'pricing.publish/v1' || E'\n'
      || 'version=' || "version" || E'\n'
      || 'scope=' || "scope"
      || '|ref=' || "scope_ref"
      || '|currency=' || btrim("currency")
      || '|exponent=' || "currency_exponent"
      || '|rounding=' || "rounding"
      || '|tax=' || "tax_mode"
      || '|minimum=' || "minimum_application"
    INTO "header"
    FROM "pricing_rule_sets"
   WHERE "id" = "set_id";

  IF "header" IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT string_agg(
           E'\n' || 'rule=' || "service"
             || '|' || "paper_size"
             || '|' || "color_mode"
             || '|' || "unit_amount_minor"
             || '|' || "duplex_adjustment_basis_points"
             || '|' || "service_fee_minor"
             || '|' || "minimum_amount_minor"
             || '|' || "tax_basis_points"
             || '|' || "priority",
           '' ORDER BY "service", "paper_size", "color_mode"
         )
    INTO "rules"
    FROM "pricing_rules"
   WHERE "rule_set_id" = "set_id";

  RETURN "header" || COALESCE("rules", '');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "pricing_rule_sets_canonical_digest"("set_id" UUID)
  RETURNS TEXT AS $$
  SELECT encode(sha256(convert_to("pricing_rule_sets_canonical_text"($1), 'UTF8')), 'hex');
$$ LANGUAGE sql STABLE;

-- A tariff the control plane wrote must be one a publication record accounts
-- for, byte for byte.
--
-- Checked from two triggers — one on the tariff, one on its rules — so the pair
-- share this. Deferred at both call sites, because the record names the rule set
-- and therefore has to be written after it, and the rules are written after the
-- set they belong to. At COMMIT there is no ordering left to excuse a missing
-- record or a half-written tariff, so this is the point at which "who changed
-- the prices, and to what" is guaranteed an answer.
--
-- Both triggers fire for the pricing role only. The seed and the migrations
-- write tariffs on the application connection and are not part of this workflow:
-- a row that role writes is a deployment decision with a person and a shell
-- behind it, not a browser request.
CREATE OR REPLACE FUNCTION "pricing_assert_recorded_publication"("set_id" UUID) RETURNS VOID AS $$
DECLARE
  "recorded_digest" VARCHAR(64);
  "written_digest" TEXT;
  "set_status" VARCHAR(16);
BEGIN
  SELECT "status" INTO "set_status" FROM "pricing_rule_sets" WHERE "id" = "set_id";
  IF NOT FOUND THEN
    -- The set was rolled back or removed within this transaction; there is
    -- nothing left to have published.
    RETURN;
  END IF;

  -- A draft is a step inside the publishing transaction, never a state a
  -- committed row rests in. Leaving one behind would be an unpublished tariff
  -- with no record and no way to reach it.
  IF "set_status" <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'the control plane may only write a published tariff, not a % one', "set_status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT "payload_digest" INTO "recorded_digest"
    FROM "admin_change_executions"
   WHERE "result_rule_set_id" = "set_id";

  IF "recorded_digest" IS NULL THEN
    RAISE EXCEPTION 'a tariff published by the control plane must record who published it'
      USING ERRCODE = 'restrict_violation';
  END IF;

  "written_digest" := "pricing_rule_sets_canonical_digest"("set_id");

  IF "written_digest" IS DISTINCT FROM "recorded_digest" THEN
    RAISE EXCEPTION 'the published tariff does not match the change that was recorded'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "pricing_rule_sets_assert_recorded"() RETURNS TRIGGER AS $$
BEGIN
  IF current_user <> 'printing_kiosk_admin_pricing_writer' THEN
    RETURN NULL;
  END IF;
  PERFORM "pricing_assert_recorded_publication"(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "pricing_rule_sets_recorded_publication"
  AFTER INSERT ON "pricing_rule_sets"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "pricing_rule_sets_assert_recorded"();

CREATE OR REPLACE FUNCTION "pricing_rules_assert_recorded"() RETURNS TRIGGER AS $$
BEGIN
  IF current_user <> 'printing_kiosk_admin_pricing_writer' THEN
    RETURN NULL;
  END IF;
  PERFORM "pricing_assert_recorded_publication"(NEW."rule_set_id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The same check from the rules' side. Without it, the control plane could add a
-- rule to a tariff that was already published and already checked — changing
-- what every quote costs without touching the row the record names.
CREATE CONSTRAINT TRIGGER "pricing_rules_recorded_publication"
  AFTER INSERT ON "pricing_rules"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "pricing_rules_assert_recorded"();

-- The only two directions the control plane may move a tariff.
--
-- Publishing replaces, and a replacement is written in the order Phase 6's
-- hardening migration established and this one keeps: a draft, then its rules,
-- then the publication. The rules have to be written while the set is still a
-- draft, because `pricing_rules_immutable_when_published` refuses a rule added
-- to a published set — which is the guarantee that a published tariff's numbers
-- never change after the fact, and is worth more than the convenience of
-- inserting the set as PUBLISHED in one statement.
--
-- So the transitions are:
--
--   DRAFT     → PUBLISHED   the last step of a publication
--   PUBLISHED → ARCHIVED    the tariff being replaced, in the same transaction,
--                           because the published-per-scope unique index permits
--                           exactly one
--
-- Everything else is refused. In particular the control plane cannot bring an
-- archived tariff back: ARCHIVED → PUBLISHED is not one of the two, and the
-- immutability trigger beside this one returns early for a row that is not
-- currently published, so without this it would be open.
CREATE OR REPLACE FUNCTION "pricing_rule_sets_assert_admin_transition"() RETURNS TRIGGER AS $$
BEGIN
  IF current_user <> 'printing_kiosk_admin_pricing_writer' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' THEN
    -- `published_at` is written by the INSERT that created the draft and is not
    -- a column this role may update, so a publication cannot arrive undated.
    -- The CHECK constraint refuses it too.
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'ARCHIVED' THEN
    IF NEW."archived_at" IS NULL THEN
      RAISE EXCEPTION 'an archived tariff must record when it stopped applying'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'the control plane may only publish a draft or archive the tariff it is replacing'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pricing_rule_sets_admin_transition"
  BEFORE UPDATE ON "pricing_rule_sets"
  FOR EACH ROW EXECUTE FUNCTION "pricing_rule_sets_assert_admin_transition"();
