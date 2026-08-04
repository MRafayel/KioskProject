-- A successful non-empty print must include positive device evidence. This
-- complements the API contract and keeps a future write path from recording a
-- zero/unknown-sheet completion as success.
ALTER TABLE "print_jobs"
  DROP CONSTRAINT "print_jobs_outcome_consistency_check";

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
      AND "sheets_produced" > 0
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
