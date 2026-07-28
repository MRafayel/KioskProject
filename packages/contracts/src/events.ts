import { z } from "zod";

import { sessionStateSchema } from "./sessions.js";
import { readyUploadedFileSnapshotSchema, uploadedFileSnapshotSchema } from "./uploads.js";

const sessionIdSchema = z.string().uuid();
const eventIdSchema = z.string().uuid();
const statePayloadSchema = z
  .object({
    sessionId: sessionIdSchema,
    state: sessionStateSchema,
    version: z.number().int().positive()
  })
  .strict();

const eventBaseSchema = z.object({
  id: eventIdSchema,
  sessionId: sessionIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime()
});

export const sessionEventSchema = z.discriminatedUnion("type", [
  eventBaseSchema.extend({
    type: z.literal("session.created"),
    payload: statePayloadSchema
  }),
  eventBaseSchema.extend({
    type: z.literal("mobile.connected"),
    payload: z.object({ sessionId: sessionIdSchema }).strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("upload.started"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        file: uploadedFileSnapshotSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("file.uploaded"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        file: uploadedFileSnapshotSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("file.rejected"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        file: uploadedFileSnapshotSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("file.ready"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        file: readyUploadedFileSnapshotSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("file.deleted"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        fileId: z.string().uuid()
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("session.canceled"),
    payload: statePayloadSchema
  }),
  eventBaseSchema.extend({
    type: z.literal("session.expired"),
    payload: statePayloadSchema
  })
]);

export const sessionEventReplayResponseSchema = z
  .object({
    events: z.array(sessionEventSchema),
    latestSequence: z.number().int().nonnegative(),
    hasMore: z.boolean()
  })
  .strict();

export const realtimeDeliveryJobSchema = z
  .object({
    kioskId: z.string().min(1).max(64),
    event: sessionEventSchema
  })
  .strict();

export const realtimeSocketAuthSchema = z
  .object({
    kioskId: z.string().min(1).max(64),
    credential: z.string().min(24).max(512)
  })
  .strict();

export const SESSION_EVENT_QUEUE_NAME = "session-realtime-events-v1";
export const SESSION_EVENT_SOCKET_NAME = "session:event";

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventReplayResponse = z.infer<typeof sessionEventReplayResponseSchema>;
export type RealtimeDeliveryJob = z.infer<typeof realtimeDeliveryJobSchema>;
export type RealtimeSocketAuth = z.infer<typeof realtimeSocketAuthSchema>;
