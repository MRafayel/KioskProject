-- Admin control plane, Phase 4: money, corrections, and asking retention again.
--
-- Phase 3 gave the control plane the ability to append one kind of fact: what a
-- person saw at the tray. This migration adds three more, and one of them costs
-- money, so most of what follows is about the difference between them.
--
--   print_job_recovery_corrections  a later account of a print, superseding an
--                                   earlier one. Appends; never edits.
--   refund_authorizations           why a refund exists, when a named person is
--                                   the reason it exists.
--   cleanup_retry_requests          a person asking retention to try again. The
--                                   worker acts; the control plane only asks.
--
-- The properties enforced here rather than only in the application, each of them
-- a way a compromised admin account could otherwise cause a payout or hide a
-- failure:
--
--   1. A correction cannot rewrite the observation it supersedes, and each
--      record can be superseded exactly once — so two people correcting the
--      same print collide in the database instead of overwriting each other.
--   2. A refund carrying the human reason code cannot exist without a recorded
--      authorization naming who decided it, checked at commit rather than at
--      insert, because the two rows are written in one transaction.
--   3. That refund cannot exceed what the payment actually captured, less
--      whatever is already owed on it, and cannot be denominated in a currency
--      the capture was not made in.
--   4. The database role that authorizes refunds cannot write any other kind of
--      refund — in particular not a LATE_CAPTURE one, which the payment path's
--      own capture-disposition trigger reads when it decides whether a capture
--      fulfilled a session.
--   5. A retry request cannot invent a dead-lettering that did not happen, and
--      is unique per dead-lettering rather than per run.
--
-- What is deliberately absent: nothing here grants anybody UPDATE on a print
-- job, a session, a payment, or a cleanup run. The control plane still cannot
-- change operational state. It appends facts, and other things read them.

-- ---------------------------------------------------------------------------
-- Correcting a recovery observation
-- ---------------------------------------------------------------------------

CREATE TABLE "print_job_recovery_corrections" (
  "id" UUID NOT NULL,
  "print_job_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "supersedes_id" UUID NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(280) NOT NULL,
  "refund_suggested" BOOLEAN NOT NULL,
  "observed_sheets" INTEGER,
  "corrected_by_admin_id" UUID NOT NULL,
  "corrected_by_role" VARCHAR(24) NOT NULL,
  "request_digest" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "print_job_recovery_corrections_pkey" PRIMARY KEY ("id")
);

-- Each record may be superseded exactly once. This is the whole concurrency
-- story: two admins looking at the same observation and correcting it at the
-- same moment both name the same predecessor, and the second one is refused by
-- the database rather than silently becoming the truth.
CREATE UNIQUE INDEX "print_job_recovery_corrections_supersedes_id_key"
  ON "print_job_recovery_corrections" ("supersedes_id");

CREATE INDEX "print_job_recovery_corrections_print_job_id_created_at_idx"
  ON "print_job_recovery_corrections" ("print_job_id", "created_at");

CREATE INDEX "print_job_recovery_corrections_kiosk_id_created_at_idx"
  ON "print_job_recovery_corrections" ("kiosk_id", "created_at");

ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_print_job_id_fkey"
  FOREIGN KEY ("print_job_id") REFERENCES "print_jobs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_corrected_by_admin_id_fkey"
  FOREIGN KEY ("corrected_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The same closed vocabulary and the same derived money note as the
-- observation it corrects. A correction that could say "delivered, and also
-- refund it" would be a way to ask an Admin to pay out on a print that worked.
ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_outcome_check" CHECK (
    (
      "outcome" IN ('DELIVERED', 'UNRESOLVABLE')
      AND "refund_suggested" = FALSE
    )
    OR (
      "outcome" IN ('PARTIALLY_DELIVERED', 'NOT_DELIVERED')
      AND "refund_suggested" = TRUE
    )
  );

ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_reason_check"
  CHECK (length(btrim("reason")) >= 8);

ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_observed_sheets_check" CHECK (
    "observed_sheets" IS NULL
    OR (
      "observed_sheets" >= 0
      AND ("outcome" <> 'NOT_DELIVERED' OR "observed_sheets" = 0)
      AND ("outcome" <> 'DELIVERED' OR "observed_sheets" > 0)
      AND "outcome" <> 'UNRESOLVABLE'
    )
  );

ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_request_digest_check"
  CHECK ("request_digest" ~ '^[0-9a-f]{64}$');

