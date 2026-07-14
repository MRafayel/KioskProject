import { afterEach, describe, expect, it } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";

import { buildAgent } from "./app.js";

const openApps: Awaited<ReturnType<typeof buildAgent>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("kiosk agent health", () => {
  it("is print-only and monochrome", async () => {
    const app = await buildAgent(loadEnvironment({ NODE_ENV: "test" }));
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      productScope: {
        service: "PRINT_ONLY",
        outputMode: "MONOCHROME"
      }
    });
  });
});
