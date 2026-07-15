import { createHash } from "node:crypto";

import { createDatabaseClient } from "../src/index.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk";

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

await database.kiosk.upsert({
  where: { id: developmentKioskId },
  create: {
    id: developmentKioskId,
    publicCode: "DEV-001",
    name: "Development kiosk",
    status: "ACTIVE",
    timezone: "Asia/Yerevan",
    capabilities: {
      service: "PRINT_ONLY",
      outputMode: "MONOCHROME",
      paperSizes: ["A4"],
      duplex: true,
      scanningEnabled: false,
      photocopyEnabled: false
    }
  },
  update: {
    status: "ACTIVE",
    capabilities: {
      service: "PRINT_ONLY",
      outputMode: "MONOCHROME",
      paperSizes: ["A4"],
      duplex: true,
      scanningEnabled: false,
      photocopyEnabled: false
    }
  }
});

await database.kioskCredential.upsert({
  where: { credentialId: "development-kiosk-credential" },
  create: {
    id: "01900000-0000-7000-8000-000000000001",
    kioskId: developmentKioskId,
    credentialId: "development-kiosk-credential",
    secretDigest: credentialDigest,
    scopes: ["sessions:create", "sessions:read", "sessions:cancel"]
  },
  update: {
    kioskId: developmentKioskId,
    secretDigest: credentialDigest,
    scopes: ["sessions:create", "sessions:read", "sessions:cancel"],
    revokedAt: null,
    expiresAt: null
  }
});

await database.$disconnect();