-- Corrections come from roles that do not record observations. Written as a
-- check constraint as well as a capability so that the separation survives a
-- future endpoint that forgets which capability it meant to require.
ALTER TABLE "print_job_recovery_corrections"
  ADD CONSTRAINT "print_job_recovery_corrections_role_check"
  CHECK ("corrected_by_role" IN ('ADMIN', 'TECHNICAL_ADMIN'));

-- What a correction may be made against.
--
-- `supersedes_id` names a row in one of two tables, so it cannot be a foreign
-- key. This trigger is that foreign key: the record being superseded must be
-- this job's own resolution, or a correction already made to this job. Without
-- it, a correction could be attached to another print's observation — which is
-- a way to make a refund look justified by evidence about a different customer.
CREATE OR REPLACE FUNCTION "print_job_recovery_corrections_assert_eligible"() RETURNS TRIGGER AS $$
DECLARE
  job RECORD;
  resolution_id UUID;
  supersedes_known BOOLEAN;
BEGIN
  SELECT "status", "session_id", "kiosk_id"
    INTO job
    FROM "print_jobs"
   WHERE "id" = NEW."print_job_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a recovery correction must name an existing print job'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The same eligibility rule as the observation. A job never leaves recovery —
  -- nothing in this system can move it out — so this is a statement that the
  -- correction is about the kind of print this workflow exists for.
  IF job."status" <> 'RECOVERY_REQUIRED' THEN
    RAISE EXCEPTION 'print job % is % and has no recovery to correct', NEW."print_job_id", job."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."session_id" <> job."session_id" OR NEW."kiosk_id" <> job."kiosk_id" THEN
    RAISE EXCEPTION 'a recovery correction must be attributed to its own job''s session and kiosk'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "id" INTO resolution_id
    FROM "print_job_recovery_resolutions"
   WHERE "print_job_id" = NEW."print_job_id";

  IF resolution_id IS NULL THEN
    RAISE EXCEPTION 'print job % has no recorded observation to correct', NEW."print_job_id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  supersedes_known := NEW."supersedes_id" = resolution_id
    OR EXISTS (
      SELECT 1 FROM "print_job_recovery_corrections"
       WHERE "id" = NEW."supersedes_id"
         AND "print_job_id" = NEW."print_job_id"
    );

  IF NOT supersedes_known THEN
    RAISE EXCEPTION 'a recovery correction must supersede this job''s own observation'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_job_recovery_corrections_eligible"
  BEFORE INSERT ON "print_job_recovery_corrections"
  FOR EACH ROW EXECUTE FUNCTION "print_job_recovery_corrections_assert_eligible"();

-- Append-only, for the same reason the observation is. A correction is evidence
-- about money and about a customer who did or did not get what they paid for.
-- Correcting a correction appends another row; nothing here is ever rewritten.
CREATE OR REPLACE FUNCTION "print_job_recovery_corrections_reject_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'print_job_recovery_corrections is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_job_recovery_corrections_no_update"
  BEFORE UPDATE ON "print_job_recovery_corrections"
  FOR EACH ROW EXECUTE FUNCTION "print_job_recovery_corrections_reject_rewrite"();

CREATE TRIGGER "print_job_recovery_corrections_no_delete"
  BEFORE DELETE ON "print_job_recovery_corrections"
  FOR EACH ROW EXECUTE FUNCTION "print_job_recovery_corrections_reject_rewrite"();

CREATE TRIGGER "print_job_recovery_corrections_no_truncate"
  BEFORE TRUNCATE ON "print_job_recovery_corrections"
  FOR EACH STATEMENT EXECUTE FUNCTION "print_job_recovery_corrections_reject_rewrite"();

-- ---------------------------------------------------------------------------
-- Authorizing a refund
-- ---------------------------------------------------------------------------

CREATE TABLE "refund_authorizations" (
  "id" UUID NOT NULL,
  "refund_id" UUID NOT NULL,
  "print_job_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" INTEGER NOT NULL,
  "reason" VARCHAR(280) NOT NULL,
  "observed_outcome" VARCHAR(32) NOT NULL,
  "observed_record_id" UUID NOT NULL,
  "authorized_by_admin_id" UUID NOT NULL,
  "authorized_by_role" VARCHAR(24) NOT NULL,
  "request_digest" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refund_authorizations_refund_id_key"
  ON "refund_authorizations" ("refund_id");

-- One authorized refund per print. The obligation's own UNIQUE (payment_id,
-- reason) says the same thing about the payment; this says it about the thing
-- the person was actually looking at, and it is the idempotency boundary for
-- the action.
CREATE UNIQUE INDEX "refund_authorizations_print_job_id_key"
  ON "refund_authorizations" ("print_job_id");

