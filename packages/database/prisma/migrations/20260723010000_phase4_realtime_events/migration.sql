ALTER TABLE "outbox_events"
ADD COLUMN "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "locked_at" TIMESTAMP(3),
ADD COLUMN "last_error_code" VARCHAR(80);

ALTER TABLE "outbox_events"
DROP CONSTRAINT "outbox_events_status_check";

ALTER TABLE "outbox_events"
ADD CONSTRAINT "outbox_events_status_check"
CHECK ("status" IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'));

DROP INDEX "outbox_events_status_created_at_idx";

CREATE INDEX "outbox_events_status_available_at_created_at_idx"
ON "outbox_events"("status", "available_at", "created_at");

CREATE TABLE "session_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "kiosk_id" VARCHAR(64) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "session_events_session_id_sequence_key"
ON "session_events"("session_id", "sequence");

CREATE INDEX "session_events_kiosk_id_occurred_at_idx"
ON "session_events"("kiosk_id", "occurred_at");

CREATE INDEX "session_events_session_id_sequence_idx"
ON "session_events"("session_id", "sequence");

ALTER TABLE "session_events"
ADD CONSTRAINT "session_events_session_id_fkey"
FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session_events"
ADD CONSTRAINT "session_events_kiosk_id_fkey"
FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
