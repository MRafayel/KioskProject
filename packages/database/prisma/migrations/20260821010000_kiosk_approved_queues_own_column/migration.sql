-- The operator's queue certification moves out of `capabilities` and into its
-- own column.
--
-- Both used to share one JSONB column: the operator's allowlist beside the
-- capabilities it governs. But a capability report replaces that column
-- wholesale — the device is the authority on what it can do — so every report
-- that changed the capability hash also deleted `approvedQueues`. After that
-- the allowlist matched nothing, no queue could be approved, and because only
-- an approved printer is written, the kiosk's health and warning codes stopped
-- reaching the database too. Nothing recovered it, because the erasure removed
-- the very thing needed to approve a printer again.
--
-- Separating ownership is the fix. A device writes `capabilities`; an operator
-- writes `approved_queues`; neither statement can touch the other's column.

ALTER TABLE "kiosks"
  ADD COLUMN "approved_queues" TEXT[] NOT NULL DEFAULT '{}';

-- Carry across every allowlist still present, preserving operator order.
-- Kiosks already erased by the bug have nothing to carry and stay empty: the
-- list is a human decision and must be re-certified, not guessed at here.
UPDATE "kiosks" AS k
SET "approved_queues" = COALESCE(
  (
    SELECT array_agg(btrim(entry) ORDER BY position)
    FROM jsonb_array_elements_text(k."capabilities" -> 'approvedQueues')
      WITH ORDINALITY AS extracted(entry, position)
    WHERE btrim(entry) <> ''
  ),
  '{}'
)
WHERE jsonb_typeof(k."capabilities" -> 'approvedQueues') = 'array';

-- Drop the old key so there is exactly one source of truth. Leaving it would
-- let a future reader pick the copy that a capability report is free to delete.
UPDATE "kiosks"
SET "capabilities" = "capabilities" - 'approvedQueues'
WHERE jsonb_typeof("capabilities") = 'object'
  AND "capabilities" -> 'approvedQueues' IS NOT NULL;
