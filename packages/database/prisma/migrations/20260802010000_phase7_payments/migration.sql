-- Phase 7 adds the payment ledger: one accounting record per attempt to
-- collect one quote's total, the provider interactions behind it, the verified
-- callback inbox, and compensation records for money that moved when it should
-- not have. Every addition is additive; sessions written before this migration
-- are untouched and simply have no payments.

CREATE TABLE "payments" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "quote_id" UUID NOT NULL,
  "provider" VARCHAR(24) NOT NULL,
  "provider_intent_id" VARCHAR(120) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" INTEGER NOT NULL,
  "settings_revision" INTEGER NOT NULL,
  "manifest_hash" VARCHAR(64) NOT NULL,
  "failure_code" VARCHAR(48),
  "created_by_actor_type" VARCHAR(32) NOT NULL,
  "created_by_actor_id" VARCHAR(100) NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "authorized_at" TIMESTAMPTZ,
  "captured_at" TIMESTAMPTZ,
  "failed_at" TIMESTAMPTZ,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payments_provider_check" CHECK ("provider" IN ('MOCK')),
  CONSTRAINT "payments_status_check" CHECK (
    "status" IN ('PENDING', 'AUTHORIZED', 'CAPTURED', 'DECLINED', 'CANCELED', 'TIMED_OUT')
  ),
  CONSTRAINT "payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "payments_exponent_check" CHECK ("currency_exponent" BETWEEN 0 AND 4),
  CONSTRAINT "payments_manifest_hash_check" CHECK ("manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "payments_amount_check"
    CHECK ("amount_minor" >= 0 AND "amount_minor" <= 100000000 AND "settings_revision" > 0),
  CONSTRAINT "payments_window_check" CHECK ("expires_at" > "created_at"),
  -- A capture without a capture time, or a failure without a reason, would be
  -- an accounting record that cannot be read back.
  CONSTRAINT "payments_captured_check"
    CHECK ("status" <> 'CAPTURED' OR "captured_at" IS NOT NULL),
  CONSTRAINT "payments_failed_check" CHECK (
    "status" NOT IN ('DECLINED', 'CANCELED', 'TIMED_OUT')
    OR ("failed_at" IS NOT NULL AND "failure_code" IS NOT NULL)
  )
);

