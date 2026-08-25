-- Password authentication replaced enrollment tickets with invitations and
-- added WebAuthn session unlocking, but the migration that introduced those
-- flows left the challenge-purpose allow-list at its Phase 4B vocabulary.
-- PostgreSQL therefore rejected both new ceremonies before the browser could
-- receive its options.

ALTER TABLE "admin_webauthn_challenges"
  DROP CONSTRAINT "admin_webauthn_challenges_purpose_check";

ALTER TABLE "admin_webauthn_challenges"
  ADD CONSTRAINT "admin_webauthn_challenges_purpose_check"
  CHECK ("purpose" IN (
    'REGISTRATION',
    'AUTHENTICATION',
    'STEP_UP',
    'UNLOCK',
    'BREAK_GLASS_REGISTRATION',
    'INVITATION_REGISTRATION'
  ));
