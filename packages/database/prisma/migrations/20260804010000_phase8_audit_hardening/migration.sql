-- Phase 8 audit hardening. Existing Phase 8 databases may already contain a
-- live lease that was extended beyond its command deadline; clamp it before the
-- invariant is installed so the migration is safe to deploy in place.
UPDATE "agent_commands"
SET "lease_expires_at" = "expires_at", "updated_at" = CURRENT_TIMESTAMP
WHERE "lease_expires_at" > "expires_at";

ALTER TABLE "agent_commands"
  ADD CONSTRAINT "agent_commands_lease_within_deadline_check"
  CHECK ("lease_expires_at" IS NULL OR "lease_expires_at" <= "expires_at");

-- The state, confidence, timestamps and sheet count describe one outcome. A
-- contradictory row could otherwise be interpreted as either a success or a
-- refund depending on which column a later reader trusted.
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_outcome_consistency_check" CHECK (
    (
      "status" IN ('QUEUED', 'DISPATCHED', 'PRINTING')
      AND "result_confidence" = 'UNKNOWN'
      AND "failure_code" IS NULL
      AND "sheets_produced" IS NULL
      AND "completed_at" IS NULL
      AND "failed_at" IS NULL
    )
    OR (
      "status" = 'COMPLETED'
      AND "result_confidence" = 'CONFIRMED'
      AND "failure_code" IS NULL
      AND "completed_at" IS NOT NULL
      AND "failed_at" IS NULL
    )
    OR (
      "status" IN ('FAILED', 'CANCELED')
      AND "result_confidence" = 'CONFIRMED'
      AND "failure_code" IS NOT NULL
      AND "sheets_produced" = 0
      AND "completed_at" IS NULL
      AND "failed_at" IS NOT NULL
    )
    OR (
      "status" = 'RECOVERY_REQUIRED'
      AND "result_confidence" = 'UNCONFIRMED'
      AND "failure_code" IS NOT NULL
      AND "completed_at" IS NULL
      AND "failed_at" IS NOT NULL
    )
  );

-- Idempotency responses are durable storage, not a general JSON cache. Keep the
-- print replay body to the same public snapshot allowlist returned by the API,
-- so a later application mistake cannot persist a manifest, object key, device
-- payload or payment-provider detail in this table.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_print_response_sanitized_check" CHECK (
    "action" NOT LIKE 'print-jobs.%'
    OR (
      jsonb_typeof("response_body") = 'object'
      AND ("response_body" - 'printJob') = '{}'::jsonb
      AND jsonb_typeof("response_body" -> 'printJob') = 'object'
      AND ("response_body" -> 'printJob') ?& ARRAY[
        'id', 'sessionId', 'quoteId', 'paymentId', 'settingsRevision', 'status',
        'resultConfidence', 'failureCode', 'warningCode', 'copies', 'printedSides',
        'physicalSheets', 'sheetsProduced', 'createdAt', 'deadlineAt', 'completedAt'
      ]::text[]
      AND (("response_body" -> 'printJob') - ARRAY[
        'id', 'sessionId', 'quoteId', 'paymentId', 'settingsRevision', 'status',
        'resultConfidence', 'failureCode', 'warningCode', 'copies', 'printedSides',
        'physicalSheets', 'sheetsProduced', 'createdAt', 'deadlineAt', 'completedAt'
      ]::text[]) = '{}'::jsonb
    )
  );

-- The simulated device outcome and creator are part of the provenance of an
-- immutable print snapshot. They were omitted from the original trigger even
-- though changing either would rewrite what was issued or who issued it.
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
    OR NEW."simulated_outcome" IS DISTINCT FROM OLD."simulated_outcome"
    OR NEW."copies" IS DISTINCT FROM OLD."copies"
    OR NEW."printed_sides" IS DISTINCT FROM OLD."printed_sides"
    OR NEW."physical_sheets" IS DISTINCT FROM OLD."physical_sheets"
    OR NEW."deadline_at" IS DISTINCT FROM OLD."deadline_at"
    OR NEW."created_by_actor_type" IS DISTINCT FROM OLD."created_by_actor_type"
    OR NEW."created_by_actor_id" IS DISTINCT FROM OLD."created_by_actor_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'a print job snapshot cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A command deadline is part of its issued body. Extending it later could
-- authorize output after the job that paid for it had already been settled.
CREATE OR REPLACE FUNCTION "agent_commands_assert_immutable_body"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."kiosk_id" IS DISTINCT FROM OLD."kiosk_id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."print_job_id" IS DISTINCT FROM OLD."print_job_id"
    OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."payload"::text IS DISTINCT FROM OLD."payload"::text
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
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
