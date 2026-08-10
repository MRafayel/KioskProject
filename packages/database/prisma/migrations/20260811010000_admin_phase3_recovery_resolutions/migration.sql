-- Admin control plane, Phase 3: recording what a person saw at the tray.
--
-- `RECOVERY_REQUIRED` is the state this system was designed to hand to a human:
-- the device could not prove whether paper came out, and no amount of code will
-- settle that. This table is where the human answer goes.
--
-- Three properties are enforced here rather than only in the application,
-- because each of them is a way a compromised operator account could otherwise
-- cause a payout or hide a failure:
--
--   1. Only a job that is *already* in recovery can be resolved. An operator
--      resolves a state the system reached, they never put a job into it.
--   2. The observation is append-only and one per job. Somebody who could edit
--      their own account of a paid print could erase the evidence of one.
--   3. Whether money appears to be owed is derived from the outcome, not
--      submitted alongside it, so the two can never contradict each other.
--
-- What is deliberately absent: this table has no bearing on `refunds`. Creating
-- or settling a monetary obligation is `refund.authorize`, held by nobody who
-- holds `print.recovery.resolve` alone, and the database role that writes here
-- holds no privilege on the money tables at all.

CREATE TABLE "print_job_recovery_resolutions" (
  "id" UUID NOT NULL,
  "print_job_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(280) NOT NULL,
  "refund_suggested" BOOLEAN NOT NULL,
  "observed_sheets" INTEGER,
  "resolved_by_admin_id" UUID NOT NULL,
  "resolved_by_role" VARCHAR(24) NOT NULL,
  "request_digest" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "print_job_recovery_resolutions_pkey" PRIMARY KEY ("id")
);

-- One observation per job. This is the idempotency boundary for the whole
-- action: a double-submitted form, a retried request and a replayed one all
-- collide here, in the database, rather than depending on a record with a TTL.
CREATE UNIQUE INDEX "print_job_recovery_resolutions_print_job_id_key"
  ON "print_job_recovery_resolutions" ("print_job_id");

CREATE INDEX "print_job_recovery_resolutions_kiosk_id_created_at_idx"
  ON "print_job_recovery_resolutions" ("kiosk_id", "created_at");

-- The queue an Admin works from in the next phase: observations where a person
-- said money looks owed and nobody has acted yet.
CREATE INDEX "print_job_recovery_resolutions_refund_suggested_created_at_idx"
  ON "print_job_recovery_resolutions" ("refund_suggested", "created_at");

-- RESTRICT rather than CASCADE throughout. A job or a session that carries a
-- human observation cannot be deleted out from under it, and with the
-- append-only trigger below a cascade would fail confusingly instead of saying
-- what it meant. Nothing in this system deletes either row today: retention
-- scrubs a session's documents and keeps the session as a tombstone.
ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_print_job_id_fkey"
  FOREIGN KEY ("print_job_id") REFERENCES "print_jobs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_resolved_by_admin_id_fkey"
  FOREIGN KEY ("resolved_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- What an observation may say
-- ---------------------------------------------------------------------------

-- A closed vocabulary, and the money note derived from it. `UNRESOLVABLE` is a
-- first-class answer on purpose: an operator who cannot tell must be able to
-- say so, because the alternative is that they guess, and a guess recorded as
-- an observation is worse than no observation.
ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_outcome_check" CHECK (
    (
      "outcome" IN ('DELIVERED', 'UNRESOLVABLE')
      AND "refund_suggested" = FALSE
    )
    OR (
      "outcome" IN ('PARTIALLY_DELIVERED', 'NOT_DELIVERED')
      AND "refund_suggested" = TRUE
    )
  );

-- A reason is mandatory and must actually say something. "ok" is not an
-- account of why a paid print was closed, and this row may be the only record
-- of that decision by the time anybody asks.
ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_reason_check"
  CHECK (length(btrim("reason")) >= 8);

