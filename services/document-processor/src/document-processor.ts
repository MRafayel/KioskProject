import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { ProcessorConfig } from "./config.js";
import { CanonicalPdfWriter } from "./canonical-pdf.js";
import { ProcessorError, safeProcessorError } from "./errors.js";
import { hashFile } from "./hash-file.js";
import { type CanonicalPage, SharpImagePipeline } from "./image-pipeline.js";
import { equalSha256, hasExpectedSignature, InputInspectionTransform } from "./streams.js";
import type { StageRecorder, TimingStage } from "./timings.js";
import {
  PROCESSOR_PROTOCOL_VERSION,
  type InternalDocumentProcessor,
  type MalwareScanner,
  type NativeDocumentTools,
  type ProcessedDocument,
  type ProcessorManifest,
  type ProcessorManifestPage,
  type ProcessorReadiness,
  type ProcessDocumentInput,
  type TarArtifact
} from "./types.js";

/**
 * Times `operation` when a recorder is present. Instrumentation is optional
 * everywhere, so this keeps the call sites free of `if (timings)` branches.
 */
function measure<T>(
  timings: StageRecorder | undefined,
  stage: TimingStage,
  operation: () => Promise<T>
): Promise<T> {
  return timings ? timings.measure(stage, operation) : operation();
}

export class DocumentProcessor implements InternalDocumentProcessor {
  private readonly images: SharpImagePipeline;

  public constructor(
    private readonly config: ProcessorConfig,
    private readonly scanner: MalwareScanner,
    private readonly tools: NativeDocumentTools
  ) {
    this.images = new SharpImagePipeline(config);
  }

  public async checkReady(signal?: AbortSignal): Promise<ProcessorReadiness> {
    await Promise.all([this.scanner.checkReady(signal), this.tools.checkReady(signal)]);
    return { malwareScanner: "ok", nativeTools: "ok" };
  }

