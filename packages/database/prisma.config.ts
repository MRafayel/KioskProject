import "dotenv/config";

import { defineConfig } from "prisma/config";

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
