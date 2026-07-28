import { z } from "zod";

import { uploadedFileKindSchema, uploadedFileRejectionCodeSchema } from "./uploads.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const privateObjectKeySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.includes(".."), {
    message: "object key must be relative and must not contain parent traversal"
  });

export const documentProcessingLimitsSchema = z
  .object({
    maxPages: z.number().int().positive(),
    maxImageDimensionPixels: z.number().int().positive(),
    maxImagePixels: z.number().int().positive(),
    maxNormalizedBytes: z.number().int().positive(),
    maxPreviewBytesPerPage: z.number().int().positive(),
    previewMaxWidthPixels: z.number().int().positive(),
    previewMaxHeightPixels: z.number().int().positive(),
    timeoutMs: z.number().int().positive()
  })
  .strict();

export const documentProcessingJobSchema = z
  .object({
    fileId: z.string().uuid(),
    generation: z.number().int().positive()
  })
  .strict();

export const documentDerivativeTypeSchema = z.enum(["ORIGINAL", "NORMALIZED_PDF", "PAGE_PREVIEW"]);

const documentArtifactBaseSchema = z
  .object({
    type: documentDerivativeTypeSchema,
    objectKey: privateObjectKeySchema,
    mimeType: z.string().min(1).max(100),
    sizeBytes: z.number().int().positive(),
    sha256: sha256Schema,
    pageNumber: z.number().int().nonnegative()
  })
  .strict();

export const documentOriginalArtifactSchema = documentArtifactBaseSchema.extend({
  type: z.literal("ORIGINAL"),
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  pageNumber: z.literal(0)
});

export const normalizedPdfArtifactSchema = documentArtifactBaseSchema.extend({
  type: z.literal("NORMALIZED_PDF"),
  mimeType: z.literal("application/pdf"),
  pageNumber: z.literal(0)
});

export const pagePreviewArtifactSchema = documentArtifactBaseSchema.extend({
  type: z.literal("PAGE_PREVIEW"),
  mimeType: z.literal("image/webp"),
  pageNumber: z.number().int().positive(),
  widthPixels: z.number().int().positive(),
  heightPixels: z.number().int().positive()
});

export const processedPageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    widthPixels: z.number().int().positive(),
    heightPixels: z.number().int().positive(),
    preview: pagePreviewArtifactSchema
  })
  .strict()
  .superRefine((page, context) => {
    if (page.preview.pageNumber !== page.pageNumber) {
      context.addIssue({
        code: "custom",
        path: ["preview", "pageNumber"],
        message: "preview pageNumber must match its page"
      });
    }
    if (
      page.preview.widthPixels !== page.widthPixels ||
      page.preview.heightPixels !== page.heightPixels
    ) {
      context.addIssue({
        code: "custom",
        path: ["preview"],
        message: "preview dimensions must match its page dimensions"
      });
    }
  });

export const malwareScanStatusSchema = z.enum([
  "PENDING",
  "SCANNING",
  "CLEAN",
  "INFECTED",
  "ERROR"
]);

export const documentProcessingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    fileId: z.string().uuid(),
    generation: z.number().int().positive(),
    processingRevision: z.number().int().positive(),
    sourceKind: uploadedFileKindSchema,
    sourceSizeBytes: z.number().int().positive(),
    sourceSha256: sha256Schema,
    malwareScanStatus: z.literal("CLEAN"),
    pageCount: z.number().int().positive(),
    original: documentOriginalArtifactSchema,
    normalizedPdf: normalizedPdfArtifactSchema,
    pages: z.array(processedPageSchema).min(1)
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.pages.length !== manifest.pageCount) {
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "pages must contain exactly pageCount items"
      });
    }
    if (
      manifest.original.sizeBytes !== manifest.sourceSizeBytes ||
      manifest.original.sha256 !== manifest.sourceSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["original"],
        message: "original artifact must identify the source object"
      });
    }
    manifest.pages.forEach((page, index) => {
      if (page.pageNumber !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["pages", index, "pageNumber"],
          message: "pages must be ordered contiguously from page 1"
        });
      }
    });
  });

export const documentProcessorTransientCodeSchema = z.enum([
  "PROCESSOR_UNAVAILABLE",
  "OBJECT_STORAGE_UNAVAILABLE",
  "MALWARE_SCANNER_UNAVAILABLE",
  "PROCESSOR_TIMEOUT",
  "PROCESSOR_CRASHED",
  "PROCESSOR_OUTPUT_INVALID",
  "PROCESSOR_LEASE_LOST",
  "DATABASE_RETRY_REQUIRED"
]);

export const documentProcessorResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("READY"),
      manifest: documentProcessingManifestSchema
    })
    .strict(),
  z
    .object({
      outcome: z.literal("REJECTED"),
      rejectionCode: uploadedFileRejectionCodeSchema
    })
    .strict(),
  z
    .object({
      outcome: z.literal("RETRY"),
      transientCode: documentProcessorTransientCodeSchema
    })
    .strict()
]);

export const DOCUMENT_PROCESSING_QUEUE_NAME = "document-processing-v1";
export const DOCUMENT_PROCESSING_JOB_NAME = "process-document-v1";

export type DocumentProcessingLimits = z.infer<typeof documentProcessingLimitsSchema>;
export type DocumentProcessingJob = z.infer<typeof documentProcessingJobSchema>;
export type DocumentDerivativeType = z.infer<typeof documentDerivativeTypeSchema>;
export type DocumentProcessingManifest = z.infer<typeof documentProcessingManifestSchema>;
export type DocumentProcessorTransientCode = z.infer<typeof documentProcessorTransientCodeSchema>;
export type DocumentProcessorResult = z.infer<typeof documentProcessorResultSchema>;
