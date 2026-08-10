-- Admin control plane, Phase 1: human identity, WebAuthn credentials,
-- revocable sessions, and an audit log that can no longer be rewritten.
--
-- Every invariant that would lock an operator out of the control plane, or
-- would let a compromised account erase its own tracks, is enforced here as
-- well as in the application. That matches how the rest of this schema already
-- works: the application decides, and the database refuses to be wrong.

-- ---------------------------------------------------------------------------
-- Audit immutability
-- ---------------------------------------------------------------------------

-- `audit_events` was the only evidence table without this protection.
-- `payment_attempts`, `print_job_events` and `print_setting_revisions` already
-- reject UPDATE; audit is the table that records everything the others do not,
-- so it needs the stronger rule: no UPDATE and no DELETE, by anyone, ever.
CREATE OR REPLACE FUNCTION "audit_events_reject_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_update"
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_reject_rewrite"();

CREATE TRIGGER "audit_events_no_delete"
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_reject_rewrite"();

-- Detaching an audit row from its subject is a rewrite by another name, and
-- with the trigger above a cascading SET NULL would now fail with a confusing
-- error. RESTRICT states the intent directly: a kiosk or session that has
-- history cannot be deleted. Neither is ever deleted by this system today —
-- retention scrubs child rows and keeps the session as a tombstone — so this
-- changes no current behaviour.
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_kiosk_id_fkey";
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_kiosk_id_fkey"
  FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_session_id_fkey";
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "print_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The error centre and the audit view both filter by action over a time range.
CREATE INDEX "audit_events_action_occurred_at_idx"
  ON "audit_events"("action", "occurred_at");

-- ---------------------------------------------------------------------------
-- Admin identity
-- ---------------------------------------------------------------------------

