-- A provider can capture an old timed-out or canceled intent after a retry has
-- already paid the session. Both captures must remain in the accounting
-- ledger, while only the one that actually moved the session to PAID is a
-- fulfillment. The original Phase 7 index represented both concepts with the
-- status alone and therefore made the second (late) capture impossible to
-- record.

ALTER TABLE "payments"
  ADD COLUMN "applied_to_session" BOOLEAN NOT NULL DEFAULT false;

-- Before this distinction existed, the only captures that could be applied
-- were those without a late-capture compensation record. Preserve that meaning
-- for an already-upgraded development database.
UPDATE "payments" AS payment
SET "applied_to_session" = true
WHERE payment."status" = 'CAPTURED'
  AND NOT EXISTS (
    SELECT 1
    FROM "refunds" AS refund
    WHERE refund."payment_id" = payment."id"
      AND refund."reason" = 'LATE_CAPTURE'
  );

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_application_requires_capture_check"
  CHECK (NOT "applied_to_session" OR "status" = 'CAPTURED');

DROP INDEX "payments_one_capture_per_session_idx";

-- More than one provider capture can exist, but at most one is allowed to
-- fulfill the session. Late captures remain unapplied and carry a refund
-- obligation.
CREATE UNIQUE INDEX "payments_one_applied_capture_per_session_idx"
  ON "payments"("session_id") WHERE "applied_to_session" = true;
