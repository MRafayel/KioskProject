import type { PrismaClient } from "@printing-kiosk/database";

import type { ObjectStore } from "./modules/files/object-store.js";

const PROBE_TIMEOUT_MS = 750;

/**
 * Resolves when this process can actually reach Redis. The realtime gateway
 * owns the only Redis connection the API keeps, so readiness borrows it rather
 * than opening a second one that could be healthy while the real one is not.
 */
export type RedisProbe = () => Promise<unknown>;

export interface ReadinessDependencies {
  database: PrismaClient;
  objectStore: ObjectStore;
  redis: RedisProbe;
}

/**
 * Each dependency answers a real request. A reachable port is not evidence: a
 * TCP connect succeeds against the wrong service, a wrong database, an
 * unmigrated schema, or an exhausted connection pool.
 */
export async function checkInfrastructure(
  dependencies: ReadinessDependencies
): Promise<Record<string, "ok" | "failed">> {
  const [postgres, redis, objectStorage] = await Promise.all([
    probe(async () => {
      await dependencies.database.$queryRaw`SELECT 1`;
    }),
    probe(async () => {
      await dependencies.redis();
    }),
    probe(async () => {
      await dependencies.objectStore.checkReady(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    })
  ]);

  return { postgres, redis, objectStorage };
}

async function probe(operation: () => Promise<void>): Promise<"ok" | "failed"> {
  try {
    await withProbeTimeout(operation());
    return "ok";
  } catch {
    return "failed";
  }
}

function withProbeTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("READINESS_PROBE_TIMEOUT")), PROBE_TIMEOUT_MS);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("READINESS_PROBE_FAILED"));
      }
    );
  });
}
