-- Older Phase 9 application instances scheduled file deletion immediately
-- even when the owning terminal session still had a retention grace period.
-- During a rolling upgrade those already-queued file rows must not become
-- eligible before the session-level policy date.
UPDATE "uploaded_files" AS file
  SET "cleanup_due_at" = session."cleanup_due_at",
      "updated_at" = CURRENT_TIMESTAMP
  FROM "print_sessions" AS session
  WHERE session."id" = file."session_id"
    AND session."state" IN ('COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED')
    AND session."cleanup_due_at" IS NOT NULL
    AND file."status" IN ('DELETE_PENDING', 'DELETING')
    AND (
      file."cleanup_due_at" IS NULL
      OR file."cleanup_due_at" < session."cleanup_due_at"
    );
