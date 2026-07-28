import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessorConfig } from "./config.js";
import { DocumentProcessor } from "./document-processor.js";
import { ProcessorError } from "./errors.js";
import type { MalwareScanner, NativeDocumentTools, PdfInspection } from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("document processing fail-closed ordering", () => {
  let scratchDirectory: string;
  let scanner: RejectingScanner;
  let tools: NeverCalledTools;
  let processor: DocumentProcessor;

  beforeEach(async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), "document-processor-test-"));
    scanner = new RejectingScanner();
    tools = new NeverCalledTools();
    processor = new DocumentProcessor(testConfig(scratchDirectory), scanner, tools);
  });

  afterEach(async () => {
    await rm(scratchDirectory, { recursive: true, force: true });
  });

  it("scans before any image decoder or native document tool and cleans scratch", async () => {
    await expect(
      processor.process({
        kind: "PNG",
        contentLength: PNG.byteLength,
        expectedSha256: sha256(PNG),
        body: Readable.from(PNG),
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      code: "MALWARE_SCANNER_UNAVAILABLE",
      retryable: true
    });

    expect(scanner.scanCalls).toBe(1);
    expect(tools.calls).toBe(0);
    expect(await readdir(scratchDirectory)).toEqual([]);
  });

  it("checks the immutable source digest before submitting bytes to ClamAV", async () => {
    await expect(
      processor.process({
        kind: "PNG",
        contentLength: PNG.byteLength,
        expectedSha256: "0".repeat(64),
        body: Readable.from(PNG),
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });

    expect(scanner.scanCalls).toBe(0);
    expect(tools.calls).toBe(0);
    expect(await readdir(scratchDirectory)).toEqual([]);
  });
});

describe("incremental multipage document processing", () => {
  it("removes each canonical page before rasterizing the next page", async () => {
    const scratchDirectory = await mkdtemp(join(tmpdir(), "incremental-processor-test-"));
    const tools = new RasterizingTools();
    const processor = new DocumentProcessor(
      testConfig(scratchDirectory),
      new AcceptingScanner(),
      tools
    );
    const source = Buffer.from("%PDF-1.7\nsynthetic test document\n", "ascii");

    try {
      const result = await processor.process({
        kind: "PDF",
        contentLength: source.byteLength,
        expectedSha256: sha256(source),
        body: Readable.from(source),
        signal: new AbortController().signal
      });

      expect(tools.canonicalFilesBeforeRaster).toEqual([[], []]);
      expect(tools.canonicalFilesAtValidation).toEqual([]);
      expect(result.manifest.pageCount).toBe(2);
      expect(result.manifest.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
      expect(result.artifacts.map((artifact) => artifact.archivePath)).toEqual([
        "normalized/document.pdf",
        "previews/page-1.webp",
        "previews/page-2.webp"
      ]);
      const normalized = result.artifacts[0];
      expect(normalized).toBeDefined();
      expect(
        await readdir(join(dirname(normalized?.filesystemPath ?? ""), "canonical-pages"))
      ).toEqual([]);

      await result.cleanup();
      expect(await readdir(scratchDirectory)).toEqual([]);
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  });

  it("removes the partial writer and working directory after a later page fails", async () => {
    const scratchDirectory = await mkdtemp(join(tmpdir(), "incremental-processor-test-"));
    const tools = new RasterizingTools({ failAtPage: 2 });
    const processor = new DocumentProcessor(
      testConfig(scratchDirectory),
      new AcceptingScanner(),
      tools
    );
    const source = Buffer.from("%PDF-1.7\nsynthetic test document\n", "ascii");

    try {
      await expect(
        processor.process({
          kind: "PDF",
          contentLength: source.byteLength,
          expectedSha256: sha256(source),
          body: Readable.from(source),
          signal: new AbortController().signal
        })
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR", retryable: true });

      expect(tools.canonicalFilesBeforeRaster).toEqual([[], []]);
      expect(await readdir(scratchDirectory)).toEqual([]);
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  });
});

describe("document page and failure boundaries", () => {
  let scratchDirectory: string;

  beforeEach(async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), "boundary-processor-test-"));
  });

  afterEach(async () => {
    await rm(scratchDirectory, { recursive: true, force: true });
  });

  it("accepts a document with exactly the configured page limit", async () => {
    const tools = new RasterizingTools({ pageCount: 3 });
    const processor = new DocumentProcessor(
      { ...testConfig(scratchDirectory), maxPages: 3 },
      new AcceptingScanner(),
      tools
    );

    const result = await processPdf(processor);
    expect(result.manifest.pageCount).toBe(3);
    expect(result.manifest.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(tools.rasterCalls).toBe(3);

    await result.cleanup();
    expect(await readdir(scratchDirectory)).toEqual([]);
  });

  it("rejects one page beyond the configured page limit before rasterizing anything", async () => {
    const tools = new RasterizingTools({ pageCount: 4 });
    const processor = new DocumentProcessor(
      { ...testConfig(scratchDirectory), maxPages: 3 },
      new AcceptingScanner(),
      tools
    );

    await expect(processPdf(processor)).rejects.toMatchObject({
      code: "PAGE_LIMIT_EXCEEDED",
      retryable: false
    });
    expect(tools.rasterCalls).toBe(0);
    expect(await readdir(scratchDirectory)).toEqual([]);
  });

  it("reports a rendering timeout as a timeout and removes the working directory", async () => {
    const tools = new RasterizingTools({
      pageCount: 3,
      failAtPage: 2,
      rasterError: new ProcessorError("PROCESSING_TIMEOUT", 422)
    });
    const processor = new DocumentProcessor(
      testConfig(scratchDirectory),
      new AcceptingScanner(),
      tools
    );

    await expect(processPdf(processor)).rejects.toMatchObject({
      code: "PROCESSING_TIMEOUT",
      retryable: false
    });
    expect(await readdir(scratchDirectory)).toEqual([]);
  });

  it("reports detected malware before any parser runs and removes the working directory", async () => {
    const tools = new NeverCalledTools();
    const processor = new DocumentProcessor(
      testConfig(scratchDirectory),
      new InfectedScanner(),
      tools
    );

    await expect(processPdf(processor)).rejects.toMatchObject({
      code: "MALWARE_DETECTED",
      retryable: false
    });
    expect(tools.calls).toBe(0);
    expect(await readdir(scratchDirectory)).toEqual([]);
  });
});

function processPdf(processor: DocumentProcessor) {
  const source = Buffer.from("%PDF-1.7\nsynthetic test document\n", "ascii");
  return processor.process({
    kind: "PDF",
    contentLength: source.byteLength,
    expectedSha256: sha256(source),
    body: Readable.from(source),
    signal: new AbortController().signal
  });
}

class InfectedScanner implements MalwareScanner {
  public checkReady() {
    return Promise.resolve(scannerResult());
  }

  public scan() {
    return Promise.reject(new ProcessorError("MALWARE_DETECTED", 422));
  }
}

class RejectingScanner implements MalwareScanner {
  public scanCalls = 0;

  public checkReady() {
    return Promise.reject(new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true));
  }

  public scan() {
    this.scanCalls += 1;
    return Promise.reject(new ProcessorError("MALWARE_SCANNER_UNAVAILABLE", 503, true));
  }
}

