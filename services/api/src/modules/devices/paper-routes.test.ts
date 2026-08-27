import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@printing-kiosk/database";

import { ApiError } from "../sessions/errors.js";
import type { KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { PrinterReadinessGate } from "./readiness.js";
import { registerDeviceRoutes } from "./routes.js";
import type { DeviceRegistryService } from "./service.js";

/**
 * What a touchscreen may learn about the paper in its own kiosk.
 *
 * The route exists so a customer can be told what the machine can print before
 * they pay for something larger. Two things have to stay true of it: it answers
 * about one kiosk and only the caller's own, and it never turns "nobody is
 * counting here" into a number.
 */

const KIOSK_ID = "kiosk_dev_001";
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function buildApp(paper: { initialized: boolean; sum: number | null }) {
  const findFirst = vi.fn().mockResolvedValue(paper.initialized ? { id: "event" } : null);
  const aggregate = vi.fn().mockResolvedValue({ _sum: { deltaSheets: paper.sum } });
  const database = { kioskPaperEvent: { findFirst, aggregate } } as unknown as PrismaClient;

  const app = Fastify();
  openApps.push(app);
  // The same mapping `app.ts` installs, so a refusal here is checked as the
  // status a kiosk would actually receive.
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });

  registerDeviceRoutes(app, {
    database,
    clock: { now: () => new Date("2026-08-27T10:00:00.000Z") },
    devices: {} as unknown as DeviceRegistryService,
    kioskAuthentication: {
      authenticate: vi.fn().mockResolvedValue({ kioskId: KIOSK_ID })
    } as Partial<KioskAuthenticationThrottle> as KioskAuthenticationThrottle,
    printerReadiness: {} as unknown as PrinterReadinessGate
  });

  return { app, findFirst };
}

describe("the kiosk paper estimate route", () => {
  it("answers with the sheets its own ledger sums to", async () => {
    const { app } = buildApp({ initialized: true, sum: 118 });

    const response = await app.inject({ method: "GET", url: `/v1/kiosks/${KIOSK_ID}/paper` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ paper: { estimatedSheets: 118 } });
    // Never cached: a stale count is the one thing this answer must not be.
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("answers null rather than zero for a kiosk nobody tracks", async () => {
    const { app } = buildApp({ initialized: false, sum: null });

    const response = await app.inject({ method: "GET", url: `/v1/kiosks/${KIOSK_ID}/paper` });

    expect(response.json()).toEqual({ paper: { estimatedSheets: null } });
  });

  it("tells a credential nothing about another kiosk, including that it exists", async () => {
    const { app, findFirst } = buildApp({ initialized: true, sum: 118 });

    const response = await app.inject({ method: "GET", url: "/v1/kiosks/kiosk_someone_else/paper" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "KIOSK_NOT_FOUND" } });
    // Refused before the ledger was read at all.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("carries no ledger, no operator and no timestamps", async () => {
    // A screen strangers stand in front of is told a count and nothing else.
    // Who refilled the tray and when is an operator's business.
    const { app } = buildApp({ initialized: true, sum: 40 });

    const response = await app.inject({ method: "GET", url: `/v1/kiosks/${KIOSK_ID}/paper` });

    expect(Object.keys(response.json<{ paper: Record<string, unknown> }>().paper)).toEqual([
      "estimatedSheets"
    ]);
  });
});
