import { createHash } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

/** Small helpers shared by every admin route file. */

/**
 * Nothing the control plane returns may sit in a cache.
 *
 * Every response is about production and is scoped to one signed-in person, so
 * a shared cache — or a browser's back button after a sign-out — must not be
 * able to reproduce it.
 */
export function sendNoStore(reply: FastifyReply, payload: unknown) {
  return reply.header("cache-control", "no-store").send(payload);
}

/**
 * Buckets by source address. Admin routes run before a session exists on the
 * login path, so there is no account to bucket by, and hashing keeps the raw
 * address out of the limiter's key space.
 */
export function adminRateKey(request: FastifyRequest): string {
  return `admin:${createHash("sha256").update(request.ip).digest("hex").slice(0, 32)}`;
}
