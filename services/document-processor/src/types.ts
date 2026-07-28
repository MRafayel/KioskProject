import type { Readable } from "node:stream";

import type { StageRecorder } from "./timings.js";

export const PROCESSOR_PROTOCOL_VERSION = 1 as const;
export const DOCUMENT_KINDS = ["PDF", "JPEG", "PNG"] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface ProcessorManifestArtifact {
  path: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

export interface ProcessorManifestPage {
  pageNumber: number;
  widthPixels: number;
  heightPixels: number;
  preview: ProcessorManifestArtifact;
}

/**
 * Processor-private representation of protocol version 1. The standalone
 * parser container deliberately has no dependency on worker code. The worker
 * treats every response as untrusted and independently validates this complete
 * shape, every archive path, size and digest before persisting any artifact.
 */
export interface ProcessorManifest {
  protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  kind: DocumentKind;
  pageCount: number;
  normalized: ProcessorManifestArtifact;
  pages: ProcessorManifestPage[];
  malware: {
    engineVersion: string;
    definitionsVersion: string;
    scannedAt: string;
  };
}

export interface ProcessDocumentInput {
  kind: DocumentKind;
  contentLength: number;
  expectedSha256: string;
  body: Readable;
  signal: AbortSignal;
  /** Optional per-request stage instrumentation. Absent in most tests. */
  timings?: StageRecorder;
}

export interface TarArtifact {
  archivePath: string;
  filesystemPath: string;
  sizeBytes: number;
}

export interface ProcessedDocument {
  manifest: ProcessorManifest;
  artifacts: TarArtifact[];
  cleanup(): Promise<void>;
}

export interface ProcessorReadiness {
  malwareScanner: "ok";
  nativeTools: "ok";
}

export interface InternalDocumentProcessor {
  checkReady(signal?: AbortSignal): Promise<ProcessorReadiness>;
  process(input: ProcessDocumentInput): Promise<ProcessedDocument>;
}

export interface MalwareScanResult {
  engineVersion: string;
  definitionsVersion: string;
  scannedAt: string;
}

export interface MalwareScanner {
  checkReady(signal?: AbortSignal): Promise<MalwareScanResult>;
  scan(path: string, signal?: AbortSignal): Promise<MalwareScanResult>;
}

export interface PdfInspection {
  pageCount: number;
}

/**
 * Encoding of the intermediate page raster handed from Poppler to Sharp.
 *
 * This file is scratch: it is written, read once, and unlinked. Compressing it
 * is pure waste, and measurably expensive — Poppler's PNG encoder costs about
 * five times more per page than rendering the page does. All variants are
 * lossless and produce identical pixels, so the canonical PDF and previews are
 * byte-for-byte identical whichever is chosen.
 *
 *  - `tiff`         uncompressed; fastest, ~8.7 MB per A4 page of scratch
 *  - `tiff-deflate` compressed; slightly slower, ~100 KB per page
 *  - `png`          the original behaviour, retained for rollback
 */
export const RASTER_FORMATS = ["tiff", "tiff-deflate", "png"] as const;

export type RasterFormat = (typeof RASTER_FORMATS)[number];

export interface NativeDocumentTools {
  checkReady(signal?: AbortSignal): Promise<void>;
  inspectPdf(path: string, signal?: AbortSignal): Promise<PdfInspection>;
  rasterizePdfPage(input: {
    inputPath: string;
    outputPrefix: string;
    pageNumber: number;
    maximumDimension: number;
    format: RasterFormat;
    signal?: AbortSignal;
  }): Promise<string>;
  assertCanonicalPdf(path: string, signal?: AbortSignal): Promise<void>;
}
