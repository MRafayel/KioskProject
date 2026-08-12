-- Admin control plane, Phase 4B: the people half.
--
-- Everything the control plane has been given so far appends. This migration
-- prepares the first surface that changes a row somebody's access depends on,
-- and the two changes here exist to bound what that surface can mean.
--
--   admin_kiosk_scopes.revoked_at   taking a kiosk away stops being a DELETE
--   admin_enrollment_tickets        one authorised enrolment ceremony, for one
--                                   account that has no key yet, for 15 minutes
--
-- Both tables are owned by `printing_kiosk_migrator`, so this migration runs as
-- that role: `pnpm db:migrate:owner`. Running it on the application connection
-- will fail, and that failure is the ownership separation working.
--
-- The properties enforced here rather than only in the application, each one a
-- way an Admin account — or a compromised admin backend holding the people
-- role's credential — could otherwise manufacture an identity or quietly widen
-- one:
--
--   1. A kiosk assignment is never destroyed, only ended. "Who could act on
--      kiosk 4 last March" stays answerable, and the row a revocation writes on
--      cannot be re-pointed at a different person or a different kiosk.
--   2. An enrollment ticket can only ever name an Operator account that is
--      still PROVISIONING and holds no usable authenticator. It cannot be
--      minted against a working account, so it is not a way to add a second key
--      to somebody else's live identity.
--   3. Only an ACTIVE Admin or Technical Admin can be the issuer, and nobody
--      can issue one to themselves.
--   4. A ticket is single use and cannot be re-pointed, extended, or
--      un-consumed. Its expiry is fixed at insert and no update may move it.
--
-- What is deliberately absent: nothing here grants the ability to change an
-- account's role, and no table added here carries a capability. A ticket
-- authorises a WebAuthn ceremony and nothing else — it is not a session, and
-- redeeming one signs nobody in.

-- ---------------------------------------------------------------------------
-- Ending a kiosk assignment without erasing that it existed
-- ---------------------------------------------------------------------------

ALTER TABLE "admin_kiosk_scopes" ADD COLUMN "revoked_at" TIMESTAMP(3);

-- The scoping query reads live assignments only, and this is the index it uses.
-- The primary key still holds one row per (person, kiosk): re-assigning a kiosk
-- somebody used to cover clears `revoked_at` on the row that is already there
-- rather than adding a second one, so the pair cannot accumulate duplicates
-- that disagree about whether the assignment is live.
CREATE INDEX "admin_kiosk_scopes_admin_user_id_revoked_at_idx"
  ON "admin_kiosk_scopes" ("admin_user_id", "revoked_at");

-- An assignment row may change in exactly one direction: whether it is live.
-- Re-pointing one at a different person or a different kiosk would rewrite the
-- history of who could act where, which is the question this column exists to
-- keep answerable.
CREATE OR REPLACE FUNCTION "admin_kiosk_scopes_assert_immutable"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id"
    OR NEW."kiosk_id" IS DISTINCT FROM OLD."kiosk_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a kiosk assignment cannot be re-pointed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_kiosk_scopes_immutable"
  BEFORE UPDATE ON "admin_kiosk_scopes"
  FOR EACH ROW EXECUTE FUNCTION "admin_kiosk_scopes_assert_immutable"();

-- ---------------------------------------------------------------------------
-- Authorising one enrolment ceremony
-- ---------------------------------------------------------------------------

-- The problem this solves: an Operator with no security key cannot sign in, and
-- an Admin cannot enrol a key for them — WebAuthn requires the person and the
-- device in the same place. So somebody has to be able to say "the next
-- enrolment ceremony on this one account, within the next fifteen minutes, is
-- authorised", and that sentence is this table.
--
-- It is deliberately not a second break-glass. Break-glass is a sealed offline
-- artifact for an account that has lost every key it had; this is a
-- browser-issued, short-lived authorisation for an account that never had one.
-- The distinction is enforced below by the target's state, not by convention.
CREATE TABLE "admin_enrollment_tickets" (
  "id" UUID NOT NULL,
  "admin_user_id" UUID NOT NULL,
  "issued_by_admin_id" UUID NOT NULL,
  -- Peppered digest only. Reading this table yields nothing redeemable, in the
  -- same way reading the break-glass table does not.
  "secret_digest" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(280) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),

  CONSTRAINT "admin_enrollment_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_enrollment_tickets_secret_digest_key"
  ON "admin_enrollment_tickets" ("secret_digest");

CREATE INDEX "admin_enrollment_tickets_admin_user_id_consumed_at_idx"
  ON "admin_enrollment_tickets" ("admin_user_id", "consumed_at");

CREATE INDEX "admin_enrollment_tickets_expires_at_idx"
  ON "admin_enrollment_tickets" ("expires_at");