CREATE INDEX "refund_authorizations_created_at_idx"
  ON "refund_authorizations" ("created_at");

ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_refund_id_fkey"
  FOREIGN KEY ("refund_id") REFERENCES "refunds"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_print_job_id_fkey"
  FOREIGN KEY ("print_job_id") REFERENCES "print_jobs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_authorized_by_admin_id_fkey"
  FOREIGN KEY ("authorized_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_amount_check"
  CHECK ("amount_minor" > 0 AND "currency_exponent" >= 0);

ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_reason_check"
  CHECK (length(btrim("reason")) >= 8);

ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_request_digest_check"
  CHECK ("request_digest" ~ '^[0-9a-f]{64}$');

-- Money is Admin and above. Never the role that records observations: an
-- Operator who could both say "nothing came out" and pay for it is an Operator
-- who can pay themselves.
ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_role_check"
  CHECK ("authorized_by_role" IN ('ADMIN', 'TECHNICAL_ADMIN'));

-- The observation this decision rests on must be a real account of this print.
ALTER TABLE "refund_authorizations"
  ADD CONSTRAINT "refund_authorizations_observed_outcome_check"
  CHECK ("observed_outcome" IN ('DELIVERED', 'PARTIALLY_DELIVERED', 'NOT_DELIVERED', 'UNRESOLVABLE'));

-- Pin the authorization to the obligation it explains.
--
-- Every denormalized column here is read back later as evidence, so each one is
-- checked against the row it was copied from rather than trusted from the
-- caller. A wrong `payment_id` would make an audit trail point at somebody
-- else's money; a wrong `print_job_id` would make one customer's ruined print
-- the justification for another customer's refund.
CREATE OR REPLACE FUNCTION "refund_authorizations_assert_refund"() RETURNS TRIGGER AS $$
DECLARE
  obligation RECORD;
  job RECORD;
BEGIN
  SELECT "payment_id", "session_id", "amount_minor", "currency", "currency_exponent", "reason"
    INTO obligation
    FROM "refunds"
   WHERE "id" = NEW."refund_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a refund authorization must name an existing refund'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF obligation."reason" <> 'OPERATOR_REQUESTED' THEN
    RAISE EXCEPTION 'only an OPERATOR_REQUESTED refund is authorized by a person'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."payment_id" <> obligation."payment_id"
    OR NEW."session_id" <> obligation."session_id"
    OR NEW."amount_minor" <> obligation."amount_minor"
    OR NEW."currency" <> obligation."currency"
    OR NEW."currency_exponent" <> obligation."currency_exponent"
  THEN
    RAISE EXCEPTION 'a refund authorization must match the obligation it explains'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "session_id", "payment_id", "status" INTO job
    FROM "print_jobs"
   WHERE "id" = NEW."print_job_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a refund authorization must name an existing print job'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF job."session_id" <> NEW."session_id" OR job."payment_id" <> NEW."payment_id" THEN
    RAISE EXCEPTION 'a refund authorization must name the print the money paid for'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF job."status" <> 'RECOVERY_REQUIRED' THEN
    RAISE EXCEPTION 'print job % is % and owes nothing through recovery', NEW."print_job_id", job."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The evidence must exist and must be this print's. An authorization naming
  -- an observation nobody made is an authorization nobody can check.
  IF NOT EXISTS (
    SELECT 1 FROM "print_job_recovery_resolutions"
     WHERE "id" = NEW."observed_record_id" AND "print_job_id" = NEW."print_job_id"
  ) AND NOT EXISTS (
    SELECT 1 FROM "print_job_recovery_corrections"
     WHERE "id" = NEW."observed_record_id" AND "print_job_id" = NEW."print_job_id"
  ) THEN
    RAISE EXCEPTION 'a refund authorization must cite this job''s own observation'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_authorizations_match_refund"
  BEFORE INSERT ON "refund_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "refund_authorizations_assert_refund"();

CREATE OR REPLACE FUNCTION "refund_authorizations_reject_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'refund_authorizations is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refund_authorizations_no_update"
  BEFORE UPDATE ON "refund_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "refund_authorizations_reject_rewrite"();

CREATE TRIGGER "refund_authorizations_no_delete"
  BEFORE DELETE ON "refund_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "refund_authorizations_reject_rewrite"();

CREATE TRIGGER "refund_authorizations_no_truncate"
  BEFORE TRUNCATE ON "refund_authorizations"
  FOR EACH STATEMENT EXECUTE FUNCTION "refund_authorizations_reject_rewrite"();

-- ---------------------------------------------------------------------------
-- What the control plane may do to the money ledger
-- ---------------------------------------------------------------------------

-- The role that authorizes refunds may write exactly one kind of refund.
--
-- This matters more than it looks. `payments_assert_capture_disposition` reads
-- `refunds` for a LATE_CAPTURE row when it decides whether a capture fulfilled
-- its session, so a control plane able to choose the reason code would be a
-- control plane able to reach into that decision. It writes OPERATOR_REQUESTED
-- refunds or it writes nothing.
--
-- Written against the role name rather than against a session variable because
-- a connection cannot lie about who it authenticated as.
CREATE OR REPLACE FUNCTION "refunds_assert_admin_reason"() RETURNS TRIGGER AS $$
BEGIN
  IF current_user = 'printing_kiosk_admin_refund_writer' AND NEW."reason" <> 'OPERATOR_REQUESTED' THEN
    RAISE EXCEPTION 'the control plane may only record an OPERATOR_REQUESTED refund'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refunds_admin_reason"
  BEFORE INSERT OR UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "refunds_assert_admin_reason"();

-- What a person may authorize, in money terms.
--
-- Applied to the reason code rather than to the role, so it holds for anything
-- that ever writes one of these rows. A refund cannot exceed what was actually
-- captured less what is already owed on that payment, cannot be denominated in
-- a currency the capture was not made in, and cannot be raised against a
-- payment that never captured anything — there is nothing to give back.
--
-- The remaining race is narrow and worth stating: two transactions inserting
-- different reason codes against one payment can each pass this check and
-- together exceed the capture. The panel cannot cause it (UNIQUE (payment_id,
-- reason) permits it exactly one OPERATOR_REQUESTED row per payment), and the
-- resulting over-obligation is visible in the ledger rather than silent.
CREATE OR REPLACE FUNCTION "refunds_assert_recovery_bounds"() RETURNS TRIGGER AS $$
DECLARE
  captured RECORD;
  already_owed INTEGER;
BEGIN
  IF NEW."reason" <> 'OPERATOR_REQUESTED' THEN
    RETURN NEW;
  END IF;

  SELECT "status", "amount_minor", "currency", "currency_exponent"
    INTO captured
    FROM "payments"
   WHERE "id" = NEW."payment_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a refund must name an existing payment'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF captured."status" <> 'CAPTURED' THEN
    RAISE EXCEPTION 'payment % is % and has captured nothing to return', NEW."payment_id", captured."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."currency" <> captured."currency"
    OR NEW."currency_exponent" <> captured."currency_exponent"
  THEN
    RAISE EXCEPTION 'a refund must be denominated in the currency of its capture'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT COALESCE(SUM("amount_minor"), 0)
    INTO already_owed
    FROM "refunds"
   WHERE "payment_id" = NEW."payment_id" AND "id" <> NEW."id";

  IF NEW."amount_minor" <= 0 OR NEW."amount_minor" + already_owed > captured."amount_minor" THEN
    RAISE EXCEPTION 'a refund of % would exceed the % captured on payment %',
      NEW."amount_minor", captured."amount_minor", NEW."payment_id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "refunds_recovery_bounds"
  BEFORE INSERT OR UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "refunds_assert_recovery_bounds"();

-- A refund a person authorized cannot exist without the record of who did.
--
-- Deferred to the end of the transaction because the obligation and its
-- authorization are written together and the obligation goes first — it has to,
-- since the authorization references it. At COMMIT there is no ordering left to
-- excuse a missing row, so this is the point at which the question "who
-- authorized this payout" is guaranteed to have an answer.
CREATE OR REPLACE FUNCTION "refunds_require_recorded_authorization"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."reason" <> 'OPERATOR_REQUESTED' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "refund_authorizations" WHERE "refund_id" = NEW."id") THEN
    RAISE EXCEPTION 'an OPERATOR_REQUESTED refund must record who authorized it'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "refunds_authorization_recorded"
  AFTER INSERT ON "refunds"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "refunds_require_recorded_authorization"();

