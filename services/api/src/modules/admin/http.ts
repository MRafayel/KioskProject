import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "../sessions/errors.js";

/** Small helpers shared by every admin route file. */

/**
 * One refusal for "does not exist" and "not yours".
 *
 * The two must be indistinguishable, so the message is written for the case
 * where the record is genuinely absent and used for both. A 403 on an
 * out-of-scope identifier confirms that the identifier names something real,
 * which is the entire mechanism of an enumeration attack.
 *
 * Shared by the read and the write paths deliberately: an operator who cannot
 * see a job must get the same answer whether they try to read it or to act on
 * it, and two copies of this would eventually stop agreeing.
 */
export function adminNotFound(): ApiError {
  return new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
}

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

/**
 * The same, in its own bucket.
 *
 * Every limiter in this process shares one store, keyed by whatever its key
 * generator returns — so two limits with different ceilings and the same key
 * are one limit with the lower ceiling. That is not a hypothetical: reading the
 * dashboard would otherwise spend the much smaller allowance reserved for
 * operator actions, and an operator would be told to slow down for having
 * looked at a screen.
 *
 * Each family of routes therefore names its own bucket.
 */
export function adminNamespacedRateKey(namespace: string): (request: FastifyRequest) => string {
  return (request) =>
    `admin:${namespace}:${createHash("sha256").update(request.ip).digest("hex").slice(0, 32)}`;
}

/**
 * A ceiling on what one signed-in session may do, applied after it is known
 * which session that is.
 *
 * The address limit above cannot answer this. Operators share a site's network,
 * so a stolen session sitting behind the same router as three honest ones would
 * otherwise spend their allowance and lock them out during the incident it
 * caused — and an attacker could not be told apart from a colleague on a busy
 * afternoon.
 *
 * It has to run after authentication, which is why it is a function to call
 * rather than route configuration: keying on a cookie *before* checking it
 * would let anybody mint a fresh bucket by sending a different random cookie,
 * which is worse than no limit at all because it looks like one.
 */
export interface AdminAccountThrottle {
  (request: FastifyRequest, sessionId: string): Promise<void>;
}

const ADMIN_THROTTLE_KEY = Symbol("adminAccountRateKey");

/**
 * `namespace` separates this throttle's bucket from every other one, for the
 * same reason as above: reads and actions have very different ceilings, and a
 * shared key would silently apply the smaller of them to both.
 */
export function createAdminAccountThrottle(
  app: FastifyInstance,
  limits: { namespace: string; max: number; timeWindow: string }
): AdminAccountThrottle {
  const limiter = app.createRateLimit({
    max: limits.max,
    timeWindow: limits.timeWindow,
    // The key is placed on the request immediately before the call below, so
    // the fallback only ever applies if somebody calls the limiter directly.
    keyGenerator: (request) => {
      const key: unknown = Reflect.get(request, ADMIN_THROTTLE_KEY);
      return typeof key === "string" ? key : `admin-account:${limits.namespace}:${request.ip}`;
    }
  });

  return async (request, sessionId) => {
    Reflect.set(request, ADMIN_THROTTLE_KEY, `admin-account:${limits.namespace}:${sessionId}`);
    const allowance = await limiter(request, { increment: true });
    // `isAllowed` reports an allow-list hit, not "under the limit", and is
    // false for every ordinary request — reading it as the latter would refuse
    // the first request any session ever made. The exceeded flag is what
    // decides, and it only exists on the branch that counts.
    if (!allowance.isAllowed && allowance.isExceeded) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Too many requests. Please wait before trying again."
      );
    }
  };
}