-- A count that contradicts the outcome would let one field be quoted against
-- the other later. Nothing came out means zero; something came out means more
-- than zero; nobody could tell means there is no count to give.
ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_observed_sheets_check" CHECK (
    "observed_sheets" IS NULL
    OR (
      "observed_sheets" >= 0
      AND ("outcome" <> 'NOT_DELIVERED' OR "observed_sheets" = 0)
      AND ("outcome" <> 'DELIVERED' OR "observed_sheets" > 0)
      AND "outcome" <> 'UNRESOLVABLE'
    )
  );

ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_request_digest_check"
  CHECK ("request_digest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "print_job_recovery_resolutions"
  ADD CONSTRAINT "print_job_recovery_resolutions_role_check"
  CHECK ("resolved_by_role" IN ('OPERATOR', 'ADMIN', 'TECHNICAL_ADMIN'));

-- ---------------------------------------------------------------------------
-- What an observation may be made against
-- ---------------------------------------------------------------------------

-- The eligibility rule, in the database.
--
-- The application re-reads the job inside the same transaction and refuses
-- anything that is not in recovery. This trigger is the reason that check
-- cannot be bypassed by a bug, a future endpoint, or anyone holding the write
-- role: a resolution for a QUEUED, PRINTING, COMPLETED, FAILED or CANCELED job
-- does not become a row.
--
-- It also pins the denormalized session and kiosk to the job's own. Those two
-- columns are what the read side scopes an Operator by, so a wrong value would
-- be a way to make another kiosk's work visible — or to hide one's own.
CREATE OR REPLACE FUNCTION "print_job_recovery_resolutions_assert_eligible"() RETURNS TRIGGER AS $$
DECLARE
  job RECORD;
BEGIN
  SELECT "status", "session_id", "kiosk_id"
    INTO job
    FROM "print_jobs"
   WHERE "id" = NEW."print_job_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a recovery resolution must name an existing print job'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF job."status" <> 'RECOVERY_REQUIRED' THEN
    RAISE EXCEPTION 'print job % is % and does not need recovery', NEW."print_job_id", job."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."session_id" <> job."session_id" OR NEW."kiosk_id" <> job."kiosk_id" THEN
    RAISE EXCEPTION 'a recovery resolution must be attributed to its own job''s session and kiosk'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_job_recovery_resolutions_eligible"
  BEFORE INSERT ON "print_job_recovery_resolutions"
  FOR EACH ROW EXECUTE FUNCTION "print_job_recovery_resolutions_assert_eligible"();

-- ---------------------------------------------------------------------------
-- Append-only
-- ---------------------------------------------------------------------------

-- Same rule as `audit_events`, for the same reason. This row is evidence about
-- money and about a customer who did or did not get what they paid for. An
-- account that could rewrite its own observation could launder a failure into a
-- success, or a success into a refund request.
--
-- Correcting a mistaken observation is therefore not an UPDATE by the person
-- who made it. It is a decision by somebody holding more authority, recorded as
-- its own fact — which is a later phase, and is the right shape for it.
CREATE OR REPLACE FUNCTION "print_job_recovery_resolutions_reject_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'print_job_recovery_resolutions is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "print_job_recovery_resolutions_no_update"
  BEFORE UPDATE ON "print_job_recovery_resolutions"
  FOR EACH ROW EXECUTE FUNCTION "print_job_recovery_resolutions_reject_rewrite"();

CREATE TRIGGER "print_job_recovery_resolutions_no_delete"
  BEFORE DELETE ON "print_job_recovery_resolutions"
  FOR EACH ROW EXECUTE FUNCTION "print_job_recovery_resolutions_reject_rewrite"();

CREATE TRIGGER "print_job_recovery_resolutions_no_truncate"
  BEFORE TRUNCATE ON "print_job_recovery_resolutions"
  FOR EACH STATEMENT EXECUTE FUNCTION "print_job_recovery_resolutions_reject_rewrite"();