CREATE TABLE "payment_attempts" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "attempt" INTEGER NOT NULL,
  "action" VARCHAR(24) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "provider_reference" VARCHAR(120),
  "failure_code" VARCHAR(48),
  "idempotency_key_digest" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_attempts_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "payment_attempts_action_check"
    CHECK ("action" IN ('CREATE', 'CONFIRM', 'CANCEL', 'CAPTURE', 'RECONCILE', 'REFUND')),
  CONSTRAINT "payment_attempts_status_check" CHECK (
    "status" IN ('PENDING', 'AUTHORIZED', 'CAPTURED', 'DECLINED', 'CANCELED', 'TIMED_OUT', 'FAILED')
  ),
  -- A stored idempotency key would be a bearer value at rest; only its digest
  -- is kept, exactly as the idempotency records themselves do.
  CONSTRAINT "payment_attempts_key_digest_check"
    CHECK ("idempotency_key_digest" IS NULL OR "idempotency_key_digest" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "payment_webhook_inbox" (
  "id" UUID NOT NULL,
  "provider" VARCHAR(24) NOT NULL,
  "provider_event_id" VARCHAR(120) NOT NULL,
  "provider_intent_id" VARCHAR(120) NOT NULL,
  "payment_id" UUID,
  "event_type" VARCHAR(48) NOT NULL,
  "payload_digest" VARCHAR(64) NOT NULL,
  "result" VARCHAR(32) NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ,
  CONSTRAINT "payment_webhook_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_webhook_inbox_provider_check" CHECK ("provider" IN ('MOCK')),
  CONSTRAINT "payment_webhook_inbox_digest_check" CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "payment_webhook_inbox_result_check" CHECK (
    "result" IN (
      'RECEIVED',
      'CAPTURED',
      'FAILED',
      'DUPLICATE_CAPTURE',
      'IGNORED_UNKNOWN_INTENT',
      'IGNORED_TERMINAL_PAYMENT',
      'AMOUNT_MISMATCH',
      'LATE_CAPTURE'
    )
  )
);

CREATE TABLE "refunds" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "provider" VARCHAR(24) NOT NULL,
  "provider_refund_id" VARCHAR(120),
  "reason" VARCHAR(32) NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refunds_provider_check" CHECK ("provider" IN ('MOCK')),
  CONSTRAINT "refunds_reason_check" CHECK (
    "reason" IN ('LATE_CAPTURE', 'AMOUNT_MISMATCH', 'PRINT_FAILED', 'OPERATOR_REQUESTED')
  ),
  CONSTRAINT "refunds_status_check"
    CHECK ("status" IN ('PENDING', 'REQUESTED', 'COMPLETED', 'FAILED')),
  CONSTRAINT "refunds_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "refunds_amount_check"
    CHECK ("amount_minor" > 0 AND "amount_minor" <= 100000000
      AND "currency_exponent" BETWEEN 0 AND 4),
  CONSTRAINT "refunds_completed_check"
    CHECK ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "payments_id_session_id_key" ON "payments"("id", "session_id");
-- One provider intent maps to exactly one payment, so a repeated create can
-- never open a second charge behind the same intent.
CREATE UNIQUE INDEX "payments_provider_intent_key"
  ON "payments"("provider", "provider_intent_id");
CREATE INDEX "payments_session_id_created_at_idx" ON "payments"("session_id", "created_at");
CREATE INDEX "payments_status_expires_at_idx" ON "payments"("status", "expires_at");
-- At most one effective capture per session, enforced by the database rather
-- than by application code alone.
CREATE UNIQUE INDEX "payments_one_capture_per_session_idx"
  ON "payments"("session_id") WHERE "status" = 'CAPTURED';
-- At most one payment in flight per session. A retry after a decline is a new
-- payment; a second simultaneous one is a mistake.
CREATE UNIQUE INDEX "payments_one_open_per_session_idx"
  ON "payments"("session_id") WHERE "status" IN ('PENDING', 'AUTHORIZED');

CREATE UNIQUE INDEX "payment_attempts_payment_id_attempt_key"
  ON "payment_attempts"("payment_id", "attempt");
CREATE INDEX "payment_attempts_payment_id_created_at_idx"
  ON "payment_attempts"("payment_id", "created_at");

CREATE UNIQUE INDEX "payment_webhook_inbox_provider_event_key"
  ON "payment_webhook_inbox"("provider", "provider_event_id");
CREATE INDEX "payment_webhook_inbox_payment_id_received_at_idx"
  ON "payment_webhook_inbox"("payment_id", "received_at");

CREATE UNIQUE INDEX "refunds_payment_id_reason_key" ON "refunds"("payment_id", "reason");
CREATE INDEX "refunds_status_created_at_idx" ON "refunds"("status", "created_at");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The quote is referenced together with its session, so a payment can never be
-- attached to a price that belongs to somebody else's session.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_quote_id_fkey"
  FOREIGN KEY ("quote_id", "session_id") REFERENCES "price_quotes"("id", "session_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_webhook_inbox"
  ADD CONSTRAINT "payment_webhook_inbox_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A payment must be for exactly what the control plane quoted. Application
-- code checks this too, but the database is what makes it true for every
-- writer: a migration, a future admin tool, or a mistaken query included.
CREATE OR REPLACE FUNCTION "payments_assert_matches_quote"() RETURNS TRIGGER AS $$
DECLARE
  quoted RECORD;
BEGIN
  SELECT "total_minor", "currency", "currency_exponent", "settings_revision", "manifest_hash"
    INTO quoted
    FROM "price_quotes"
    WHERE "id" = NEW."quote_id" AND "session_id" = NEW."session_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a payment must reference a quote of its own session'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."amount_minor" IS DISTINCT FROM quoted."total_minor"
    OR NEW."currency" IS DISTINCT FROM quoted."currency"
    OR NEW."currency_exponent" IS DISTINCT FROM quoted."currency_exponent"
    OR NEW."settings_revision" IS DISTINCT FROM quoted."settings_revision"
    OR NEW."manifest_hash" IS DISTINCT FROM quoted."manifest_hash"
  THEN
    RAISE EXCEPTION 'a payment must equal its quote exactly'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payments_match_their_quote"
  BEFORE INSERT OR UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_assert_matches_quote"();

-- Payment state is monotonic. A late decline cannot overwrite a capture, and a
-- payment that never captured cannot be walked backwards into a live one.
-- A cancellation or a timeout may still be followed by a capture: those two
-- outcomes are ambiguous, money can still move afterwards, and the honest
-- record of that is a capture plus a compensation row.
CREATE OR REPLACE FUNCTION "payments_assert_status_progression"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'CAPTURED' THEN
    RAISE EXCEPTION 'a captured payment is final' USING ERRCODE = 'restrict_violation';
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

CREATE TRIGGER "payments_status_is_monotonic"
  BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_assert_status_progression"();

-- Attempts and received callbacks are evidence: written once and never
-- rewritten. Deletion is a different act — a payment lineage removed under the
-- retention schedule takes its evidence with it — so it stays possible and
-- remains governed by the foreign keys above.
CREATE OR REPLACE FUNCTION "payment_attempts_reject_update"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payment_attempts rows are append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_attempts_no_update"
  BEFORE UPDATE ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "payment_attempts_reject_update"();

CREATE OR REPLACE FUNCTION "payment_webhook_inbox_reject_replacement"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."provider_event_id" IS DISTINCT FROM OLD."provider_event_id"
    OR NEW."provider_intent_id" IS DISTINCT FROM OLD."provider_intent_id"
    OR NEW."payload_digest" IS DISTINCT FROM OLD."payload_digest"
    OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
    OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
  THEN
    RAISE EXCEPTION 'a received payment callback cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_webhook_inbox_immutable_evidence"
  BEFORE UPDATE ON "payment_webhook_inbox"
  FOR EACH ROW EXECUTE FUNCTION "payment_webhook_inbox_reject_replacement"();
