import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "@printing-kiosk/database";

import { authenticateKiosk, type KioskIdentity } from "./auth.js";
import type { Clock } from "./crypto.js";
import { ApiError } from "./errors.js";

const FAILED_AUTHENTICATION_MAX = 20;
const FAILED_AUTHENTICATION_WINDOW = "5 minutes";
const RECENTLY_ACCEPTED_TTL_MS = 10 * 60_000;
const RECENTLY_ACCEPTED_LIMIT = 512;

export interface KioskAuthenticationThrottle {
  authenticate(
    request: FastifyRequest,
    database: PrismaClient,
    clock: Clock,
    requiredScope: string
  ): Promise<KioskIdentity>;
}

/**
 * Kiosk credentials are looked up by digest, so every guess costs a database
 * query. Counting only the failures lets a working kiosk poll freely while an
 * unusable credential quickly stops being answered at all.
 *
 * The address alone cannot decide this. Behind the reverse proxy the platform
 * is designed around, every kiosk in the fleet shares one apparent address
 * unless Fastify is configured to trust the forwarding header, so a burst of
 * guesses from anywhere would otherwise refuse every real device. A credential
 * that recently authenticated is therefore always given its lookup; the lookup
 * still decides the outcome, so a revoked key gains nothing from this.
 */
export function createKioskAuthenticationThrottle(
  app: FastifyInstance
): KioskAuthenticationThrottle {
  const failedAuthentication = app.createRateLimit({
    max: FAILED_AUTHENTICATION_MAX,
    timeWindow: FAILED_AUTHENTICATION_WINDOW,
    keyGenerator: (request) => `kiosk-authentication-failure:${request.ip}`
  });
  const recentlyAccepted = new Map<string, number>();

  const wasRecentlyAccepted = (digest: string | undefined): boolean => {
    if (!digest) return false;
    const expiresAt = recentlyAccepted.get(digest);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      recentlyAccepted.delete(digest);
      return false;
    }
    return true;
  };

  const remember = (digest: string | undefined): void => {
    if (!digest) return;
    const now = Date.now();
    for (const [key, expiresAt] of recentlyAccepted) {
      if (expiresAt <= now) recentlyAccepted.delete(key);
    }
    if (recentlyAccepted.size >= RECENTLY_ACCEPTED_LIMIT) {
      const oldest = recentlyAccepted.keys().next();
      if (!oldest.done) recentlyAccepted.delete(oldest.value);
    }
    recentlyAccepted.set(digest, now + RECENTLY_ACCEPTED_TTL_MS);
  };

  return {
    async authenticate(request, database, clock, requiredScope) {
      const presented = presentedCredentialDigest(request);
      if (!wasRecentlyAccepted(presented)) {
        // A plain read reports the current count without spending from it;
        // `isAllowed` is only ever true for an allow-list hit, so the exceeded
        // flag is what decides whether this source still gets an answer.
        const allowance = await failedAuthentication(request, { increment: false });
        if (!allowance.isAllowed && allowance.isExceeded) throw tooManyAuthenticationFailures();
      }

      try {
        const identity = await authenticateKiosk(request, database, clock, requiredScope);
        remember(presented);
        return identity;
      } catch (error) {
        // Only an unusable credential counts. A disabled kiosk or a missing
        // scope comes from a real device holding a real key, and locking that
        // site out of its own API would turn a misconfiguration into an outage.
        if (error instanceof ApiError && error.statusCode === 401) {
          await failedAuthentication(request, { increment: true });
        }
        throw error;
      }
    }
  };
}

function presentedCredentialDigest(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return createHash("sha256").update(authorization).digest("hex");
}

/**
 * Buckets a kiosk against its own credential so one device cannot consume the
 * allowance of another. Requests without a credential fall back to the source
 * address; behind a reverse proxy that is the proxy unless Fastify is
 * configured to trust the forwarding header.
 */
export function kioskRateLimitKey(request: FastifyRequest): string {
  const credential = request.headers.authorization;
  if (!credential) return `address:${request.ip}`;
  return `kiosk:${createHash("sha256").update(credential).digest("hex").slice(0, 32)}`;
}

function tooManyAuthenticationFailures(): ApiError {
  return new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait before trying again.");
}
