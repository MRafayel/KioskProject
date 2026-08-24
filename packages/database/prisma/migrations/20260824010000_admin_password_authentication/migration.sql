-- Admin authentication rework: passwords as the base factor.
--
-- Authentication becomes username + Argon2id password for everybody, with
-- WebAuthn layered on top as the second factor for privileged roles. Three new
-- tables carry the knowledge factor and the two kinds of one-time grant
-- (invitations, administrator-assisted password resets); enrollment tickets
-- are subsumed by invitations and retired. The activation and keep-a-spare
-- invariants change with the factor model: activation now requires a password
-- plus, for privileged roles, one usable key rather than two; and the
-- Technical Admin device-bound key rule retires — with a password in front of
-- every assertion, a persistent platform authenticator is a second factor, not
-- the whole of the identity.
--
-- Run as the migrator role (`pnpm db:migrate:owner`): it alters migrator-owned
-- tables, and the tables it creates must be owned by the migrator so the
-- application cannot disable the single-use triggers below. Re-provision and
-- verify all five least-privilege roles afterwards, as after every migration.

-- ---------------------------------------------------------------------------
-- Usernames
-- ---------------------------------------------------------------------------

ALTER TABLE "admin_users" ADD COLUMN "username" VARCHAR(32);

-- Backfill from display names: the readable slug when it is valid and unique,
-- otherwise slug + a fragment of the account id. Deterministic, and collisions
-- fail the unique index below loudly rather than blessing a duplicate. The CLI
-- can rename afterwards.
WITH "candidates" AS (
  SELECT
    "id",
    trim(BOTH '._-' FROM regexp_replace(lower("display_name"), '[^a-z0-9._-]+', '.', 'g')) AS "slug"
  FROM "admin_users"
),
"decided" AS (
  SELECT
    "id",
    CASE
      WHEN length("slug") BETWEEN 3 AND 32
        AND "slug" ~ '^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$'
        AND count(*) OVER (PARTITION BY "slug") = 1
      THEN "slug"
      ELSE CASE WHEN length("slug") >= 1 THEN left("slug", 20) ELSE 'user' END
           || '.' || left(replace("id"::text, '-', ''), 8)
    END AS "username"
  FROM "candidates"
)
UPDATE "admin_users" AS "u"
SET "username" = "d"."username"
FROM "decided" AS "d"
WHERE "d"."id" = "u"."id";

ALTER TABLE "admin_users" ALTER COLUMN "username" SET NOT NULL;

CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- ---------------------------------------------------------------------------
-- Session context
-- ---------------------------------------------------------------------------

-- Informational only: what the person reviewing their own sessions sees.
-- Nothing anywhere treats either value as proof of device identity.
ALTER TABLE "admin_sessions" ADD COLUMN "ip_address" VARCHAR(64);
ALTER TABLE "admin_sessions" ADD COLUMN "user_agent" VARCHAR(280);

-- ---------------------------------------------------------------------------
-- Passwords
-- ---------------------------------------------------------------------------

-- One row per account. The digest is a self-describing PHC string, so the
-- Argon2id parameters travel with the hash. Deliberately not a column on
-- admin_users: the people-writer role holds column-level UPDATE there, and a
-- password digest must never be reachable from an account-management
-- connection.
CREATE TABLE "admin_passwords" (
  "admin_user_id" UUID NOT NULL,
  "digest" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_passwords_pkey" PRIMARY KEY ("admin_user_id")
);

ALTER TABLE "admin_passwords"
  ADD CONSTRAINT "admin_passwords_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invitations and password resets
-- ---------------------------------------------------------------------------

-- The two one-time grants share a shape: a digest of a code shown once, an
-- expiry, and exactly one terminal transition — consumed or revoked. An
-- invitation is consumed when the invited account activates (so a fumbled key
-- ceremony costs a retry, not a reissue); a reset is consumed when the new
-- password lands.

