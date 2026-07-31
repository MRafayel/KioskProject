import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { createDatabaseClient } from "../src/index.js";
import { assertSafeDevelopmentSeedTarget } from "../src/development-seed.js";

loadDotenv({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  override: false,
  quiet: true
});

const configuredConnectionString = process.env.DATABASE_URL;
const connectionString =
  configuredConnectionString ??
  "postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk";

assertSafeDevelopmentSeedTarget({
  nodeEnvironment: process.env.NODE_ENV,
  databaseUrl: connectionString,
  usesBuiltInDefault: configuredConnectionString === undefined
});

const database = createDatabaseClient(connectionString);
const developmentKioskId = process.env.DEV_KIOSK_ID ?? "kiosk_dev_001";
const developmentKioskKey = process.env.DEV_KIOSK_API_KEY ?? "development-only-kiosk-key";
const credentialDigest = createHash("sha256").update(developmentKioskKey, "utf8").digest("hex");

await database.systemMetadata.upsert({
  where: { key: "product_scope" },
  create: {
    key: "product_scope",
    value: {
      service: "PRINT_ONLY",
      outputMode: "MONOCHROME",
      scanningEnabled: false,
      photocopyEnabled: false
    }
  },
  update: {
    value: {
      service: "PRINT_ONLY",
      outputMode: "MONOCHROME",
      scanningEnabled: false,
      photocopyEnabled: false
    }
  }
});

// The capability snapshot is what settings validation trusts. It describes the
// simulated pilot device: A4 monochrome, long-edge duplex, and one or two
// pages per sheet. A real printer replaces these values in Phase 10.
const developmentCapabilities = {
  service: "PRINT_ONLY",
  outputMode: "MONOCHROME",
  colorModes: ["MONOCHROME"],
  paperSizes: ["A4"],
  duplex: true,
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
  scalingModes: ["FIT", "ACTUAL_SIZE"],
  pagesPerSheetOptions: [1, 2],
  maxCopies: 20,
  scanningEnabled: false,
  photocopyEnabled: false
};

await database.kiosk.upsert({
  where: { id: developmentKioskId },
  create: {
    id: developmentKioskId,
    publicCode: "DEV-001",
    name: "Development kiosk",
    status: "ACTIVE",
    timezone: "Asia/Yerevan",
    capabilities: developmentCapabilities,
    capabilitiesVersion: 2
  },
  update: {
    status: "ACTIVE",
    capabilities: developmentCapabilities,
    capabilitiesVersion: 2
  }
});

const developmentScopes = [
  "sessions:create",
  "sessions:read",
  "sessions:cancel",
  "files:read",
  "files:delete",
  "settings:write",
  "quotes:create",
  "quotes:read"
];

await database.kioskCredential.upsert({
  where: { credentialId: "development-kiosk-credential" },
  create: {
    id: "01900000-0000-7000-8000-000000000001",
    kioskId: developmentKioskId,
    credentialId: "development-kiosk-credential",
    secretDigest: credentialDigest,
    scopes: developmentScopes
  },
  update: {
    kioskId: developmentKioskId,
    secretDigest: credentialDigest,
    scopes: developmentScopes,
    revokedAt: null,
    expiresAt: null
  }
});

/**
 * Development tariff.
 *
 * These amounts are integer AMD minor units (exponent 2, so 5000 is 50.00 AMD)
 * and are a placeholder for local work, not a commercial price list. A local
 * accountant must validate the tax rate, the rounding point, and receipt rules
 * before real sales. A published rule set is immutable: change prices by
 * publishing the next version, never by editing this one in place.
 */
const developmentPricingVersion = "price-v1";
const existingRuleSet = await database.pricingRuleSet.findUnique({
  where: { version: developmentPricingVersion }
});

if (!existingRuleSet) {
  await database.$transaction(async (transaction) => {
    // Archive any earlier published global tariff so the partial unique index
    // that permits one published set per scope keeps holding.
    await transaction.pricingRuleSet.updateMany({
      where: { scope: "GLOBAL", scopeRef: "", status: "PUBLISHED" },
      data: { status: "ARCHIVED", archivedAt: new Date() }
    });

    const ruleSet = await transaction.pricingRuleSet.create({
      data: {
        id: "01900000-0000-7000-8000-000000000101",
        version: developmentPricingVersion,
        scope: "GLOBAL",
        scopeRef: "",
        currency: "AMD",
        currencyExponent: 2,
        status: "PUBLISHED",
        rounding: "HALF_UP",
        taxMode: "EXCLUSIVE",
        minimumApplication: "BEFORE_TAX",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        publishedAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });

    await transaction.pricingRule.create({
      data: {
        id: "01900000-0000-7000-8000-000000000102",
        ruleSetId: ruleSet.id,
        service: "PRINT",
        paperSize: "A4",
        colorMode: "MONOCHROME",
        unitAmountMinor: 5000,
        duplexAdjustmentBasisPoints: 0,
        serviceFeeMinor: 0,
        minimumAmountMinor: 10000,
        taxBasisPoints: 2000,
        priority: 0
      }
    });
  });
}

await database.$disconnect();
