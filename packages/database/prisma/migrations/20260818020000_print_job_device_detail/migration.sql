-- What the device saw, where an operator can read it.
--
-- The spooler's own job identifier, the evidence a completion was confirmed
-- from, and where the host spent its time all existed only in a file on the
-- kiosk. Diagnosing a printer therefore meant physically visiting the machine —
-- which is the wrong shape for an unattended vending kiosk, and the wrong place
-- to leave an operational record of what was printed.
--
-- It does not go in `detail`. That column is free-form JSON written by several
-- paths and the reader role deliberately holds no grant on it; granting it to
-- surface this would hand over everything any future writer puts there. This
-- column carries only the bounded shape the agent contract validates, so it can
-- be granted on its own terms.
--
-- It is evidence, never a decision. The settlement reducer never reads it, so a
-- device cannot move its own outcome or a refund by what it claims to have seen.

ALTER TABLE "print_job_events" ADD COLUMN "device_detail" JSONB;

-- The control plane reads it; nothing else needs to.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'printing_kiosk_admin_reader') THEN
    GRANT SELECT ("device_detail") ON "print_job_events" TO "printing_kiosk_admin_reader";
  END IF;
END
$$;
