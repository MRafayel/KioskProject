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
  "VALIDATING",
  "READY",
  "REJECTED",
  "DELETING",
  "DELETE_PENDING",
  "DELETED"
]);

export const uploadedFileKindSchema = z.enum(["PDF", "JPEG", "PNG"]);

/**
 * Codes in this enum are safe to show to an unauthenticated kiosk or mobile
 * client. Internal parser, scanner, storage and orchestration errors must be
 * mapped to one of these values before crossing the API boundary.
 */
export const uploadedFileRejectionCodeSchema = z.enum([
  "UPLOAD_FAILED",
  "MALWARE_DETECTED",
  "MALWARE_SCAN_UNAVAILABLE",
  "DOCUMENT_ENCRYPTED",
  "DOCUMENT_MALFORMED",
  "PAGE_LIMIT_EXCEEDED",
  "IMAGE_DIMENSION_LIMIT_EXCEEDED",
  "IMAGE_PIXEL_LIMIT_EXCEEDED",
  "OUTPUT_SIZE_LIMIT_EXCEEDED",
  "UNSUPPORTED_DOCUMENT_CONTENT",
  "PROCESSING_TIMEOUT",
  "PROCESSING_FAILED"
]);

export const uploadedFileSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    ordinal: z.number().int().nonnegative(),
    status: uploadedFileStatusSchema,
    kind: uploadedFileKindSchema.nullable(),
    sizeBytes: z.number().int().positive().nullable(),
    // Defaults are a deliberate rolling-deployment compatibility window.
    // Phase 3/4 publishers did not include processing fields. Parsing their
    // durable events after the additive Phase 5 migration must materialize a
    // complete neutral snapshot instead of creating an unrecoverable sequence
    // gap. New writers always send these fields explicitly.
    processingRevision: z.number().int().positive().default(1),
    pageCount: z.number().int().positive().nullable().default(null),
    rejectionCode: uploadedFileRejectionCodeSchema.nullable().default(null),
    createdAt: z.string().datetime()
  })
  .strict();

export const readyUploadedFileSnapshotSchema = uploadedFileSnapshotSchema.extend({
  status: z.literal("READY"),
  kind: uploadedFileKindSchema,
  sizeBytes: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  rejectionCode: z.null()
});

export const filePageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    widthPixels: z.number().int().positive(),
    heightPixels: z.number().int().positive(),
    previewAvailable: z.boolean()
  })
  .strict();

export const filePagesResponseSchema = z
  .object({
    fileId: z.string().uuid(),
    processingRevision: z.number().int().positive(),
    pageCount: z.number().int().positive(),
    items: z.array(filePageSchema)
  })
  .strict()
  .superRefine((response, context) => {
    if (response.items.length !== response.pageCount) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "items must contain exactly pageCount entries"
      });
    }

    response.items.forEach((page, index) => {
      if (page.pageNumber !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "pageNumber"],
          message: "items must be ordered contiguously from page 1"
        });
      }
    });
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
export type UploadedFileRejectionCode = z.infer<typeof uploadedFileRejectionCodeSchema>;
export type UploadedFileSnapshot = z.infer<typeof uploadedFileSnapshotSchema>;
export type ReadyUploadedFileSnapshot = z.infer<typeof readyUploadedFileSnapshotSchema>;
export type FilePage = z.infer<typeof filePageSchema>;
export type FilePagesResponse = z.infer<typeof filePagesResponseSchema>;
export type UploadFileResponse = z.infer<typeof uploadFileResponseSchema>;
export type ListUploadedFilesResponse = z.infer<typeof listUploadedFilesResponseSchema>;
