-- Admin Phase 1 invariant hardening.
--
-- The initial triggers checked the right steady-state properties, but several
-- check-then-write paths were not serialized. Under MVCC, two registrations or
-- revocations for the same account could each make a decision from a different
-- snapshot. Locking the small owner row makes those transitions linear per
-- account without serializing unrelated administrators.

-- Do not silently carry a violation forward. These queries are tiny at the
-- expected admin-account cardinality and make an unsafe pre-existing state an
-- explicit deployment failure rather than blessing it with new triggers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "admin_users" u
    WHERE u."status" = 'ACTIVE'
      AND (
        SELECT count(*)
        FROM "admin_authenticators" a
        WHERE a."admin_user_id" = u."id" AND a."revoked_at" IS NULL
      ) < 2
  ) THEN
    RAISE EXCEPTION 'cannot harden admin identity: an active account has fewer than two usable authenticators'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "admin_users" u
    JOIN "admin_authenticators" a ON a."admin_user_id" = u."id"
    WHERE u."role" = 'TECHNICAL_ADMIN'
      AND a."revoked_at" IS NULL
      AND (
        a."backup_eligible"
        OR a."backed_up"
        OR a."attachment" IS DISTINCT FROM 'cross-platform'
      )
  ) THEN
    RAISE EXCEPTION 'cannot harden admin identity: a technical admin has a non-device-bound authenticator'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- Row triggers do not fire for TRUNCATE. Protect the third PostgreSQL operation
-- that can erase the audit trail, using the same deterministic failure as
-- UPDATE and DELETE.
CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_reject_rewrite"();

-- PROVISIONING is an initial state, SUSPENDED may be resumed after operational
-- review, and DISABLED is permanent. In particular, ACTIVE cannot be moved back
-- to PROVISIONING to bypass the keep-a-spare trigger.
CREATE OR REPLACE FUNCTION "admin_users_assert_status_transition"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PROVISIONING' AND NEW."status" IN ('ACTIVE', 'SUSPENDED', 'DISABLED') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" IN ('SUSPENDED', 'DISABLED') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'SUSPENDED' AND NEW."status" IN ('ACTIVE', 'DISABLED') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'admin account status transition from % to % is not allowed',
      OLD."status", NEW."status"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_users_status_transition"
  BEFORE UPDATE OF "status" ON "admin_users"
  FOR EACH ROW EXECUTE FUNCTION "admin_users_assert_status_transition"();

-- A role change is allowed only when the credentials already satisfy the new
-- role. This keeps direct SQL and future account-management paths from turning
-- a synchronised passkey into a Technical Admin credential after enrolment.
CREATE OR REPLACE FUNCTION "admin_users_assert_technical_authenticators"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."role" <> 'TECHNICAL_ADMIN' OR OLD."role" IS NOT DISTINCT FROM NEW."role" THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "admin_authenticators" a
    WHERE a."admin_user_id" = NEW."id"
      AND a."revoked_at" IS NULL
      AND (
        a."backup_eligible"
        OR a."backed_up"
        OR a."attachment" IS DISTINCT FROM 'cross-platform'
      )
  ) THEN
    RAISE EXCEPTION 'a technical admin may only have device-bound roaming authenticators'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_users_technical_authenticators"
  BEFORE UPDATE OF "role" ON "admin_users"
  FOR EACH ROW EXECUTE FUNCTION "admin_users_assert_technical_authenticators"();

-- Credential identity and policy evidence are fixed at enrolment. Ordinary
-- counter/last-used updates therefore need no owner lock; inserts do take it,
-- serializing concurrent registrations so the second transaction's activation
-- count sees the first committed key. Keeping counter writes off the owner lock
-- also avoids an owner -> authenticator / authenticator -> owner lock inversion.
CREATE OR REPLACE FUNCTION "admin_authenticators_assert_device_bound"() RETURNS TRIGGER AS $$
DECLARE
  "owner_role" VARCHAR(24);
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

  SELECT "role" INTO "owner_role"
  FROM "admin_users"
  WHERE "id" = NEW."admin_user_id"
  FOR UPDATE;

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

-- Ownership and revocation are historical facts, not editable attributes.
-- The owner lock also serializes two revocations and a revocation racing an
-- ACTIVE transition; the later operation then counts from the committed state.
CREATE OR REPLACE FUNCTION "admin_authenticators_assert_spare_remains"() RETURNS TRIGGER AS $$
DECLARE
  "owner_status" VARCHAR(24);
  "remaining" INTEGER;
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

  SELECT "status" INTO "owner_status"
  FROM "admin_users"
  WHERE "id" = OLD."admin_user_id"
  FOR UPDATE;

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

-- A consumed or revoked recovery credential is terminal. Its account, digest,
-- issue time and expiry are also immutable so no update can re-point a sealed
-- envelope or extend it after the physical copy was issued.
CREATE OR REPLACE FUNCTION "admin_break_glass_assert_single_use"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id"
    OR NEW."secret_digest" IS DISTINCT FROM OLD."secret_digest"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'a break-glass credential cannot be re-pointed or extended'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Reject even an identical second assignment. That closes the
  -- same-timestamp concurrent-consumption case rather than treating it as an
  -- idempotent reuse.
  IF OLD."consumed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed break-glass credential cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked break-glass credential cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."consumed_at" IS NOT NULL AND NEW."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a break-glass credential cannot be consumed and revoked together'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
