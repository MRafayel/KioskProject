CREATE TABLE "kiosks" (
  "id" VARCHAR(64) NOT NULL,
  "public_code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Yerevan',
  "capabilities" JSONB NOT NULL,
  "capabilities_version" INTEGER NOT NULL DEFAULT 1,
  "config_version" INTEGER NOT NULL DEFAULT 1,
  "last_seen_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kiosks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "kiosks_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED', 'RETIRED')),
  CONSTRAINT "kiosks_versions_check" CHECK ("capabilities_version" > 0 AND "config_version" > 0)
);

CREATE TABLE "kiosk_credentials" (
  "id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "credential_id" VARCHAR(100) NOT NULL,
  "secret_digest" VARCHAR(64) NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "last_used_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kiosk_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "print_sessions" (
  "id" UUID NOT NULL,
  "public_id" VARCHAR(80) NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "locale" VARCHAR(10) NOT NULL,
  "state" VARCHAR(40) NOT NULL,
  "state_version" INTEGER NOT NULL DEFAULT 1,
  "idle_expires_at" TIMESTAMPTZ NOT NULL,
  "hard_expires_at" TIMESTAMPTZ NOT NULL,
  "terminal_reason" VARCHAR(80),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "canceled_at" TIMESTAMPTZ,
  "expired_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  CONSTRAINT "print_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "print_sessions_state_check" CHECK ("state" IN ('CREATED', 'WAITING_FOR_UPLOAD', 'FILES_UPLOADED', 'CONFIGURING', 'AWAITING_PAYMENT', 'PAID', 'PRINTING', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED', 'EXPIRED', 'CANCELED')),
  CONSTRAINT "print_sessions_locale_check" CHECK ("locale" IN ('en', 'ru', 'hy')),
  CONSTRAINT "print_sessions_version_check" CHECK ("state_version" > 0),
  CONSTRAINT "print_sessions_expiry_check" CHECK ("idle_expires_at" > "created_at" AND "hard_expires_at" >= "idle_expires_at")
);

CREATE TABLE "session_upload_grants" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "token_digest" VARCHAR(64) NOT NULL,
  "short_code_digest" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "session_upload_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "session_upload_grants_status_check" CHECK ("status" IN ('ACTIVE', 'CLAIMED', 'REVOKED', 'EXPIRED'))
);

CREATE TABLE "audit_events" (
  "id" UUID NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_type" VARCHAR(32) NOT NULL,
  "actor_id" VARCHAR(100) NOT NULL,
  "kiosk_id" VARCHAR(64),
  "session_id" UUID,
  "action" VARCHAR(100) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "request_id" VARCHAR(100),
  "metadata" JSONB,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL,
  "aggregate_type" VARCHAR(50) NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" VARCHAR(100) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "publish_attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "outbox_events_attempts_check" CHECK ("publish_attempts" >= 0),
  CONSTRAINT "outbox_events_status_check" CHECK ("status" IN ('PENDING', 'PUBLISHED', 'FAILED'))
);

CREATE TABLE "idempotency_records" (
  "id" UUID NOT NULL,
  "actor_id" VARCHAR(100) NOT NULL,
  "action" VARCHAR(100) NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "response_status" INTEGER NOT NULL,
  "response_body" JSONB NOT NULL,
  "resource_id" VARCHAR(100),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idempotency_records_status_check" CHECK ("response_status" BETWEEN 200 AND 599)
);

CREATE UNIQUE INDEX "kiosks_public_code_key" ON "kiosks"("public_code");
CREATE INDEX "kiosks_status_idx" ON "kiosks"("status");
CREATE INDEX "kiosks_last_seen_at_idx" ON "kiosks"("last_seen_at");
CREATE UNIQUE INDEX "kiosk_credentials_credential_id_key" ON "kiosk_credentials"("credential_id");
CREATE UNIQUE INDEX "kiosk_credentials_secret_digest_key" ON "kiosk_credentials"("secret_digest");
CREATE INDEX "kiosk_credentials_kiosk_id_revoked_at_idx" ON "kiosk_credentials"("kiosk_id", "revoked_at");
CREATE UNIQUE INDEX "print_sessions_public_id_key" ON "print_sessions"("public_id");
CREATE INDEX "print_sessions_kiosk_id_created_at_idx" ON "print_sessions"("kiosk_id", "created_at");
CREATE INDEX "print_sessions_state_idle_expires_at_idx" ON "print_sessions"("state", "idle_expires_at");
CREATE INDEX "print_sessions_state_hard_expires_at_idx" ON "print_sessions"("state", "hard_expires_at");
CREATE UNIQUE INDEX "print_sessions_one_active_per_kiosk_idx" ON "print_sessions"("kiosk_id") WHERE "state" NOT IN ('COMPLETED', 'CANCELED', 'EXPIRED');
CREATE UNIQUE INDEX "session_upload_grants_session_id_key" ON "session_upload_grants"("session_id");
CREATE UNIQUE INDEX "session_upload_grants_token_digest_key" ON "session_upload_grants"("token_digest");
CREATE UNIQUE INDEX "session_upload_grants_short_code_digest_key" ON "session_upload_grants"("short_code_digest");
CREATE INDEX "session_upload_grants_session_id_status_idx" ON "session_upload_grants"("session_id", "status");
CREATE INDEX "audit_events_session_id_occurred_at_idx" ON "audit_events"("session_id", "occurred_at");
CREATE INDEX "audit_events_actor_type_actor_id_occurred_at_idx" ON "audit_events"("actor_type", "actor_id", "occurred_at");
CREATE UNIQUE INDEX "outbox_events_aggregate_id_sequence_key" ON "outbox_events"("aggregate_id", "sequence");
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");
CREATE UNIQUE INDEX "idempotency_records_actor_id_action_key_key" ON "idempotency_records"("actor_id", "action", "key");
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

ALTER TABLE "kiosk_credentials" ADD CONSTRAINT "kiosk_credentials_kiosk_id_fkey" FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "print_sessions" ADD CONSTRAINT "print_sessions_kiosk_id_fkey" FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "session_upload_grants" ADD CONSTRAINT "session_upload_grants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_kiosk_id_fkey" FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_aggregate_id_fkey" FOREIGN KEY ("aggregate_id") REFERENCES "print_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