class AcceptingScanner implements MalwareScanner {
  public checkReady() {
    return Promise.resolve(scannerResult());
  }

  public scan() {
    return Promise.resolve(scannerResult());
  }
}

class NeverCalledTools implements NativeDocumentTools {
  public calls = 0;

  public checkReady(): Promise<void> {
    this.calls += 1;
    return Promise.reject(new Error("NATIVE_TOOLS_MUST_NOT_RUN"));
  }

  public inspectPdf(): Promise<PdfInspection> {
    this.calls += 1;
    return Promise.reject(new Error("NATIVE_TOOLS_MUST_NOT_RUN"));
  }

  public rasterizePdfPage(): Promise<string> {
    this.calls += 1;
    return Promise.reject(new Error("NATIVE_TOOLS_MUST_NOT_RUN"));
  }

  public assertCanonicalPdf(): Promise<void> {
    this.calls += 1;
    return Promise.reject(new Error("NATIVE_TOOLS_MUST_NOT_RUN"));
  }
}

interface RasterizingToolsOptions {
  pageCount?: number;
  failAtPage?: number;
  rasterError?: Error;
}

class RasterizingTools implements NativeDocumentTools {
  public readonly canonicalFilesBeforeRaster: string[][] = [];
  public canonicalFilesAtValidation: string[] = [];
  public rasterCalls = 0;

  public constructor(private readonly options: RasterizingToolsOptions = {}) {}

  public checkReady(): Promise<void> {
    return Promise.resolve();
  }

  public inspectPdf(): Promise<PdfInspection> {
    return Promise.resolve({ pageCount: this.options.pageCount ?? 2 });
  }

  public async rasterizePdfPage(input: {
    outputPrefix: string;
    pageNumber: number;
  }): Promise<string> {
    this.rasterCalls += 1;
    const workingDirectory = dirname(dirname(input.outputPrefix));
    const canonicalDirectory = join(workingDirectory, "canonical-pages");
    this.canonicalFilesBeforeRaster.push(
      await readdir(canonicalDirectory).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return [];
        throw error;
      })
    );
    if (input.pageNumber === this.options.failAtPage) {
      throw this.options.rasterError ?? new Error("SYNTHETIC_RASTER_FAILURE");
    }

    const outputPath = `${input.outputPrefix}.png`;
    await sharp({
      create: {
        width: input.pageNumber === 1 ? 30 : 40,
        height: input.pageNumber === 1 ? 40 : 30,
        channels: 3,
        background: input.pageNumber === 1 ? "#222222" : "#dddddd"
      }
    })
      .png()
      .toFile(outputPath);
    return outputPath;
  }

  public async assertCanonicalPdf(path: string): Promise<void> {
    this.canonicalFilesAtValidation = await readdir(join(dirname(path), "canonical-pages"));
    const header = (await readFile(path)).subarray(0, 5).toString("ascii");
    if (header !== "%PDF-") throw new Error("CANONICAL_PDF_INVALID");
  }
}

function scannerResult() {
  return {
    engineVersion: "test",
    definitionsVersion: "test",
    scannedAt: new Date(0).toISOString()
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function testConfig(scratchDirectory: string): ProcessorConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "test-only-processor-token-32-bytes-long",
    scratchDirectory,
    maxInputBytes: 1024,
    maxResponseBytes: 1024 * 1024,
    maxNormalizedBytes: 512 * 1024,
    maxPreviewBytes: 64 * 1024,
    maxPages: 10,
    maxImagePixels: 40_000_000,
    maxImageDimension: 20_000,
    maximumRasterDimension: 3_508,
    rasterFormat: "tiff" as const,
    canonicalPngCompressionLevel: 6,
    canonicalPngAdaptiveFiltering: false,
    previewWebpEffort: 4,
    previewWidth: 900,
    previewHeight: 1_200,
    processTimeoutMilliseconds: 10_000,
    toolTimeoutMilliseconds: 1_000,
    scannerTimeoutMilliseconds: 1_000,
    scannerDefinitionMaxAgeMilliseconds: 60_000,
    timingLog: false,
    timingDetail: false,
    clamavHost: "127.0.0.1",
    clamavPort: 3310
  };
}
