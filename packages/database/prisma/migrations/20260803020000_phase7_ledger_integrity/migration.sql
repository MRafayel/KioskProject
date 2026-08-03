-- Freeze the identity of accounting records while leaving their explicit
-- state-machine fields available to the services that settle them. These
-- checks protect the ledger from future writers that bypass the current API.

CREATE OR REPLACE FUNCTION "payments_reject_identity_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."provider_intent_id" IS DISTINCT FROM OLD."provider_intent_id"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."currency_exponent" IS DISTINCT FROM OLD."currency_exponent"
    OR NEW."settings_revision" IS DISTINCT FROM OLD."settings_revision"
    OR NEW."manifest_hash" IS DISTINCT FROM OLD."manifest_hash"
    OR NEW."created_by_actor_type" IS DISTINCT FROM OLD."created_by_actor_type"
    OR NEW."created_by_actor_id" IS DISTINCT FROM OLD."created_by_actor_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'a payment accounting identity cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payments_identity_is_immutable"
  BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_reject_identity_rewrite"();

-- Once a capture is recorded, its timestamp and fulfillment disposition are
-- final as well as its status. Effective capture sets applied_to_session in
-- the same transition; a compensated late capture can never be promoted later.
CREATE OR REPLACE FUNCTION "payments_assert_status_progression"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'CAPTURED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."captured_at" IS DISTINCT FROM OLD."captured_at"
      OR NEW."applied_to_session" IS DISTINCT FROM OLD."applied_to_session"
    THEN
      RAISE EXCEPTION 'a captured payment is final' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'DECLINED' THEN
    RAISE EXCEPTION 'a declined payment cannot later capture'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" IN ('CANCELED', 'TIMED_OUT') AND NEW."status" <> 'CAPTURED' THEN
    RAISE EXCEPTION 'a settled payment may only be followed by a capture'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'PENDING' THEN
    RAISE EXCEPTION 'a payment cannot return to pending' USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The inbox stores both received evidence and the reducer's decision. No
-- second writer currently completes these rows later, so every field is final
-- after insert and a duplicate callback can only be observed, never relabeled.
CREATE OR REPLACE FUNCTION "payment_webhook_inbox_reject_replacement"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a processed payment callback cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- If an inbox row names a payment, its provider evidence must name that exact
-- payment too. Unknown intents deliberately keep payment_id NULL.
CREATE OR REPLACE FUNCTION "payment_webhook_inbox_assert_payment"() RETURNS TRIGGER AS $$
DECLARE
  linked RECORD;
BEGIN
  IF NEW."payment_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "provider", "provider_intent_id"
    INTO linked
    FROM "payments"
    WHERE "id" = NEW."payment_id";

  IF NOT FOUND
    OR NEW."provider" IS DISTINCT FROM linked."provider"
    OR NEW."provider_intent_id" IS DISTINCT FROM linked."provider_intent_id"
  THEN
    RAISE EXCEPTION 'a payment callback must match its linked payment'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_webhook_inbox_matches_payment"
  BEFORE INSERT OR UPDATE ON "payment_webhook_inbox"
  FOR EACH ROW EXECUTE FUNCTION "payment_webhook_inbox_assert_payment"();

-- A mismatch refund may intentionally carry different money from the quote,
-- but its session and provider must still be those of the payment it repays.
-- Its commercial identity is immutable; a future executor may update only
-- provider_refund_id, status, updated_at and completed_at.
CREATE OR REPLACE FUNCTION "refunds_assert_payment_and_identity"() RETURNS TRIGGER AS $$
DECLARE
  linked RECORD;
BEGIN
  SELECT "session_id", "provider"
    INTO linked
    FROM "payments"
    WHERE "id" = NEW."payment_id";

  IF NOT FOUND
    OR NEW."session_id" IS DISTINCT FROM linked."session_id"
    OR NEW."provider" IS DISTINCT FROM linked."provider"
  THEN
    RAISE EXCEPTION 'a refund must belong to its payment session and provider'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."currency_exponent" IS DISTINCT FROM OLD."currency_exponent"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'a refund accounting identity cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refunds_match_payment_and_keep_identity"
  BEFORE INSERT OR UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "refunds_assert_payment_and_identity"();