  public async process(input: ProcessDocumentInput): Promise<ProcessedDocument> {
    if (input.contentLength < 1) throw new ProcessorError("EMPTY_FILE", 400);
    if (input.contentLength > this.config.maxInputBytes) {
      throw new ProcessorError("REQUEST_TOO_LARGE", 413);
    }
    await mkdir(this.config.scratchDirectory, { recursive: true, mode: 0o700 });
    const workingDirectory = await mkdtemp(join(this.config.scratchDirectory, "job-"));
    let retainForResponse = false;

    try {
      const inputPath = join(workingDirectory, "input.bin");
      const stopInput = input.timings?.start("input") ?? (() => undefined);
      const inspection = new InputInspectionTransform(
        input.contentLength,
        this.config.maxInputBytes
      );
      await pipeline(
        input.body,
        inspection,
        createWriteStream(inputPath, { flags: "wx", mode: 0o600 }),
        { signal: input.signal }
      );
      const received = inspection.result();
      if (!equalSha256(received.sha256, input.expectedSha256)) {
        throw new ProcessorError("CONTENT_HASH_MISMATCH", 422);
      }
      if (!hasExpectedSignature(input.kind, received.firstBytes)) {
        throw new ProcessorError("MALFORMED_DOCUMENT", 422);
      }

      stopInput();
      const malware = await measure(input.timings, "scan", () =>
        this.scanner.scan(inputPath, input.signal)
      );
      const canonicalDirectory = join(workingDirectory, "canonical-pages");
      const previewDirectory = join(workingDirectory, "previews");
      const normalizedPath = join(workingDirectory, "normalized.pdf");
      const pdf = new CanonicalPdfWriter({
        outputPath: normalizedPath,
        maximumBytes: this.config.maxNormalizedBytes,
        signal: input.signal
      });
      let pages: CanonicalPage[];
      let normalizedSize: number;
      try {
        pages =
          input.kind === "PDF"
            ? await this.processPdf({
                inputPath,
                workingDirectory,
                canonicalDirectory,
                previewDirectory,
                pdf,
                signal: input.signal,
                ...(input.timings ? { timings: input.timings } : {})
              })
            : [
                await this.normalizeIntoPdf({
                  sourcePath: inputPath,
                  pageNumber: 1,
                  canonicalDirectory,
                  previewDirectory,
                  pdf,
                  signal: input.signal,
                  ...(input.timings ? { timings: input.timings } : {})
                })
              ];
        normalizedSize = await measure(input.timings, "finalize", () => pdf.finalize());
      } catch (error) {
        await pdf.abort();
        throw error;
      }
      await measure(input.timings, "assertOutput", () =>
        this.tools.assertCanonicalPdf(normalizedPath, input.signal)
      );
      const normalizedSha256 = await measure(input.timings, "manifestHash", () =>
        hashFile(normalizedPath)
      );

      const manifestPages: ProcessorManifestPage[] = [];
      const stopManifest = input.timings?.start("manifestHash") ?? (() => undefined);
      for (const page of pages) {
        input.signal.throwIfAborted();
        manifestPages.push(await this.manifestPage(page));
      }
      stopManifest();
      const manifest: ProcessorManifest = {
        protocolVersion: PROCESSOR_PROTOCOL_VERSION,
        kind: input.kind,
        pageCount: pages.length,
        normalized: {
          path: "normalized/document.pdf",
          mime: "application/pdf",
          sizeBytes: normalizedSize,
          sha256: normalizedSha256
        },
        pages: manifestPages,
        malware
      };
      const artifacts: TarArtifact[] = [
        {
          archivePath: manifest.normalized.path,
          filesystemPath: normalizedPath,
          sizeBytes: normalizedSize
        },
        ...pages.map((page, index) => ({
          archivePath: page.previewArchivePath,
          filesystemPath: page.previewPath,
          sizeBytes: manifestPages[index]?.preview.sizeBytes ?? 0
        }))
      ];

      let cleaned = false;
      retainForResponse = true;
      return {
        manifest,
        artifacts,
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          await rm(workingDirectory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      throw safeProcessorError(error);
    } finally {
      if (!retainForResponse) {
        await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async processPdf(input: {
    inputPath: string;
    workingDirectory: string;
    canonicalDirectory: string;
    previewDirectory: string;
    pdf: CanonicalPdfWriter;
    signal: AbortSignal;
    timings?: StageRecorder;
  }): Promise<CanonicalPage[]> {
    const inspection = await measure(input.timings, "inspect", () =>
      this.tools.inspectPdf(input.inputPath, input.signal)
    );
    if (inspection.pageCount > this.config.maxPages) {
      throw new ProcessorError("PAGE_LIMIT_EXCEEDED", 422);
    }
    const rasterDirectory = join(input.workingDirectory, "raster");
    await mkdir(rasterDirectory, { recursive: true, mode: 0o700 });
    const pages: CanonicalPage[] = [];

    for (let pageNumber = 1; pageNumber <= inspection.pageCount; pageNumber += 1) {
      input.signal.throwIfAborted();
      const pageStart = process.hrtime.bigint();
      const rasterPath = await measure(input.timings, "raster", () =>
        this.tools.rasterizePdfPage({
          inputPath: input.inputPath,
          outputPrefix: join(rasterDirectory, `page-${String(pageNumber).padStart(6, "0")}`),
          pageNumber,
          maximumDimension: this.config.maximumRasterDimension,
          format: this.config.rasterFormat,
          signal: input.signal
        })
      );
      try {
        pages.push(
          await this.normalizeIntoPdf({
            sourcePath: rasterPath,
            pageNumber,
            canonicalDirectory: input.canonicalDirectory,
            previewDirectory: input.previewDirectory,
            pdf: input.pdf,
            signal: input.signal,
            ...(input.timings ? { timings: input.timings } : {})
          })
        );
      } finally {
        await unlink(rasterPath).catch(() => undefined);
      }
      input.timings?.countPage(process.hrtime.bigint() - pageStart);
    }
    return pages;
  }

  private async normalizeIntoPdf(input: {
    sourcePath: string;
    pageNumber: number;
    canonicalDirectory: string;
    previewDirectory: string;
    pdf: CanonicalPdfWriter;
    signal: AbortSignal;
    timings?: StageRecorder;
  }): Promise<CanonicalPage> {
    const page = await this.images.normalizePage({
      sourcePath: input.sourcePath,
      pageNumber: input.pageNumber,
      canonicalDirectory: input.canonicalDirectory,
      previewDirectory: input.previewDirectory,
      signal: input.signal,
      ...(input.timings ? { timings: input.timings } : {})
    });
    await measure(input.timings, "pdfAppend", () => input.pdf.addPage(page));
    return page;
  }

  private async manifestPage(page: CanonicalPage): Promise<ProcessorManifestPage> {
    const preview = await stat(page.previewPath);
    if (!preview.isFile() || preview.size < 1) {
      throw new ProcessorError("INTERNAL_ERROR", 500, true);
    }
    return {
      pageNumber: page.pageNumber,
      widthPixels: page.widthPixels,
      heightPixels: page.heightPixels,
      preview: {
        path: page.previewArchivePath,
        mime: "image/webp",
        sizeBytes: preview.size,
        sha256: await hashFile(page.previewPath)
      }
    };
  }
}
