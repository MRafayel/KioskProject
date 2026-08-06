-- FAILED and RECOVERY_REQUIRED are terminal states in the session service and
-- retention workflow. Keep the database's one-active-session guard aligned so
-- either outcome releases the kiosk for its next customer.
DROP INDEX "print_sessions_one_active_per_kiosk_idx";

CREATE UNIQUE INDEX "print_sessions_one_active_per_kiosk_idx"
  ON "print_sessions"("kiosk_id")
  WHERE "state" NOT IN (
    'COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED'
  );
