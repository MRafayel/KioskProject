import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sessionEventReplayResponseSchema, sessionEventSchema } from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import { authenticateKiosk } from "../sessions/auth.js";
import type { Clock } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const replayQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().max(1_000_000_000).default(0)
});
const REPLAY_PAGE_SIZE = 100;

export function registerEventRoutes(
  app: FastifyInstance,
  dependencies: { database: PrismaClient; clock: Clock }
): void {
  app.get("/v1/sessions/:sessionId/events", async (request, reply) => {
    const identity = await authenticateKiosk(
      request,
      dependencies.database,
      dependencies.clock,
      "sessions:read"
    );
    const params = sessionParamsSchema.parse(request.params);
    const query = replayQuerySchema.parse(request.query ?? {});
    const session = await dependencies.database.printSession.findFirst({
      where: { id: params.sessionId, kioskId: identity.kioskId },
      select: { eventSequence: true }
    });
    if (!session) {
      throw new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
    }

    const records = await dependencies.database.sessionEvent.findMany({
      where: { sessionId: params.sessionId, sequence: { gt: query.after } },
      orderBy: { sequence: "asc" },
      take: REPLAY_PAGE_SIZE + 1
    });
    const hasMore = records.length > REPLAY_PAGE_SIZE;
    const events = records.slice(0, REPLAY_PAGE_SIZE).map((record) =>
      sessionEventSchema.parse({
        id: record.id,
        sessionId: record.sessionId,
        sequence: record.sequence,
        type: record.type,
        payload: record.payload,
        occurredAt: record.occurredAt.toISOString()
      })
    );

    return reply.header("cache-control", "no-store").send(
      sessionEventReplayResponseSchema.parse({
        events,
        latestSequence: session.eventSequence,
        hasMore
      })
    );
  });
}