-- ---------------------------------------------------------------------------
-- Asking retention to try again
-- ---------------------------------------------------------------------------

CREATE TABLE "cleanup_retry_requests" (
  "id" UUID NOT NULL,
  "cleanup_run_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "dead_lettered_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL,
  "last_error_code" VARCHAR(80),
  "reason" VARCHAR(280) NOT NULL,
  "requested_by_admin_id" UUID NOT NULL,
  "requested_by_role" VARCHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cleanup_retry_requests_pkey" PRIMARY KEY ("id")
);

-- One request per dead-lettering, not per run. A request answers one specific
-- failure: re-arming consumes it by making the run's status no longer
-- DEAD_LETTER, and a run that fails its way back to dead-lettered carries a new
-- timestamp and needs a new decision from a person.
CREATE UNIQUE INDEX "cleanup_retry_requests_run_dead_lettered_at_key"
  ON "cleanup_retry_requests" ("cleanup_run_id", "dead_lettered_at");

CREATE INDEX "cleanup_retry_requests_created_at_idx"
  ON "cleanup_retry_requests" ("created_at");

ALTER TABLE "cleanup_retry_requests"
  ADD CONSTRAINT "cleanup_retry_requests_cleanup_run_id_fkey"
  FOREIGN KEY ("cleanup_run_id") REFERENCES "cleanup_runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cleanup_retry_requests"
  ADD CONSTRAINT "cleanup_retry_requests_requested_by_admin_id_fkey"
  FOREIGN KEY ("requested_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cleanup_retry_requests"
  ADD CONSTRAINT "cleanup_retry_requests_reason_check"
  CHECK (length(btrim("reason")) >= 8);

ALTER TABLE "cleanup_retry_requests"
  ADD CONSTRAINT "cleanup_retry_requests_attempts_check"
  CHECK ("attempts" >= 0);

ALTER TABLE "cleanup_retry_requests"
  ADD CONSTRAINT "cleanup_retry_requests_role_check"
  CHECK ("requested_by_role" IN ('ADMIN', 'TECHNICAL_ADMIN'));

-- A retry request cannot invent a failure that did not happen.
--
-- The run must actually be dead-lettered right now, and every denormalized
-- column is pinned to the run's own. Without this, the unique index could be
-- defeated by submitting a made-up timestamp, and the audit trail would record
-- a decision about a failure nobody had.
CREATE OR REPLACE FUNCTION "cleanup_retry_requests_assert_dead_lettered"() RETURNS TRIGGER AS $$
DECLARE
  run RECORD;
BEGIN
  SELECT "session_id", "status", "attempts", "last_error_code", "dead_lettered_at"
    INTO run
    FROM "cleanup_runs"
   WHERE "id" = NEW."cleanup_run_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a retention retry must name an existing cleanup run'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF run."status" <> 'DEAD_LETTER' OR run."dead_lettered_at" IS NULL THEN
    RAISE EXCEPTION 'cleanup run % is % and has not given up', NEW."cleanup_run_id", run."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."session_id" <> run."session_id"
    OR NEW."dead_lettered_at" <> run."dead_lettered_at"
    OR NEW."attempts" <> run."attempts"
    OR NEW."last_error_code" IS DISTINCT FROM run."last_error_code"
  THEN
    RAISE EXCEPTION 'a retention retry must describe the failure it answers'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cleanup_retry_requests_dead_lettered"
  BEFORE INSERT ON "cleanup_retry_requests"
  FOR EACH ROW EXECUTE FUNCTION "cleanup_retry_requests_assert_dead_lettered"();

CREATE OR REPLACE FUNCTION "cleanup_retry_requests_reject_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'cleanup_retry_requests is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cleanup_retry_requests_no_update"
  BEFORE UPDATE ON "cleanup_retry_requests"
  FOR EACH ROW EXECUTE FUNCTION "cleanup_retry_requests_reject_rewrite"();

CREATE TRIGGER "cleanup_retry_requests_no_delete"
  BEFORE DELETE ON "cleanup_retry_requests"
  FOR EACH ROW EXECUTE FUNCTION "cleanup_retry_requests_reject_rewrite"();

CREATE TRIGGER "cleanup_retry_requests_no_truncate"
  BEFORE TRUNCATE ON "cleanup_retry_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "cleanup_retry_requests_reject_rewrite"();
