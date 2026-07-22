import { z } from "zod";

import { sessionLocaleSchema, sessionStateSchema } from "./sessions.js";

export const publicSessionIdSchema = z.string().regex(/^ps_[A-Za-z0-9_-]{16,64}$/);
export const uploadTokenSchema = z.string().regex(/^u_[A-Za-z0-9_-]{43}$/);
export const mobileClientNonceSchema = z.string().uuid();
export const clientFileIdSchema = z.string().uuid();

export const mobileExchangeRequestSchema = z.object({
  publicSessionId: publicSessionIdSchema,
  uploadToken: uploadTokenSchema,
  clientNonce: mobileClientNonceSchema
});

export const mobileSessionSchema = z.object({
  id: z.string().uuid(),
  publicId: publicSessionIdSchema,
  locale: sessionLocaleSchema,
  state: sessionStateSchema,
  version: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  hardExpiresAt: z.string().datetime()
});

export const uploadLimitsSchema = z.object({
  maxFiles: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  allowedMimeTypes: z.tuple([
    z.literal("application/pdf"),
    z.literal("image/jpeg"),
    z.literal("image/png")
  ])
});

export const mobileContextResponseSchema = z.object({
  session: mobileSessionSchema,
  csrfToken: z.string().regex(/^c_[A-Za-z0-9_-]{43}$/),
  limits: uploadLimitsSchema
});

export const uploadedFileStatusSchema = z.enum([
  "UPLOADING",
  "QUARANTINED",
  "REJECTED",
  "DELETING",
  "DELETE_PENDING",
  "DELETED"
]);

export const uploadedFileKindSchema = z.enum(["PDF", "JPEG", "PNG"]);

export const uploadedFileSnapshotSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().nonnegative(),
  status: uploadedFileStatusSchema,
  kind: uploadedFileKindSchema.nullable(),
  sizeBytes: z.number().int().positive().nullable(),
  createdAt: z.string().datetime()
});

export const uploadFileResponseSchema = z.object({ file: uploadedFileSnapshotSchema });
export const listUploadedFilesResponseSchema = z.object({
  items: z.array(uploadedFileSnapshotSchema)
});

export type MobileExchangeRequest = z.infer<typeof mobileExchangeRequestSchema>;
export type MobileSession = z.infer<typeof mobileSessionSchema>;
export type MobileContextResponse = z.infer<typeof mobileContextResponseSchema>;
export type UploadLimits = z.infer<typeof uploadLimitsSchema>;
export type UploadedFileStatus = z.infer<typeof uploadedFileStatusSchema>;
export type UploadedFileKind = z.infer<typeof uploadedFileKindSchema>;
export type UploadedFileSnapshot = z.infer<typeof uploadedFileSnapshotSchema>;
export type UploadFileResponse = z.infer<typeof uploadFileResponseSchema>;
export type ListUploadedFilesResponse = z.infer<typeof listUploadedFilesResponseSchema>;
