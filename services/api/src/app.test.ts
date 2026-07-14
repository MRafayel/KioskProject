import { afterEach, describe, expect, it } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";

import { buildApp } from "./app.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("health routes", () => {
  it("reports the fixed product scope", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      readinessCheck: () => ({
        postgres: "ok",
        redis: "ok",
        objectStorage: "ok"
      })
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "api",
      productScope: {
        service: "PRINT_ONLY",
        outputMode: "MONOCHROME",
        scanningEnabled: false,
        photocopyEnabled: false
      }
    });
  });

  it("reports unavailable dependencies without failing liveness", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      readinessCheck: () => ({
        postgres: "failed",
        redis: "ok",
        objectStorage: "ok"
      })
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: {
        postgres: "failed",
        redis: "ok",
        objectStorage: "ok"
      }
    });
  });
});
