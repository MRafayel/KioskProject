-- Software paper inventory for kiosks without a tray-level sensor.
--
-- The ledger is the inventory. Refills and corrections are human facts;
-- deductions are written only beside a confirmed print completion. Summing the
-- signed deltas yields the current estimate, while quantity_sheets preserves
-- the physical quantity involved even when the estimate was unavailable or
-- had already reached zero.

CREATE TABLE "kiosk_paper_events" (
  "id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "type" VARCHAR(24) NOT NULL,
  "quantity_sheets" INTEGER NOT NULL,
  "delta_sheets" INTEGER NOT NULL,
  "estimate_affected" BOOLEAN NOT NULL DEFAULT TRUE,
  "reason" VARCHAR(280),
  "print_job_id" UUID,
  "recorded_by_admin_id" UUID,
  "recorded_by_role" VARCHAR(24),
  "actor_type" VARCHAR(32) NOT NULL,
  "actor_id" VARCHAR(100) NOT NULL,
  "request_key" UUID,
  "request_digest" VARCHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "kiosk_paper_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kiosk_paper_events_print_job_id_key"
  ON "kiosk_paper_events" ("print_job_id");
CREATE UNIQUE INDEX "kiosk_paper_events_request_key_key"
  ON "kiosk_paper_events" ("request_key");
CREATE INDEX "kiosk_paper_events_kiosk_id_created_at_idx"
  ON "kiosk_paper_events" ("kiosk_id", "created_at");
CREATE INDEX "kiosk_paper_events_type_created_at_idx"
  ON "kiosk_paper_events" ("type", "created_at");

ALTER TABLE "kiosk_paper_events"
  ADD CONSTRAINT "kiosk_paper_events_kiosk_id_fkey"
  FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kiosk_paper_events"
  ADD CONSTRAINT "kiosk_paper_events_print_job_id_fkey"
  FOREIGN KEY ("print_job_id") REFERENCES "print_jobs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kiosk_paper_events"
  ADD CONSTRAINT "kiosk_paper_events_recorded_by_admin_id_fkey"
  FOREIGN KEY ("recorded_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Closed shapes for the three kinds of event. A manual request is attributable
-- and idempotent; an automatic deduction is attributable to the accepted print
-- result and uses that job as its idempotency key.
ALTER TABLE "kiosk_paper_events"
  ADD CONSTRAINT "kiosk_paper_events_shape_check" CHECK (
    (
      "type" = 'REFILL'
      AND "quantity_sheets" BETWEEN 1 AND 100000
      AND "delta_sheets" = "quantity_sheets"
      AND "estimate_affected" = TRUE
      AND "print_job_id" IS NULL
      AND "recorded_by_admin_id" IS NOT NULL
      AND "recorded_by_role" IS NOT NULL
      AND "recorded_by_role" IN ('OPERATOR', 'ADMIN', 'TECHNICAL_ADMIN')
      AND "actor_type" = 'ADMIN_USER'
      AND "actor_id" = "recorded_by_admin_id"::text
      AND "request_key" IS NOT NULL
      AND "request_digest" IS NOT NULL
      AND "request_digest" ~ '^[0-9a-f]{64}$'
      AND ("reason" IS NULL OR length(btrim("reason")) >= 3)
    )
    OR
    (
      "type" = 'CORRECTION'
      AND "quantity_sheets" BETWEEN 0 AND 100000
      AND "delta_sheets" BETWEEN -100000 AND 100000
      AND "estimate_affected" = TRUE
      AND "print_job_id" IS NULL
      AND "recorded_by_admin_id" IS NOT NULL
      AND "recorded_by_role" IS NOT NULL
      AND "recorded_by_role" IN ('OPERATOR', 'ADMIN', 'TECHNICAL_ADMIN')
      AND "actor_type" = 'ADMIN_USER'
      AND "actor_id" = "recorded_by_admin_id"::text
      AND "request_key" IS NOT NULL
      AND "request_digest" IS NOT NULL
      AND "request_digest" ~ '^[0-9a-f]{64}$'
      AND "reason" IS NOT NULL
      AND length(btrim("reason")) >= 3
    )
    OR
    (
      "type" = 'PRINT_DEDUCTION'
      AND "quantity_sheets" BETWEEN 1 AND 1000000
      AND "delta_sheets" <= 0
      AND "delta_sheets" >= -"quantity_sheets"
      AND ("estimate_affected" = TRUE OR "delta_sheets" = 0)
      AND "reason" IS NULL
      AND "print_job_id" IS NOT NULL
      AND "recorded_by_admin_id" IS NULL
      AND "recorded_by_role" IS NULL
      AND "actor_type" = 'KIOSK_AGENT'
      AND length("actor_id") > 0
      AND "request_key" IS NULL
      AND "request_digest" IS NULL
    )
  );

-- Serialize inventory changes per kiosk and derive their signed deltas while
-- holding that lock. Two printers completing at the same kiosk, or a refill
-- racing a completion, must not both calculate from the same old balance.
--
-- For print deductions this also verifies the same kiosk and physical-sheet
-- count against a confirmed completed job. It is the database backstop against
-- consuming stock on submission, failure, cancellation, or ambiguity.
CREATE OR REPLACE FUNCTION "kiosk_paper_events_prepare"() RETURNS TRIGGER AS $$
DECLARE
  job RECORD;
  initialized BOOLEAN;
  current_estimate INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('kiosk-paper:' || NEW."kiosk_id", 0));

  SELECT EXISTS (
    SELECT 1
      FROM "kiosk_paper_events"
     WHERE "kiosk_id" = NEW."kiosk_id"
       AND "type" IN ('REFILL', 'CORRECTION')
  ), COALESCE(SUM("delta_sheets"), 0)
    INTO initialized, current_estimate
    FROM "kiosk_paper_events"
   WHERE "kiosk_id" = NEW."kiosk_id";

  current_estimate := GREATEST(0, current_estimate);

  IF NEW."type" = 'REFILL' THEN
    IF current_estimate + NEW."quantity_sheets" > 100000 THEN
      RAISE EXCEPTION 'paper estimate cannot exceed 100000 sheets'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."delta_sheets" := NEW."quantity_sheets";
    NEW."estimate_affected" := TRUE;
    RETURN NEW;
  END IF;

  IF NEW."type" = 'CORRECTION' THEN
    NEW."delta_sheets" := NEW."quantity_sheets" - current_estimate;
    NEW."estimate_affected" := TRUE;
    RETURN NEW;
  END IF;

  SELECT "kiosk_id", "status", "result_confidence", "sheets_produced"
    INTO job
    FROM "print_jobs"
   WHERE "id" = NEW."print_job_id";

  IF NOT FOUND
     OR job."kiosk_id" <> NEW."kiosk_id"
     OR job."status" <> 'COMPLETED'
     OR job."result_confidence" <> 'CONFIRMED'
     OR job."sheets_produced" IS NULL
     OR job."sheets_produced" <> NEW."quantity_sheets" THEN
    RAISE EXCEPTION 'paper may only be deducted for its own confirmed completed print'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF initialized THEN
    NEW."delta_sheets" := -LEAST(current_estimate, NEW."quantity_sheets");
    NEW."estimate_affected" := TRUE;
  ELSE
    NEW."delta_sheets" := 0;
    NEW."estimate_affected" := FALSE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "kiosk_paper_events_prepare_insert"
  BEFORE INSERT ON "kiosk_paper_events"
  FOR EACH ROW EXECUTE FUNCTION "kiosk_paper_events_prepare"();

-- Inventory history is evidence. Corrections append a new event; they never
-- edit the refill or print deduction that was originally recorded.
CREATE OR REPLACE FUNCTION "kiosk_paper_events_reject_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'kiosk_paper_events is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "kiosk_paper_events_no_update"
  BEFORE UPDATE ON "kiosk_paper_events"
  FOR EACH ROW EXECUTE FUNCTION "kiosk_paper_events_reject_rewrite"();

CREATE TRIGGER "kiosk_paper_events_no_delete"
  BEFORE DELETE ON "kiosk_paper_events"
  FOR EACH ROW EXECUTE FUNCTION "kiosk_paper_events_reject_rewrite"();

CREATE TRIGGER "kiosk_paper_events_no_truncate"
  BEFORE TRUNCATE ON "kiosk_paper_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "kiosk_paper_events_reject_rewrite"();
