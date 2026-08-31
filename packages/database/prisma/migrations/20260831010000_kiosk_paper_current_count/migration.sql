-- Replace the paper ledger with the current count.
--
-- `kiosk_paper_events` made the estimate a sum over every refill, correction
-- and print deduction ever recorded. That is a lot of machinery — an insert
-- trigger deriving signed deltas under an advisory lock, append-only triggers,
-- a three-branch shape constraint — to answer a question with one number in it,
-- and the table only ever grows.
--
-- What replaces it is one row per kiosk holding that number. A refill adds, a
-- print subtracts, a correction sets, and each is a single atomic UPDATE, so
-- the concurrency the advisory lock existed for is handled by the row lock
-- Postgres already takes. Reading is a primary-key lookup.
--
-- Two things are kept because dropping them would change behaviour rather than
-- simplify it: the difference between "no paper" and "not tracked here" (an
-- absent row, as an absent ledger was), and the refusal to apply an admin
-- request twice (kiosk_paper_requests, which is never summed).
--
-- The human history is not lost with the table. Every refill and correction is
-- in audit_events with its actor, quantity, reason and resulting total.

CREATE TABLE "kiosk_paper_inventory" (
  "kiosk_id" VARCHAR(64) NOT NULL,
  "estimated_sheets" INTEGER NOT NULL,
  "last_refill_sheets" INTEGER,
  "last_refill_note" VARCHAR(280),
  "last_refill_by_admin_id" UUID,
  "last_refill_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "kiosk_paper_inventory_pkey" PRIMARY KEY ("kiosk_id"),
  CONSTRAINT "kiosk_paper_inventory_sheets_check"
    CHECK ("estimated_sheets" BETWEEN 0 AND 100000),
  CONSTRAINT "kiosk_paper_inventory_last_refill_check" CHECK (
    (
      "last_refill_sheets" IS NULL
      AND "last_refill_by_admin_id" IS NULL
      AND "last_refill_at" IS NULL
    )
    OR (
      "last_refill_sheets" BETWEEN 1 AND 100000
      AND "last_refill_by_admin_id" IS NOT NULL
      AND "last_refill_at" IS NOT NULL
    )
  )
);

