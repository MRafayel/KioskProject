import type { FastifyRequest } from "fastify";

import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock } from "./crypto.js";
import { digestKioskCredential } from "./crypto.js";
import { ApiError } from "./errors.js";

export interface KioskIdentity {
  kioskId: string;
  credentialId: string;
}

export async function authenticateKiosk(
  request: FastifyRequest,
  database: PrismaClient,
  clock: Clock,
  requiredScope: string
): Promise<KioskIdentity> {
  const authorization = request.headers.authorization;
  const rawCredential = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  return authenticateKioskCredential(rawCredential, database, clock, requiredScope);
}

export async function authenticateKioskCredential(
  rawCredential: string,
  database: PrismaClient,
  clock: Clock,
  requiredScope: string
): Promise<KioskIdentity> {
  if (rawCredential.length < 24 || rawCredential.length > 512) throw unauthorized();

  const credential = await database.kioskCredential.findUnique({
    where: { secretDigest: digestKioskCredential(rawCredential) },
    include: { kiosk: true }
  });

  const now = clock.now();
  if (
    !credential ||
    credential.revokedAt ||
    (credential.expiresAt && now.getTime() >= credential.expiresAt.getTime())
  ) {
    throw unauthorized();
  }

  if (credential.kiosk.status !== "ACTIVE") {
    throw new ApiError(403, "KIOSK_DISABLED", "This kiosk is not active.");
  }

  if (!credential.scopes.includes(requiredScope)) {
    throw new ApiError(403, "INSUFFICIENT_SCOPE", "The kiosk credential lacks this scope.");
  }

  // Polling routes authenticate frequently. Persisting this heartbeat at most
  // once per minute avoids a database write for every status poll.
  await database.kioskCredential.updateMany({
    where: {
      id: credential.id,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: new Date(now.getTime() - 60_000) } }]
    },
    data: { lastUsedAt: now }
  });

  return { kioskId: credential.kioskId, credentialId: credential.credentialId };
}

function unauthorized(): ApiError {
  return new ApiError(401, "INVALID_KIOSK_CREDENTIAL", "Kiosk authentication failed.");
}
