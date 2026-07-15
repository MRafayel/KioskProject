import { z } from "zod";

export const sessionStateSchema = z.enum([
  "CREATED",
  "WAITING_FOR_UPLOAD",
  "FILES_UPLOADED",
  "CONFIGURING",
  "AWAITING_PAYMENT",
  "PAID",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "RECOVERY_REQUIRED",
  "EXPIRED",
  "CANCELED"
]);

export const sessionLocaleSchema = z.enum(["en", "ru", "hy"]);

export const createSessionBodySchema = z.object({
  locale: sessionLocaleSchema.default("hy")
});

export const sessionSnapshotSchema = z.object({
  id: z.string().uuid(),
  publicId: z.string().regex(/^ps_[A-Za-z0-9_-]{16,64}$/),
  kioskId: z.string().min(1).max(64),
  locale: sessionLocaleSchema,
  state: sessionStateSchema,
  version: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  hardExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  canceledAt: z.string().datetime().nullable()
});

export const createSessionResponseSchema = z.object({
  session: sessionSnapshotSchema,
  upload: z.object({
    shortCode: z.string().regex(/^\d{8}$/),
    qrUrl: z.string().url()
  })
});

export const getSessionResponseSchema = z.object({ session: sessionSnapshotSchema });
export const cancelSessionResponseSchema = z.object({ session: sessionSnapshotSchema });

export const idempotencyKeySchema = z.string().trim().min(8).max(128);

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
  })
});

export type SessionState = z.infer<typeof sessionStateSchema>;
export type SessionLocale = z.infer<typeof sessionLocaleSchema>;
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;
export type CancelSessionResponse = z.infer<typeof cancelSessionResponseSchema>;
