import { connect } from "node:net";

import type { Environment } from "@printing-kiosk/config";

import type { ObjectStore } from "./modules/files/object-store.js";

export async function checkInfrastructure(
  environment: Environment,
  objectStore: ObjectStore
): Promise<Record<string, "ok" | "failed">> {
  const databaseUrl = new URL(environment.DATABASE_URL);
  const redisUrl = new URL(environment.REDIS_URL);
  const [postgres, redis, objectStorage] = await Promise.all([
    checkTcp(databaseUrl.hostname, numberPort(databaseUrl, 5432)),
    checkTcp(redisUrl.hostname, numberPort(redisUrl, 6379)),
    checkObjectStore(objectStore)
  ]);

  return { postgres, redis, objectStorage };
}

function numberPort(url: URL, fallback: number): number {
  return url.port ? Number.parseInt(url.port, 10) : fallback;
}

function checkTcp(host: string, port: number): Promise<"ok" | "failed"> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (status: "ok" | "failed") => {
      socket.destroy();
      resolve(status);
    };

    socket.setTimeout(750);
    socket.once("connect", () => finish("ok"));
    socket.once("timeout", () => finish("failed"));
    socket.once("error", () => finish("failed"));
  });
}

async function checkObjectStore(objectStore: ObjectStore): Promise<"ok" | "failed"> {
  try {
    await objectStore.checkReady(AbortSignal.timeout(750));
    return "ok";
  } catch {
    return "failed";
  }
}
