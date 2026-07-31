import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export function createDatabaseClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export { Prisma } from "./generated/prisma/client.js";
export type { PrismaClient };
export { invalidateSessionPricing } from "./session-pricing.js";
export type { QuoteInvalidationReason, SessionPricingInvalidation } from "./session-pricing.js";