CREATE TABLE "admin_users" (
  "id" UUID NOT NULL,
  "user_handle" BYTEA NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "role" VARCHAR(24) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PROVISIONING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at" TIMESTAMP(3),
  "suspended_at" TIMESTAMP(3),
  "disabled_at" TIMESTAMP(3),
  "last_login_at" TIMESTAMP(3),
  CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_users_role_check"
    CHECK ("role" IN ('OPERATOR', 'ADMIN', 'TECHNICAL_ADMIN')),
  CONSTRAINT "admin_users_status_check"
    CHECK ("status" IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DISABLED')),
  -- A guessable handle would let an attacker probe for accounts. 32 bytes of
  -- randomness is the WebAuthn recommendation and is what the API generates.
  CONSTRAINT "admin_users_user_handle_length_check"
    CHECK (octet_length("user_handle") = 32)
);

CREATE UNIQUE INDEX "admin_users_user_handle_key" ON "admin_users"("user_handle");
CREATE INDEX "admin_users_status_role_idx" ON "admin_users"("status", "role");

CREATE TABLE "admin_authenticators" (
  "id" UUID NOT NULL,
  "admin_user_id" UUID NOT NULL,
  "credential_id" VARCHAR(400) NOT NULL,
  "public_key" BYTEA NOT NULL,
  "sign_count" INTEGER NOT NULL DEFAULT 0,
  "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attachment" VARCHAR(24),
  "backup_eligible" BOOLEAN NOT NULL DEFAULT false,
  "backed_up" BOOLEAN NOT NULL DEFAULT false,
  "aaguid" VARCHAR(36),
  "label" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revoked_reason" VARCHAR(48),
  CONSTRAINT "admin_authenticators_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_authenticators_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "admin_authenticators_attachment_check"
    CHECK ("attachment" IS NULL OR "attachment" IN ('platform', 'cross-platform')),
  CONSTRAINT "admin_authenticators_sign_count_check" CHECK ("sign_count" >= 0)
);

CREATE UNIQUE INDEX "admin_authenticators_credential_id_key"
  ON "admin_authenticators"("credential_id");
CREATE INDEX "admin_authenticators_admin_user_id_revoked_at_idx"
  ON "admin_authenticators"("admin_user_id", "revoked_at");

-- A Technical Admin proposes every serious production change, so their
-- credential must be device-bound: not exportable and not synchronised to a
-- vendor cloud. The application refuses such an enrolment; this refuses it
-- again, so a later code path cannot quietly weaken the rule.
CREATE OR REPLACE FUNCTION "admin_authenticators_assert_device_bound"() RETURNS TRIGGER AS $$
DECLARE
  "owner_role" VARCHAR(24);
BEGIN
  SELECT "role" INTO "owner_role" FROM "admin_users" WHERE "id" = NEW."admin_user_id";

  IF "owner_role" = 'TECHNICAL_ADMIN' THEN
    IF NEW."backup_eligible" OR NEW."backed_up" THEN
      RAISE EXCEPTION 'a technical admin authenticator must not be exportable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."attachment" IS DISTINCT FROM 'cross-platform' THEN
      RAISE EXCEPTION 'a technical admin authenticator must be a roaming key'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_authenticators_device_bound"
  BEFORE INSERT OR UPDATE ON "admin_authenticators"
  FOR EACH ROW EXECUTE FUNCTION "admin_authenticators_assert_device_bound"();

-- An active account must keep a spare. Revoking the second-to-last
-- authenticator would leave one key between an operator and a locked control
-- plane, so the replacement is enrolled first and only then is the old key
-- removed. A suspended or disabled account has no session to protect and may
-- be cleaned up freely.
CREATE OR REPLACE FUNCTION "admin_authenticators_assert_spare_remains"() RETURNS TRIGGER AS $$
DECLARE
  "owner_status" VARCHAR(24);
  "remaining" INTEGER;
BEGIN
  -- Only a transition into revoked, or an outright delete, can reduce the count.
  IF TG_OP = 'UPDATE' AND (NEW."revoked_at" IS NULL OR OLD."revoked_at" IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  SELECT "status" INTO "owner_status" FROM "admin_users" WHERE "id" = OLD."admin_user_id";
  IF "owner_status" IS DISTINCT FROM 'ACTIVE' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT count(*) INTO "remaining"
  FROM "admin_authenticators"
  WHERE "admin_user_id" = OLD."admin_user_id"
    AND "revoked_at" IS NULL
    AND "id" <> OLD."id";

  IF "remaining" < 2 THEN
    RAISE EXCEPTION 'an active admin account must keep at least two usable authenticators'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_authenticators_keep_a_spare"
  BEFORE UPDATE OR DELETE ON "admin_authenticators"
  FOR EACH ROW EXECUTE FUNCTION "admin_authenticators_assert_spare_remains"();

-- An account cannot be switched on until it has enrolled its spare. This is
-- what makes PROVISIONING the only state in which fewer than two exist.
CREATE OR REPLACE FUNCTION "admin_users_assert_activation_ready"() RETURNS TRIGGER AS $$
DECLARE
  "usable" INTEGER;
BEGIN
  IF NEW."status" <> 'ACTIVE' OR OLD."status" = 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO "usable"
  FROM "admin_authenticators"
  WHERE "admin_user_id" = NEW."id" AND "revoked_at" IS NULL;

  IF "usable" < 2 THEN
    RAISE EXCEPTION 'an admin account needs at least two usable authenticators before activation'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_users_activation_is_ready"
  BEFORE UPDATE ON "admin_users"
  FOR EACH ROW EXECUTE FUNCTION "admin_users_assert_activation_ready"();

-- ---------------------------------------------------------------------------
-- Sessions and ceremonies
-- ---------------------------------------------------------------------------

CREATE TABLE "admin_sessions" (
  "id" UUID NOT NULL,
  "admin_user_id" UUID NOT NULL,
  "token_digest" VARCHAR(64) NOT NULL,
  "csrf_digest" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idle_expires_at" TIMESTAMP(3) NOT NULL,
  "hard_expires_at" TIMESTAMP(3) NOT NULL,
  "last_seen_at" TIMESTAMP(3),
  "last_step_up_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revoked_reason" VARCHAR(48),
  CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_sessions_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- The idle window may roll forward but never past the absolute limit, so a
  -- continuously used session still ends.
  CONSTRAINT "admin_sessions_window_check"
    CHECK ("idle_expires_at" <= "hard_expires_at")
);

CREATE UNIQUE INDEX "admin_sessions_token_digest_key" ON "admin_sessions"("token_digest");
CREATE INDEX "admin_sessions_admin_user_id_revoked_at_idx"
  ON "admin_sessions"("admin_user_id", "revoked_at");
CREATE INDEX "admin_sessions_hard_expires_at_idx" ON "admin_sessions"("hard_expires_at");

CREATE TABLE "admin_webauthn_challenges" (
  "id" UUID NOT NULL,
  "purpose" VARCHAR(32) NOT NULL,
  "challenge" VARCHAR(400) NOT NULL,
  "admin_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  CONSTRAINT "admin_webauthn_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_webauthn_challenges_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_webauthn_challenges_purpose_check"
    CHECK ("purpose" IN (
      'REGISTRATION', 'AUTHENTICATION', 'STEP_UP', 'BREAK_GLASS_REGISTRATION'
    ))
);

CREATE INDEX "admin_webauthn_challenges_expires_at_idx"
  ON "admin_webauthn_challenges"("expires_at");

CREATE TABLE "admin_break_glass_credentials" (
  "id" UUID NOT NULL,
  "admin_user_id" UUID NOT NULL,
  "label" VARCHAR(80) NOT NULL,
  "secret_digest" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "admin_break_glass_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_break_glass_credentials_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "admin_break_glass_credentials_secret_digest_key"
  ON "admin_break_glass_credentials"("secret_digest");
CREATE INDEX "admin_break_glass_credentials_admin_user_id_consumed_at_idx"
  ON "admin_break_glass_credentials"("admin_user_id", "consumed_at");

-- Consumption is final. A recovery credential that could be reused would be a
-- standing second factor-less way into a privileged account.
CREATE OR REPLACE FUNCTION "admin_break_glass_assert_single_use"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."consumed_at" IS NOT NULL AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at" THEN
    RAISE EXCEPTION 'a break-glass credential is single use'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."secret_digest" <> NEW."secret_digest" THEN
    RAISE EXCEPTION 'a break-glass credential cannot be re-pointed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_break_glass_single_use"
  BEFORE UPDATE ON "admin_break_glass_credentials"
  FOR EACH ROW EXECUTE FUNCTION "admin_break_glass_assert_single_use"();

CREATE TABLE "admin_kiosk_scopes" (
  "admin_user_id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_kiosk_scopes_pkey" PRIMARY KEY ("admin_user_id", "kiosk_id"),
  CONSTRAINT "admin_kiosk_scopes_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_kiosk_scopes_kiosk_id_fkey"
    FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "admin_kiosk_scopes_kiosk_id_idx" ON "admin_kiosk_scopes"("kiosk_id");
