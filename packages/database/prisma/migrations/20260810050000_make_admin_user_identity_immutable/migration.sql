-- An admin account identifier is durable audit identity: audit_events.actor_id
-- deliberately stores the value as history rather than as a live foreign key.
-- The WebAuthn user handle is also part of credential identity, and both it and
-- the account creation timestamp must remain fixed after provisioning.
CREATE OR REPLACE FUNCTION "admin_users_reject_identity_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'an admin account identity is immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_users_identity_immutable"
  BEFORE UPDATE OF "id", "user_handle", "created_at" ON "admin_users"
  FOR EACH ROW
  WHEN (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."user_handle" IS DISTINCT FROM OLD."user_handle"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  )
  EXECUTE FUNCTION "admin_users_reject_identity_rewrite"();
