import { createDatabaseClient } from "../src/index.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk";

const database = createDatabaseClient(connectionString);

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

await database.$disconnect();
