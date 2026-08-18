-- Separate the printer from the driver that drives it.
--
-- The device host reported the driver name as the make and model, and the
-- driver's version as the device firmware. Both were wrong in the same
-- direction: a certification record that named `Canon Generic Plus UFR II`
-- described a driver used across most of a product line, and could not say
-- which machine an operator actually certified.
--
-- The host now reports the physical model separately and answers null rather
-- than guessing, so `make_and_model` may legitimately be empty where it used to
-- carry a driver name. The driver's version gets a column of its own instead of
-- masquerading as firmware, which Windows does not expose for a GDI USB queue.

ALTER TABLE "printers" ADD COLUMN "driver_version" VARCHAR(400);

-- The old rows carry a driver name in `make_and_model` and a driver version in
-- `firmware`. Move the version to where it belongs and clear the two fields
-- that were describing a driver rather than a printer, so nothing downstream
-- reads a stale value as though it were the certified device. The agent
-- republishes both on its next heartbeat.
UPDATE "printers"
SET "driver_version" = "firmware",
    "firmware" = NULL,
    "make_and_model" = NULL
WHERE "make_and_model" IS NOT NULL
  AND "driver_name" IS NOT NULL
  AND "make_and_model" = "driver_name";
