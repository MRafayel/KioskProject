import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

loadDotenv({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
  override: false,
  quiet: true
});

const defaultDevelopmentUrl =
  "postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts"
  },
  datasource: {
    url: process.env.DATABASE_URL ?? defaultDevelopmentUrl
  }
});
