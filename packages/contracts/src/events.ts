import { z } from "zod";

import { paymentFailureCodeSchema, paymentStatusSchema } from "./payments.js";
import { printFailureCodeSchema, printResultConfidenceSchema } from "./print-jobs.js";
import { quoteInvalidationReasonSchema } from "./quotes.js";
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
    type: z.literal("settings.updated"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        settingsRevision: z.number().int().positive(),
        state: sessionStateSchema,
        version: z.number().int().positive(),
        selectedPages: z.number().int().positive(),
        printedSides: z.number().int().positive(),
        physicalSheets: z.number().int().positive()
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("quote.created"),
    // Money is present because the kiosk must display an authoritative total,
    // but nothing here identifies a document or its contents.
    payload: z
      .object({
        sessionId: sessionIdSchema,
        quoteId: z.string().uuid(),
        settingsRevision: z.number().int().positive(),
        pricingVersion: z.string().min(1).max(40),
        currency: z.string().regex(/^[A-Z]{3}$/),
        currencyExponent: z.number().int().min(0).max(4),
        totalMinor: z.number().int().nonnegative(),
        expiresAt: z.string().datetime()
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("quote.invalidated"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        quoteId: z.string().uuid(),
        reason: quoteInvalidationReasonSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("payment.pending"),
    // The amount is the one the control plane locked, so the screen can show
    // what is being charged. No provider reference, card detail or document
    // identity is ever carried here.
    payload: z
      .object({
        sessionId: sessionIdSchema,
        paymentId: z.string().uuid(),
        quoteId: z.string().uuid(),
        state: sessionStateSchema,
        version: z.number().int().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        currencyExponent: z.number().int().min(0).max(4),
        amountMinor: z.number().int().nonnegative(),
        expiresAt: z.string().datetime()
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("payment.succeeded"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        paymentId: z.string().uuid(),
        quoteId: z.string().uuid(),
        state: sessionStateSchema,
        version: z.number().int().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        currencyExponent: z.number().int().min(0).max(4),
        amountMinor: z.number().int().nonnegative(),
        capturedAt: z.string().datetime()
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("payment.failed"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        paymentId: z.string().uuid(),
        state: sessionStateSchema,
        version: z.number().int().positive(),
        status: paymentStatusSchema,
        failureCode: paymentFailureCodeSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("print.started"),
    payload: statePayloadSchema.extend({ printJobId: z.string().uuid() }).strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("print.failed"),
    // A definite failure: nothing usable came out, and the money is owed back.
    // No device string, no filename — only what the screen must say.
    payload: statePayloadSchema
      .extend({
        printJobId: z.string().uuid(),
        failureCode: printFailureCodeSchema,
        resultConfidence: printResultConfidenceSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("print.recovery_required"),
    // The device could not say whether paper emerged. Nobody guesses here:
    // the kiosk shows a recovery screen and an operator settles it.
    payload: statePayloadSchema
      .extend({
        printJobId: z.string().uuid(),
        failureCode: printFailureCodeSchema,
        resultConfidence: printResultConfidenceSchema
      })
      .strict()
  }),
  eventBaseSchema.extend({
    type: z.literal("session.completed"),
    payload: statePayloadSchema
  }),
  eventBaseSchema.extend({
    type: z.literal("session.canceled"),
    payload: statePayloadSchema
  }),
  eventBaseSchema.extend({
    type: z.literal("session.expired"),
    payload: statePayloadSchema
  }),
  // Retention's durable "the documents are gone" signal. It carries a time and
  // nothing else: an operations consumer needs to know that a session was
  // emptied, never what was in it.
  eventBaseSchema.extend({
    type: z.literal("cleanup.completed"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        filesDeletedAt: z.string().datetime()
      })
      .strict()
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
