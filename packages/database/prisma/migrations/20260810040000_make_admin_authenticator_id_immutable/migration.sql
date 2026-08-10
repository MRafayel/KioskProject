-- An authenticator's row identifier is durable audit identity. The broader
-- identity-hardening migration froze its owner, credential and policy evidence,
-- but changing the primary key could still detach future route references from
-- the identifier already written to the append-only audit log.
CREATE OR REPLACE FUNCTION "admin_authenticators_reject_id_rewrite"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'an enrolled authenticator identity and policy are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_authenticators_id_immutable"
  BEFORE UPDATE OF "id" ON "admin_authenticators"
  FOR EACH ROW
  WHEN (NEW."id" IS DISTINCT FROM OLD."id")
  EXECUTE FUNCTION "admin_authenticators_reject_id_rewrite"();
