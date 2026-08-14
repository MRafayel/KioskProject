-- Phase 10: physical printer integration.
--
-- Until now a kiosk's capabilities were a row somebody seeded by hand and the
-- printer was a directory. This migration adds the two records a real device
-- needs: the agent installation that speaks for a machine, and the print queues
-- that machine offers. Only a queue an operator certified may publish what it
-- can do, because that is what a customer is offered and what a paid quote is
-- bound to.

-- ---------------------------------------------------------------------------
-- The agent installation.
-- ---------------------------------------------------------------------------

CREATE TABLE "kiosk_agents" (
  "id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "agent_id" UUID NOT NULL,
  "agent_version" VARCHAR(64) NOT NULL,
  "platform" VARCHAR(16) NOT NULL,
  "platform_release" VARCHAR(120),
  "adapter" VARCHAR(16) NOT NULL,
  "queue_name" VARCHAR(220),
  "printer_health" VARCHAR(16) NOT NULL DEFAULT 'OFFLINE',
  "capability_hash" VARCHAR(64),
  "active_operations" INTEGER NOT NULL DEFAULT 0,
  "registered_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_heartbeat_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "kiosk_agents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "kiosk_agents_kiosk_id_fkey"
    FOREIGN KEY ("kiosk_id") REFERENCES "kiosks" ("id") ON DELETE CASCADE,
  CONSTRAINT "kiosk_agents_platform_check"
    CHECK ("platform" IN ('win32', 'linux', 'darwin')),
  CONSTRAINT "kiosk_agents_adapter_check"
    CHECK ("adapter" IN ('MOCK', 'IPP', 'WINDOWS')),
  CONSTRAINT "kiosk_agents_printer_health_check"
    CHECK ("printer_health" IN ('READY', 'WARNING', 'OFFLINE')),
  CONSTRAINT "kiosk_agents_capability_hash_check"
    CHECK ("capability_hash" IS NULL OR "capability_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "kiosk_agents_active_operations_check"
    CHECK ("active_operations" >= 0 AND "active_operations" <= 64)
);

-- An installation identifier is global: the same agent must not be able to
-- claim to be two kiosks, and a kiosk must not be able to claim somebody
-- else's installation.
CREATE UNIQUE INDEX "kiosk_agents_agent_id_key" ON "kiosk_agents" ("agent_id");
CREATE INDEX "kiosk_agents_kiosk_heartbeat_idx"
  ON "kiosk_agents" ("kiosk_id", "last_heartbeat_at");

-- ---------------------------------------------------------------------------
-- The print queues a kiosk machine offers.
-- ---------------------------------------------------------------------------

CREATE TABLE "printers" (
  "id" UUID NOT NULL,
  "kiosk_id" VARCHAR(64) NOT NULL,
  "queue_name" VARCHAR(220) NOT NULL,
  "adapter" VARCHAR(16) NOT NULL,
  "approval" VARCHAR(16) NOT NULL DEFAULT 'NOT_APPROVED',
  "queue_state" VARCHAR(16) NOT NULL DEFAULT 'ERROR',
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "device_uri" VARCHAR(400),
  "driver_name" VARCHAR(400),
  "port_name" VARCHAR(400),
  "device_id" VARCHAR(400),
  "make_and_model" VARCHAR(400),
  "firmware" VARCHAR(400),
  "health" VARCHAR(16) NOT NULL DEFAULT 'OFFLINE',
  "warning_code" VARCHAR(32),
  "capabilities" JSONB,
  "capability_hash" VARCHAR(64),
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_healthy_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "printers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "printers_kiosk_id_fkey"
    FOREIGN KEY ("kiosk_id") REFERENCES "kiosks" ("id") ON DELETE CASCADE,
  CONSTRAINT "printers_adapter_check"
    CHECK ("adapter" IN ('MOCK', 'IPP', 'WINDOWS')),
  CONSTRAINT "printers_approval_check"
    CHECK ("approval" IN ('APPROVED', 'NOT_APPROVED', 'SHARED', 'AMBIGUOUS')),
  CONSTRAINT "printers_queue_state_check"
    CHECK ("queue_state" IN ('READY', 'PAUSED', 'OFFLINE', 'ERROR')),
  CONSTRAINT "printers_health_check"
    CHECK ("health" IN ('READY', 'WARNING', 'OFFLINE')),
  CONSTRAINT "printers_warning_code_check"
    CHECK ("warning_code" IS NULL OR "warning_code" IN ('TONER_LOW', 'PAPER_LOW', 'OUTPUT_TRAY_FULL')),
  CONSTRAINT "printers_capability_hash_check"
    CHECK ("capability_hash" IS NULL OR "capability_hash" ~ '^[0-9a-f]{64}$'),
  -- Capabilities are what a customer is offered and what a quote is priced
  -- against. Only a queue an operator certified may carry them, and a
  -- certified queue that carries none has published nothing to sell.
  CONSTRAINT "printers_capabilities_require_approval_check"
    CHECK (
      ("approval" = 'APPROVED' AND "capabilities" IS NOT NULL AND "capability_hash" IS NOT NULL)
      OR ("approval" <> 'APPROVED' AND "capabilities" IS NULL AND "capability_hash" IS NULL)
    ),
  -- A queue name is a name, not a payload. Control and formatting characters
  -- would reach an operator console and a support ticket verbatim.
  CONSTRAINT "printers_queue_name_check"
    CHECK ("queue_name" ~ '^[^[:cntrl:]]+$')
);

CREATE UNIQUE INDEX "printers_kiosk_queue_key" ON "printers" ("kiosk_id", "queue_name");
CREATE INDEX "printers_kiosk_approval_idx" ON "printers" ("kiosk_id", "approval");

-- One kiosk prints to one certified queue. Allowing two approved rows would
-- make "which printer is this kiosk's printer" a question with two answers,
-- and the settings a customer is offered would depend on which one was read.
CREATE UNIQUE INDEX "printers_one_approved_per_kiosk_idx"
  ON "printers" ("kiosk_id")
  WHERE "approval" = 'APPROVED';
