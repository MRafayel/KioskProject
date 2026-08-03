-- Phase 8 adds virtual printing: the immutable job snapshot built from a
-- capture, the append-only ledger of what the device said about it, and the
-- durable command queue a kiosk agent leases over its own outbound connection.
-- Every addition is additive; a session written before this migration simply
-- has no print job.

CREATE TABLE "print_jobs" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "quote_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "settings_revision" INTEGER NOT NULL,
  "settings_manifest_hash" VARCHAR(64) NOT NULL,
  -- The immutable print manifest. It is written once and hashed; the device,
  -- the ledger and any later audit all read exactly these bytes.
  "job_manifest" JSONB NOT NULL,
  "job_manifest_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "result_confidence" VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  "failure_code" VARCHAR(48),
  "warning_code" VARCHAR(32),
  -- Development only. Configuration refuses the scenario control in
  -- production, so a production row can only ever hold NULL here.
  "simulated_outcome" VARCHAR(32),
  "copies" INTEGER NOT NULL,
  "printed_sides" INTEGER NOT NULL,
  "physical_sheets" INTEGER NOT NULL,
  "sheets_produced" INTEGER,
  "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadline_at" TIMESTAMPTZ NOT NULL,
  "cancel_requested_at" TIMESTAMPTZ,
  "created_by_actor_type" VARCHAR(32) NOT NULL,
  "created_by_actor_id" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatched_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "failed_at" TIMESTAMPTZ,
  CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "print_jobs_status_check" CHECK (
    "status" IN ('QUEUED', 'DISPATCHED', 'PRINTING', 'COMPLETED', 'FAILED', 'CANCELED',
                 'RECOVERY_REQUIRED')
  ),
  CONSTRAINT "print_jobs_confidence_check"
    CHECK ("result_confidence" IN ('UNKNOWN', 'CONFIRMED', 'UNCONFIRMED')),
  CONSTRAINT "print_jobs_manifest_hash_check" CHECK ("job_manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "print_jobs_settings_hash_check"
    CHECK ("settings_manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "print_jobs_counts_check" CHECK (
    "settings_revision" > 0 AND "copies" > 0 AND "printed_sides" > 0 AND "physical_sheets" > 0
    AND "dispatch_attempts" >= 0
  ),
  -- A device cannot produce more sheets than the job describes.
  CONSTRAINT "print_jobs_sheets_produced_check" CHECK (
    "sheets_produced" IS NULL
    OR ("sheets_produced" >= 0 AND "sheets_produced" <= "physical_sheets")
  ),
  CONSTRAINT "print_jobs_window_check" CHECK ("deadline_at" > "created_at"),
  CONSTRAINT "print_jobs_simulated_outcome_check" CHECK (
    "simulated_outcome" IS NULL
    OR "simulated_outcome" IN ('SUCCESS', 'WARNING', 'OFFLINE', 'PAPER_JAM', 'OUT_OF_PAPER',
                               'CANCELED', 'TIMEOUT', 'UNKNOWN_AFTER_SUBMIT')
  ),
  -- A completed job that cannot say how confident it is would be a success
  -- nobody can audit; a failure without a reason would be the same.
  CONSTRAINT "print_jobs_completed_check" CHECK (
    "status" <> 'COMPLETED'
    OR ("completed_at" IS NOT NULL AND "result_confidence" <> 'UNKNOWN')
  ),
  CONSTRAINT "print_jobs_failed_check" CHECK (
    "status" NOT IN ('FAILED', 'CANCELED', 'RECOVERY_REQUIRED')
    OR ("failed_at" IS NOT NULL AND "failure_code" IS NOT NULL)
  )
);

CREATE TABLE "print_job_events" (
  "id" UUID NOT NULL,
  "print_job_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" VARCHAR(32) NOT NULL,
  "operation_id" UUID,
  "status" VARCHAR(24) NOT NULL,
  "confidence" VARCHAR(16),
  "failure_code" VARCHAR(48),
  "warning_code" VARCHAR(32),
  "detail" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "print_job_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "print_job_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "print_job_events_type_check" CHECK (
    "type" IN ('CREATED', 'DISPATCHED', 'CLAIMED', 'SUBMITTED', 'PROGRESS', 'COMPLETED',
               'FAILED', 'CANCEL_REQUESTED', 'CANCELED', 'RECOVERY_REQUIRED',
               'LEASE_EXPIRED', 'DEADLINE_EXCEEDED')
  ),
  CONSTRAINT "print_job_events_confidence_check"
    CHECK ("confidence" IS NULL OR "confidence" IN ('UNKNOWN', 'CONFIRMED', 'UNCONFIRMED'))
);

