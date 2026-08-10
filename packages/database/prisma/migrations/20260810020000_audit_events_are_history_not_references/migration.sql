-- Audit events record history; they do not participate in referential
-- integrity.
--
-- The previous migration made `audit_events` append-only and changed its kiosk
-- and session foreign keys from SET NULL to RESTRICT, reasoning that detaching
-- a row from its subject is a rewrite by another name. That reasoning was
-- right, but the fix was wrong: with the append-only trigger in place, SET NULL
-- fails as a forbidden UPDATE, and RESTRICT makes an audited kiosk or session
-- undeletable forever. Either way an operational deletion is decided by the
-- audit log, which is backwards.
--
-- Dropping the constraints resolves it properly. The identifiers stay as
-- recorded values rather than live references: the audit row keeps naming the
-- session it was about even after that session is gone, which is what a
-- historical record is supposed to do. Nothing detaches, nothing blocks, and
-- the append-only guarantee becomes unconditional.
--
-- These columns are written by this system from identifiers it has just used,
-- and the table takes no user input, so the integrity the constraints provided
-- was never load-bearing.

ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_kiosk_id_fkey";
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_session_id_fkey";