ALTER TABLE "kiosk_paper_inventory"
  ADD CONSTRAINT "kiosk_paper_inventory_kiosk_id_fkey"
  FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kiosk_paper_inventory"
  ADD CONSTRAINT "kiosk_paper_inventory_last_refill_by_admin_id_fkey"
  FOREIGN KEY ("last_refill_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Applied admin requests, so a retried refill adds paper once. Never summed,
-- never consulted to work out the count, and safe to prune by age.
CREATE TABLE "kiosk_paper_requests" (
  "request_key" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "type" VARCHAR(24) NOT NULL,
  "request_digest" VARCHAR(64) NOT NULL,
  "quantity_sheets" INTEGER NOT NULL,
  "applied_sheets" INTEGER NOT NULL,
  "resulting_sheets" INTEGER NOT NULL,
  "reason" VARCHAR(280),
  "admin_user_id" UUID NOT NULL,
  "admin_role" VARCHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "kiosk_paper_requests_pkey" PRIMARY KEY ("request_key"),
  CONSTRAINT "kiosk_paper_requests_shape_check" CHECK (
    "type" IN ('REFILL', 'CORRECTION')
    AND "quantity_sheets" BETWEEN 0 AND 100000
    AND "resulting_sheets" BETWEEN 0 AND 100000
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "admin_role" IN ('OPERATOR', 'ADMIN', 'TECHNICAL_ADMIN')
    AND ("reason" IS NULL OR length(btrim("reason")) >= 3)
    AND ("type" <> 'CORRECTION' OR "reason" IS NOT NULL)
    AND ("type" <> 'REFILL' OR "quantity_sheets" >= 1)
  )
);

CREATE INDEX "kiosk_paper_requests_kiosk_id_created_at_idx"
  ON "kiosk_paper_requests" ("kiosk_id", "created_at");

ALTER TABLE "kiosk_paper_requests"
  ADD CONSTRAINT "kiosk_paper_requests_kiosk_id_fkey"
  FOREIGN KEY ("kiosk_id") REFERENCES "kiosks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kiosk_paper_requests"
  ADD CONSTRAINT "kiosk_paper_requests_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Carry the current estimate across, for the last time it has to be summed.
-- Only kiosks a person actually started tracking get a row: a kiosk with
-- deductions but no refill or correction was never tracked, and inventing zero
-- for it here would start refusing jobs it can print.
INSERT INTO "kiosk_paper_inventory" (
  "kiosk_id", "estimated_sheets",
  "last_refill_sheets", "last_refill_note", "last_refill_by_admin_id", "last_refill_at",
  "created_at", "updated_at"
)
SELECT
  totals."kiosk_id",
  GREATEST(0, LEAST(100000, totals."estimate")),
  refill."quantity_sheets",
  refill."reason",
  refill."recorded_by_admin_id",
  refill."created_at",
  totals."first_at",
  totals."last_at"
FROM (
  SELECT
    "kiosk_id",
    COALESCE(SUM("delta_sheets"), 0)::int AS "estimate",
    MIN("created_at") AS "first_at",
    MAX("created_at") AS "last_at"
  FROM "kiosk_paper_events"
  GROUP BY "kiosk_id"
  HAVING bool_or("type" IN ('REFILL', 'CORRECTION'))
) AS totals
LEFT JOIN LATERAL (
  SELECT "quantity_sheets", "reason", "recorded_by_admin_id", "created_at"
    FROM "kiosk_paper_events"
   WHERE "kiosk_id" = totals."kiosk_id"
     AND "type" = 'REFILL'
     AND "recorded_by_admin_id" IS NOT NULL
   ORDER BY "created_at" DESC, "id" DESC
   LIMIT 1
) AS refill ON TRUE;

-- Carry the applied request keys across too, so a retry that was in flight
-- across the deployment is still recognised as one.
INSERT INTO "kiosk_paper_requests" (
  "request_key", "kiosk_id", "type", "request_digest",
  "quantity_sheets", "applied_sheets", "resulting_sheets",
  "reason", "admin_user_id", "admin_role", "created_at"
)
SELECT
  event."request_key",
  event."kiosk_id",
  event."type",
  event."request_digest",
  event."quantity_sheets",
  event."delta_sheets",
  GREATEST(0, LEAST(100000, (
    SELECT COALESCE(SUM(earlier."delta_sheets"), 0)::int
      FROM "kiosk_paper_events" AS earlier
     WHERE earlier."kiosk_id" = event."kiosk_id"
       AND (
         earlier."created_at" < event."created_at"
         OR (earlier."created_at" = event."created_at" AND earlier."id" <= event."id")
       )
  ))),
  event."reason",
  event."recorded_by_admin_id",
  event."recorded_by_role",
  event."created_at"
FROM "kiosk_paper_events" AS event
WHERE event."request_key" IS NOT NULL
  AND event."recorded_by_admin_id" IS NOT NULL
  AND event."recorded_by_role" IS NOT NULL
  AND event."type" IN ('REFILL', 'CORRECTION');

-- `kiosk_paper_events` was moved to the admin owner role after it was created,
-- so the connection running migrations may no longer own it — and DROP needs
-- ownership. Take it back when this role is entitled to; when it is not, the
-- DROP below fails loudly and the migration is re-run as the owner, which is
-- the right outcome rather than a silent half-migration.
DO $$
DECLARE
  current_owner NAME;
BEGIN
  SELECT tableowner INTO current_owner
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename = 'kiosk_paper_events';

  IF current_owner IS NOT NULL
     AND current_owner <> CURRENT_USER
     AND pg_has_role(CURRENT_USER, current_owner, 'MEMBER') THEN
    EXECUTE format('ALTER TABLE %I OWNER TO %I', 'kiosk_paper_events', CURRENT_USER);
  END IF;
END $$;

-- The append-only triggers refuse to let their own rows change, not to let the
-- table go, but drop them explicitly so nothing outlives what it belonged to.
DROP TRIGGER IF EXISTS "kiosk_paper_events_prepare_insert" ON "kiosk_paper_events";
DROP TRIGGER IF EXISTS "kiosk_paper_events_no_update" ON "kiosk_paper_events";
DROP TRIGGER IF EXISTS "kiosk_paper_events_no_delete" ON "kiosk_paper_events";
DROP TRIGGER IF EXISTS "kiosk_paper_events_no_truncate" ON "kiosk_paper_events";

DROP TABLE "kiosk_paper_events";

DROP FUNCTION IF EXISTS "kiosk_paper_events_prepare"();
DROP FUNCTION IF EXISTS "kiosk_paper_events_reject_rewrite"();
