import { describe, expect, it } from "vitest";

import {
  documentProcessingJobSchema,
  documentProcessingManifestSchema,
  documentProcessorResultSchema
} from "./processing.js";
import { sessionEventSchema } from "./events.js";
import {
  filePagesResponseSchema,
  readyUploadedFileSnapshotSchema,
  uploadedFileSnapshotSchema
} from "./uploads.js";

const fileId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-07-24T10:00:00.000Z";
const digest = "a".repeat(64);

describe("Phase 5 public file contracts", () => {
  it("does not expose internal rejection details", () => {
    const base = {
      id: fileId,
      ordinal: 0,
      status: "REJECTED",
      kind: "PDF",
      sizeBytes: 100,
      processingRevision: 1,
      pageCount: null,
      createdAt
    };

    expect(
      uploadedFileSnapshotSchema.safeParse({
        ...base,
        rejectionCode: "PROCESSOR_CRASHED_WITH_PATH_/tmp/private.pdf"
      }).success
    ).toBe(false);
    expect(
      uploadedFileSnapshotSchema.safeParse({
        ...base,
        rejectionCode: "PROCESSING_FAILED"
      }).success
    ).toBe(true);
  });

  it("requires READY files and page responses to be complete and contiguous", () => {
    const file = readyUploadedFileSnapshotSchema.parse({
      id: fileId,
      ordinal: 0,
      status: "READY",
      kind: "PDF",
      sizeBytes: 100,
      processingRevision: 1,
      pageCount: 2,
      rejectionCode: null,
      createdAt
    });

    expect(
      filePagesResponseSchema.safeParse({
        fileId: file.id,
        processingRevision: file.processingRevision,
        pageCount: file.pageCount,
        items: [
          {
            pageNumber: 1,
            widthPixels: 1200,
            heightPixels: 1600,
            previewAvailable: true
          },
          {
            pageNumber: 2,
            widthPixels: 1200,
            heightPixels: 1600,
            previewAvailable: true
          }
        ]
      }).success
    ).toBe(true);

    expect(
      filePagesResponseSchema.safeParse({
        fileId: file.id,
        processingRevision: file.processingRevision,
        pageCount: file.pageCount,
        items: [
          {
            pageNumber: 2,
            widthPixels: 1200,
            heightPixels: 1600,
            previewAvailable: true
          }
        ]
      }).success
    ).toBe(false);
  });

  it("normalizes legacy durable file events during a rolling Phase 5 deployment", () => {
    const event = sessionEventSchema.parse({
      id: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      sequence: 7,
      type: "file.uploaded",
      payload: {
        sessionId: "33333333-3333-4333-8333-333333333333",
        file: {
          id: fileId,
          ordinal: 0,
          status: "QUARANTINED",
          kind: "PDF",
          sizeBytes: 100,
          createdAt
        }
      },
      occurredAt: createdAt
    });

    if (event.type !== "file.uploaded") throw new Error("Unexpected event type.");
    expect(event.payload.file).toMatchObject({
      processingRevision: 1,
      pageCount: null,
      rejectionCode: null
    });
  });
});

describe("document processor protocol", () => {
  it("accepts only positive dispatcher generations", () => {
    expect(documentProcessingJobSchema.safeParse({ fileId, generation: 1 }).success).toBe(true);
    expect(documentProcessingJobSchema.safeParse({ fileId, generation: 0 }).success).toBe(false);
  });

  it("validates a complete ready manifest", () => {
    const original = {
      type: "ORIGINAL",
      objectKey: `quarantine/v1/session/${fileId}/source`,
      mimeType: "application/pdf",
      sizeBytes: 100,
      sha256: digest,
      pageNumber: 0
    } as const;
    const preview = {
      type: "PAGE_PREVIEW",
      objectKey: `processed/v1/${fileId}/1/page-1.webp`,
      mimeType: "image/webp",
      sizeBytes: 20,
      sha256: digest,
      pageNumber: 1,
      widthPixels: 1200,
      heightPixels: 1600
    } as const;

    const result = documentProcessingManifestSchema.safeParse({
      schemaVersion: 1,
      fileId,
      generation: 1,
      processingRevision: 1,
      sourceKind: "PDF",
      sourceSizeBytes: 100,
      sourceSha256: digest,
      malwareScanStatus: "CLEAN",
      pageCount: 1,
      original,
      normalizedPdf: {
        type: "NORMALIZED_PDF",
        objectKey: `processed/v1/${fileId}/1/normalized.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 120,
        sha256: digest,
        pageNumber: 0
      },
      pages: [{ pageNumber: 1, widthPixels: 1200, heightPixels: 1600, preview }]
    });

    expect(result.success).toBe(true);
  });

  it("allows only safe public codes in a rejected processor result", () => {
    expect(
      documentProcessorResultSchema.safeParse({
        outcome: "REJECTED",
        rejectionCode: "DOCUMENT_MALFORMED"
      }).success
    ).toBe(true);
    expect(
      documentProcessorResultSchema.safeParse({
        outcome: "REJECTED",
        rejectionCode: "GHOSTSCRIPT_EXIT_139"
      }).success
    ).toBe(false);
  });
});