CREATE TABLE "agent_commands" (
  "id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "session_id" UUID,
  "print_job_id" UUID,
  -- The unique operation identifier the device is given. It is stable across
  -- every redelivery, so a device that already saw it can recognise it rather
  -- than printing a second copy.
  "operation_id" UUID NOT NULL,
  "type" VARCHAR(32) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claim_token" UUID,
  "claimed_at" TIMESTAMPTZ,
  "lease_expires_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "result_code" VARCHAR(48),
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_commands_type_check" CHECK ("type" IN ('PRINT')),
  CONSTRAINT "agent_commands_status_check"
    CHECK ("status" IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'EXPIRED')),
  CONSTRAINT "agent_commands_attempts_check" CHECK ("attempts" >= 0),
  -- A claimed command holds a lease and a token together, or neither.
  CONSTRAINT "agent_commands_lease_check" CHECK (
    ("status" = 'CLAIMED') = ("claim_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  ),
  CONSTRAINT "agent_commands_print_check"
    CHECK ("type" <> 'PRINT' OR ("print_job_id" IS NOT NULL AND "session_id" IS NOT NULL))
);

-- One print job per session. A paid session produces one logical output, and
-- the database is what makes that true rather than application code alone. A
-- future operator-driven reprint has to relax this deliberately.
CREATE UNIQUE INDEX "print_jobs_one_per_session_idx" ON "print_jobs"("session_id");
CREATE INDEX "print_jobs_status_available_at_idx" ON "print_jobs"("status", "available_at");
CREATE INDEX "print_jobs_status_deadline_at_idx" ON "print_jobs"("status", "deadline_at");
CREATE INDEX "print_jobs_kiosk_id_created_at_idx" ON "print_jobs"("kiosk_id", "created_at");

CREATE UNIQUE INDEX "print_job_events_print_job_id_sequence_key"
  ON "print_job_events"("print_job_id", "sequence");
CREATE INDEX "print_job_events_print_job_id_created_at_idx"
  ON "print_job_events"("print_job_id", "created_at");

CREATE UNIQUE INDEX "agent_commands_operation_id_key" ON "agent_commands"("operation_id");
CREATE UNIQUE INDEX "agent_commands_claim_token_key" ON "agent_commands"("claim_token");
-- One command per print job, ever. A redelivery re-leases this row; it never
-- creates a second operation the device could mistake for new work.
CREATE UNIQUE INDEX "agent_commands_one_per_print_job_idx"
  ON "agent_commands"("print_job_id") WHERE "print_job_id" IS NOT NULL;
CREATE INDEX "agent_commands_kiosk_id_status_available_at_idx"
  ON "agent_commands"("kiosk_id", "status", "available_at");
CREATE INDEX "agent_commands_status_lease_expires_at_idx" ON "agent_commands"("status", "lease_expires_at");

ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_kiosk_id_fkey"
  FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The payment is referenced together with its session, so a job can never be
-- attached to money that paid for somebody else's documents.
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_payment_id_session_id_fkey"
  FOREIGN KEY ("payment_id", "session_id") REFERENCES "payments"("id", "session_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_quote_id_session_id_fkey"
  FOREIGN KEY ("quote_id", "session_id") REFERENCES "price_quotes"("id", "session_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- The settings revision the job prints cannot be removed while the job refers
-- to it, and it must belong to the same session.
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_session_id_settings_revision_fkey"
  FOREIGN KEY ("session_id", "settings_revision")
  REFERENCES "print_setting_revisions"("session_id", "revision")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "print_job_events"
  ADD CONSTRAINT "print_job_events_print_job_id_fkey"
  FOREIGN KEY ("print_job_id") REFERENCES "print_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_commands"
  ADD CONSTRAINT "agent_commands_kiosk_id_fkey"
  FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_commands"
  ADD CONSTRAINT "agent_commands_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_commands"
  ADD CONSTRAINT "agent_commands_print_job_id_fkey"
  FOREIGN KEY ("print_job_id") REFERENCES "print_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a capture that actually paid for these exact settings may print.
-- Application code checks this too, but the database is what makes it true for
-- every writer: a migration, a future admin tool, or a mistaken query included.
CREATE OR REPLACE FUNCTION "print_jobs_assert_paid"() RETURNS TRIGGER AS $$
DECLARE
  paid RECORD;
  owner RECORD;
BEGIN
  SELECT "status", "applied_to_session", "quote_id", "settings_revision", "manifest_hash"
    INTO paid
    FROM "payments"
    WHERE "id" = NEW."payment_id" AND "session_id" = NEW."session_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a print job must reference a payment of its own session'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF paid."status" <> 'CAPTURED' OR paid."applied_to_session" IS NOT TRUE THEN
    RAISE EXCEPTION 'a print job requires a capture applied to its session'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."quote_id" IS DISTINCT FROM paid."quote_id"
    OR NEW."settings_revision" IS DISTINCT FROM paid."settings_revision"
    OR NEW."settings_manifest_hash" IS DISTINCT FROM paid."manifest_hash"
  THEN
    RAISE EXCEPTION 'a print job must print exactly what was paid for'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "kiosk_id", "state" INTO owner
    FROM "print_sessions" WHERE "id" = NEW."session_id";
  IF NOT FOUND OR owner."kiosk_id" IS DISTINCT FROM NEW."kiosk_id" THEN
    RAISE EXCEPTION 'a print job must belong to its session''s kiosk'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF owner."state" NOT IN ('PAID', 'PRINTING') THEN
    RAISE EXCEPTION 'a print job may only be created for a paid session'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_jobs_require_capture"
  BEFORE INSERT ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION "print_jobs_assert_paid"();

-- The snapshot is immutable. What a job prints is decided once, at creation,
-- from a settings revision that was already paid for.
CREATE OR REPLACE FUNCTION "print_jobs_assert_immutable_snapshot"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."kiosk_id" IS DISTINCT FROM OLD."kiosk_id"
    OR NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
    OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
    OR NEW."settings_revision" IS DISTINCT FROM OLD."settings_revision"
    OR NEW."settings_manifest_hash" IS DISTINCT FROM OLD."settings_manifest_hash"
    OR NEW."job_manifest"::text IS DISTINCT FROM OLD."job_manifest"::text
    OR NEW."job_manifest_hash" IS DISTINCT FROM OLD."job_manifest_hash"
    OR NEW."copies" IS DISTINCT FROM OLD."copies"
    OR NEW."printed_sides" IS DISTINCT FROM OLD."printed_sides"
    OR NEW."physical_sheets" IS DISTINCT FROM OLD."physical_sheets"
    OR NEW."deadline_at" IS DISTINCT FROM OLD."deadline_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'a print job snapshot cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_jobs_immutable_snapshot"
  BEFORE UPDATE ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION "print_jobs_assert_immutable_snapshot"();

-- Print job state only ever moves forwards, and every terminal state is final.
-- A blind retry after an ambiguous submission is exactly what this refuses:
-- RECOVERY_REQUIRED cannot become COMPLETED because nobody can prove it.
CREATE OR REPLACE FUNCTION "print_jobs_assert_status_progression"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED') THEN
    RAISE EXCEPTION 'a settled print job is final' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'QUEUED'
    OR (OLD."status" = 'PRINTING' AND NEW."status" = 'DISPATCHED')
  THEN
    RAISE EXCEPTION 'a print job cannot move backwards' USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_jobs_status_is_monotonic"
  BEFORE UPDATE ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION "print_jobs_assert_status_progression"();

-- The ledger is evidence: written once and never rewritten. Deletion stays
-- governed by the foreign key so Phase 9 retention can remove a lineage whole.
CREATE OR REPLACE FUNCTION "print_job_events_reject_update"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'print_job_events rows are append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_job_events_no_update"
  BEFORE UPDATE ON "print_job_events"
  FOR EACH ROW EXECUTE FUNCTION "print_job_events_reject_update"();

-- What a command asks the device to do cannot change after it was issued. Only
-- its lease and its outcome move.
CREATE OR REPLACE FUNCTION "agent_commands_assert_immutable_body"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."kiosk_id" IS DISTINCT FROM OLD."kiosk_id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."print_job_id" IS DISTINCT FROM OLD."print_job_id"
    OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."payload"::text IS DISTINCT FROM OLD."payload"::text
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'an issued agent command cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" IN ('COMPLETED', 'FAILED', 'EXPIRED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'a settled agent command is final' USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_commands_immutable_body"
  BEFORE UPDATE ON "agent_commands"
  FOR EACH ROW EXECUTE FUNCTION "agent_commands_assert_immutable_body"();