CREATE TABLE "admin_invitations" (
  "id" UUID NOT NULL,
  "admin_user_id" UUID NOT NULL,
  "issued_by_admin_id" UUID,
  "secret_digest" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(280) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "admin_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_invitations_secret_digest_key" ON "admin_invitations"("secret_digest");
CREATE INDEX "admin_invitations_admin_user_id_consumed_at_idx"
  ON "admin_invitations"("admin_user_id", "consumed_at");
CREATE INDEX "admin_invitations_expires_at_idx" ON "admin_invitations"("expires_at");
-- One live invitation per account: reissuing means revoking the old one first,
-- so there is never a question of which code is the real one.
CREATE UNIQUE INDEX "admin_invitations_one_live_per_account"
  ON "admin_invitations"("admin_user_id")
  WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "admin_invitations"
  ADD CONSTRAINT "admin_invitations_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_invitations"
  ADD CONSTRAINT "admin_invitations_issued_by_admin_id_fkey"
  FOREIGN KEY ("issued_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "admin_password_resets" (
  "id" UUID NOT NULL,
  "admin_user_id" UUID NOT NULL,
  "issued_by_admin_id" UUID,
  "secret_digest" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(280) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "admin_password_resets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_password_resets_secret_digest_key"
  ON "admin_password_resets"("secret_digest");
CREATE INDEX "admin_password_resets_admin_user_id_consumed_at_idx"
  ON "admin_password_resets"("admin_user_id", "consumed_at");
CREATE INDEX "admin_password_resets_expires_at_idx" ON "admin_password_resets"("expires_at");
CREATE UNIQUE INDEX "admin_password_resets_one_live_per_account"
  ON "admin_password_resets"("admin_user_id")
  WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "admin_password_resets"
  ADD CONSTRAINT "admin_password_resets_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_password_resets"
  ADD CONSTRAINT "admin_password_resets_issued_by_admin_id_fkey"
  FOREIGN KEY ("issued_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A consumed or revoked grant is terminal, and nothing about a grant can be
-- re-pointed or extended after the code left the building. Same failure shape
-- as the break-glass trigger, shared by both tables.
CREATE OR REPLACE FUNCTION "admin_one_time_grants_assert_single_use"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id"
    OR NEW."issued_by_admin_id" IS DISTINCT FROM OLD."issued_by_admin_id"
    OR NEW."secret_digest" IS DISTINCT FROM OLD."secret_digest"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'a one-time grant cannot be re-pointed or extended'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."consumed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed one-time grant cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked one-time grant cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."consumed_at" IS NOT NULL AND NEW."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a one-time grant cannot be consumed and revoked together'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_invitations_single_use"
  BEFORE UPDATE ON "admin_invitations"
  FOR EACH ROW EXECUTE FUNCTION "admin_one_time_grants_assert_single_use"();

CREATE TRIGGER "admin_password_resets_single_use"
  BEFORE UPDATE ON "admin_password_resets"
  FOR EACH ROW EXECUTE FUNCTION "admin_one_time_grants_assert_single_use"();

-- ---------------------------------------------------------------------------
-- Enrolment integrity replaces the device-bound rule
-- ---------------------------------------------------------------------------

-- The Technical Admin device-bound requirement retires. It was the right rule
-- while WebAuthn stood alone; in practice, on any machine without a hardware
-- key, it forced a browser-lifetime virtual authenticator and burned a
-- break-glass code per restart. The password is now the first factor, and a
-- key that persists beats a perfect key that keeps not existing. What stays is
-- the immutability of an enrolled credential and the owner lock that
-- serialises enrolments against activation counting.
DROP TRIGGER "admin_authenticators_device_bound" ON "admin_authenticators";
DROP FUNCTION "admin_authenticators_assert_device_bound"();

CREATE OR REPLACE FUNCTION "admin_authenticators_assert_enrolment_integrity"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id"
      OR NEW."credential_id" IS DISTINCT FROM OLD."credential_id"
      OR NEW."public_key" IS DISTINCT FROM OLD."public_key"
      OR NEW."transports" IS DISTINCT FROM OLD."transports"
      OR NEW."attachment" IS DISTINCT FROM OLD."attachment"
      OR NEW."backup_eligible" IS DISTINCT FROM OLD."backup_eligible"
      OR NEW."backed_up" IS DISTINCT FROM OLD."backed_up"
      OR NEW."aaguid" IS DISTINCT FROM OLD."aaguid"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'an enrolled authenticator identity and policy are immutable'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Serialise concurrent enrolments per account, so a later activation count
  -- in the same transaction sees committed keys rather than a racing snapshot.
  PERFORM 1 FROM "admin_users" WHERE "id" = NEW."admin_user_id" FOR UPDATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_authenticators_enrolment_integrity"
  BEFORE INSERT OR UPDATE ON "admin_authenticators"
  FOR EACH ROW EXECUTE FUNCTION "admin_authenticators_assert_enrolment_integrity"();

-- The role-change guard existed to stop a synchronised passkey becoming a
-- Technical Admin credential. The rule it enforced is gone.
DROP TRIGGER "admin_users_technical_authenticators" ON "admin_users";
DROP FUNCTION "admin_users_assert_technical_authenticators"();

-- ---------------------------------------------------------------------------
-- Activation and keep-a-spare under the new factor model
-- ---------------------------------------------------------------------------

-- Activation now proves the account holds every factor its role signs in with:
-- a password always, and one usable key for privileged roles. The check runs
-- on every transition into ACTIVE — resuming a suspension included, because a
-- suspended account's keys may have been cleaned up in the meantime.
--
-- SECURITY DEFINER, and this is the first trigger here that needs it: the
-- function reads `admin_passwords`, which the people role deliberately holds
-- nothing on. Without it, resuming a suspended account fails with a permission
-- error instead of an answer. The function is owned by the migrator, so it
-- runs with exactly the rights the invariant needs and no more, and
-- `search_path` is pinned so no caller can redirect the tables it reads.
CREATE OR REPLACE FUNCTION "admin_users_assert_activation_ready"() RETURNS TRIGGER
  SECURITY DEFINER
  SET "search_path" = pg_catalog, public
AS $$
DECLARE
  "usable" INTEGER;
  "required" INTEGER;
BEGIN
  IF NEW."status" <> 'ACTIVE' OR OLD."status" = 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "admin_passwords" WHERE "admin_user_id" = NEW."id") THEN
    RAISE EXCEPTION 'an admin account needs a password before activation'
      USING ERRCODE = 'restrict_violation';
  END IF;

  "required" := CASE WHEN NEW."role" IN ('ADMIN', 'TECHNICAL_ADMIN') THEN 1 ELSE 0 END;
  IF "required" > 0 THEN
    SELECT count(*) INTO "usable"
    FROM "admin_authenticators"
    WHERE "admin_user_id" = NEW."id" AND "revoked_at" IS NULL;

    IF "usable" < "required" THEN
      RAISE EXCEPTION 'a privileged admin account needs a usable security key before activation'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- An active privileged account keeps at least one usable key: revoking the
-- last one would leave a password as the only thing between the internet and
-- an administrator account. Operators hold keys optionally and may retire the
-- last one freely.
CREATE OR REPLACE FUNCTION "admin_authenticators_assert_spare_remains"() RETURNS TRIGGER AS $$
DECLARE
  "owner_status" VARCHAR(24);
  "owner_role" VARCHAR(24);
  "remaining" INTEGER;
  "required" INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id" THEN
      RAISE EXCEPTION 'an authenticator cannot be transferred to another admin account'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."revoked_at" IS NOT NULL AND (
      NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
      OR NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason"
    ) THEN
      RAISE EXCEPTION 'an authenticator revocation is final'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Only a first transition into revoked can reduce the usable count.
    IF NEW."revoked_at" IS NULL OR OLD."revoked_at" IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT "status", "role" INTO "owner_status", "owner_role"
  FROM "admin_users"
  WHERE "id" = OLD."admin_user_id"
  FOR UPDATE;

  IF "owner_status" IS DISTINCT FROM 'ACTIVE' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  "required" := CASE WHEN "owner_role" IN ('ADMIN', 'TECHNICAL_ADMIN') THEN 1 ELSE 0 END;
  IF "required" = 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT count(*) INTO "remaining"
  FROM "admin_authenticators"
  WHERE "admin_user_id" = OLD."admin_user_id"
    AND "revoked_at" IS NULL
    AND "id" <> OLD."id";

  IF "remaining" < "required" THEN
    RAISE EXCEPTION 'an active privileged admin account must keep a usable security key'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Enrollment tickets retire
-- ---------------------------------------------------------------------------

-- Invitations carry onboarding end to end — account, password, and key where
-- the role requires one — so the ticket, which could only authorise a first
-- key on an Operator account, has nothing left to do. The history of issued
-- tickets lives in the audit log, which is where history lives.
DROP TABLE "admin_enrollment_tickets";
DROP FUNCTION IF EXISTS "admin_enrollment_tickets_assert_target"();
DROP FUNCTION IF EXISTS "admin_enrollment_tickets_assert_single_use"();