-- RESTRICT, matching every other row that names who did something: an account
-- cannot be removed while a record of an enrolment it authorised still stands.
ALTER TABLE "admin_enrollment_tickets"
  ADD CONSTRAINT "admin_enrollment_tickets_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_enrollment_tickets"
  ADD CONSTRAINT "admin_enrollment_tickets_issued_by_admin_id_fkey"
  FOREIGN KEY ("issued_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nobody authorises their own enrolment. Without this, the capability would be
-- a way for any holder to add a key to their own account without holding one.
ALTER TABLE "admin_enrollment_tickets"
  ADD CONSTRAINT "admin_enrollment_tickets_issuer_check"
  CHECK ("admin_user_id" <> "issued_by_admin_id");

ALTER TABLE "admin_enrollment_tickets"
  ADD CONSTRAINT "admin_enrollment_tickets_expiry_check"
  CHECK ("expires_at" > "created_at");

ALTER TABLE "admin_enrollment_tickets"
  ADD CONSTRAINT "admin_enrollment_tickets_secret_digest_check"
  CHECK ("secret_digest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "admin_enrollment_tickets"
  ADD CONSTRAINT "admin_enrollment_tickets_reason_check"
  CHECK (length(btrim("reason")) >= 8);

-- Who a ticket may be issued for, and by whom.
--
-- The target check is the one that matters. A ticket may only name an Operator
-- account that is still PROVISIONING and holds no usable authenticator — an
-- account, in other words, that cannot currently sign in and has never been
-- able to. That makes this incapable of adding a key to somebody's working
-- identity: a person who has a key gets a replacement through
-- `authenticator.manage.self`, and a person who has lost all of theirs is a
-- recovery, which is the sealed offline procedure and not something anybody
-- starts from a browser.
--
-- The owner row is locked first, as every other identity trigger does, so a
-- ticket cannot be issued in the gap between reading an account's key count and
-- an enrolment committing.
CREATE OR REPLACE FUNCTION "admin_enrollment_tickets_assert_target"() RETURNS TRIGGER AS $$
DECLARE
  "target_role" VARCHAR(24);
  "target_status" VARCHAR(24);
  "issuer_role" VARCHAR(24);
  "issuer_status" VARCHAR(24);
  "usable_keys" INTEGER;
BEGIN
  SELECT "role", "status" INTO "target_role", "target_status"
  FROM "admin_users"
  WHERE "id" = NEW."admin_user_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'an enrollment ticket must name an existing account'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF "target_role" <> 'OPERATOR' THEN
    RAISE EXCEPTION 'an enrollment ticket may only be issued for an OPERATOR account, not %',
        "target_role"
      USING ERRCODE = 'check_violation';
  END IF;

  IF "target_status" <> 'PROVISIONING' THEN
    RAISE EXCEPTION 'account % is % and is not awaiting its first key', NEW."admin_user_id",
        "target_status"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO "usable_keys"
  FROM "admin_authenticators"
  WHERE "admin_user_id" = NEW."admin_user_id"
    AND "revoked_at" IS NULL;

  IF "usable_keys" > 0 THEN
    RAISE EXCEPTION 'account % already holds a usable authenticator', NEW."admin_user_id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "role", "status" INTO "issuer_role", "issuer_status"
  FROM "admin_users"
  WHERE "id" = NEW."issued_by_admin_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'an enrollment ticket must name the account that issued it'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF "issuer_role" NOT IN ('ADMIN', 'TECHNICAL_ADMIN') OR "issuer_status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'an enrollment ticket must be issued by an active admin'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_enrollment_tickets_target"
  BEFORE INSERT ON "admin_enrollment_tickets"
  FOR EACH ROW EXECUTE FUNCTION "admin_enrollment_tickets_assert_target"();

-- Consumption is final, and everything else about a ticket is fixed at issue.
-- Written the same way as the break-glass credential beside it: an identical
-- second assignment is rejected rather than treated as an idempotent reuse, so
-- two redemptions arriving in the same millisecond have a loser.
CREATE OR REPLACE FUNCTION "admin_enrollment_tickets_assert_single_use"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id"
    OR NEW."issued_by_admin_id" IS DISTINCT FROM OLD."issued_by_admin_id"
    OR NEW."secret_digest" IS DISTINCT FROM OLD."secret_digest"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'an enrollment ticket cannot be re-pointed or extended'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."consumed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'an enrollment ticket is single use'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."consumed_at" IS NULL THEN
    RAISE EXCEPTION 'an enrollment ticket cannot be un-consumed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_enrollment_tickets_single_use"
  BEFORE UPDATE ON "admin_enrollment_tickets"
  FOR EACH ROW EXECUTE FUNCTION "admin_enrollment_tickets_assert_single_use"();

-- ---------------------------------------------------------------------------
-- The ceremony a ticket authorises
-- ---------------------------------------------------------------------------

-- A fifth kind of WebAuthn ceremony, and the vocabulary is closed by a check
-- constraint rather than left open — so a bug that wrote a purpose nobody
-- reviewed would be a failed insert instead of a ceremony with no rules.
--
-- It is deliberately distinct from BREAK_GLASS_REGISTRATION. The two look alike
-- from the browser's side (no session, one enrolment, no capability granted) and
-- differ in the only way that matters: break-glass may enrol onto a
-- PROVISIONING *or* ACTIVE account, because it exists for somebody who has lost
-- the keys they had, while a ticket may only ever enrol onto an account that has
-- never had one. Sharing a purpose string would have made that difference a
-- branch in application code instead of a property of the row.
ALTER TABLE "admin_webauthn_challenges"
  DROP CONSTRAINT "admin_webauthn_challenges_purpose_check";

ALTER TABLE "admin_webauthn_challenges"
  ADD CONSTRAINT "admin_webauthn_challenges_purpose_check"
  CHECK ("purpose" IN (
    'REGISTRATION',
    'AUTHENTICATION',
    'STEP_UP',
    'BREAK_GLASS_REGISTRATION',
    'ENROLLMENT_TICKET_REGISTRATION'
  ));
