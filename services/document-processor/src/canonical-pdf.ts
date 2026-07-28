import { createWriteStream } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import PDFDocument from "pdfkit";

import { isAbortError, isResourceCapacityError, ProcessorError } from "./errors.js";
import type { CanonicalPage } from "./image-pipeline.js";
import { OutputLimitTransform } from "./streams.js";

const A4_SHORT_EDGE_POINTS = 595.28;
const A4_LONG_EDGE_POINTS = 841.89;

export interface CanonicalPdfWriterOptions {
  outputPath: string;
  maximumBytes: number;
  signal?: AbortSignal;
}

/**
 * A single-use streaming writer. Each page image is read into a bounded
 * one-page buffer and unlinked before this method resolves. PDFKit receives
 * the buffer rather than the path, so any remaining output work owns the bytes
 * it needs and can never reopen the scratch image.
 */
export class CanonicalPdfWriter {
  private readonly document: PDFKit.PDFDocument;
  private readonly completed: Promise<void>;
  private streamFailure: unknown;
  private pageCount = 0;
  private closing = false;
  private finalized = false;
  private aborted = false;

  public constructor(private readonly options: CanonicalPdfWriterOptions) {
    if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1) {
      throw new ProcessorError("INTERNAL_ERROR", 500, true);
    }
    options.signal?.throwIfAborted();

    this.document = new PDFDocument({
      autoFirstPage: false,
      compress: true,
      pdfVersion: "1.7",
      info: {
        Title: "Print document",
        Author: "",
        Subject: "",
        Keywords: "",
        Creator: "Printing Kiosk",
        Producer: "Printing Kiosk",
        CreationDate: new Date(0),
        ModDate: new Date(0)
      }
    });
    const limiter = new OutputLimitTransform(options.maximumBytes);
    const destination = createWriteStream(options.outputPath, {
      flags: "wx",
      mode: 0o600
    });
    this.completed = options.signal
      ? pipeline(this.document, limiter, destination, { signal: options.signal })
      : pipeline(this.document, limiter, destination);
    void this.completed.catch((error: unknown) => {
      this.streamFailure = error;
    });
  }

  public async addPage(page: CanonicalPage): Promise<void> {
    this.assertWritable();
    let error: ProcessorError | undefined;
    try {
      this.options.signal?.throwIfAborted();
      this.throwIfStreamFailed();
      const image = await readFile(
        page.imagePath,
        this.options.signal ? { signal: this.options.signal } : undefined
      );
      this.options.signal?.throwIfAborted();
      this.throwIfStreamFailed();

      const landscape = page.widthPixels > page.heightPixels;
      const width = landscape ? A4_LONG_EDGE_POINTS : A4_SHORT_EDGE_POINTS;
      const height = landscape ? A4_SHORT_EDGE_POINTS : A4_LONG_EDGE_POINTS;
      this.document.addPage({ size: [width, height], margin: 0 });
      // Passing bytes instead of the path makes the lifetime boundary
      // explicit: PDFKit cannot reopen the scratch file after this returns.
      this.document.image(image, 0, 0, { width, height });
      this.pageCount += 1;

      // Let the pipeline drain the object emitted for this page before the
      // next decoder result is created.
      await yieldToEventLoop();
      this.options.signal?.throwIfAborted();
      this.throwIfStreamFailed();
    } catch (caught) {
      error = safeCanonicalError(caught, this.options.signal);
    }

    try {
      await unlinkIfPresent(page.imagePath);
    } catch {
      error ??= new ProcessorError("INTERNAL_ERROR", 500, true);
    }
    if (error) throw error;
  }

  public async finalize(): Promise<number> {
    this.assertWritable();
    if (this.pageCount === 0) {
      throw new ProcessorError("MALFORMED_DOCUMENT", 422);
    }
    this.closing = true;
    try {
      this.options.signal?.throwIfAborted();
      this.throwIfStreamFailed();
      this.document.end();
      await this.completed;
      this.throwIfStreamFailed();

      const output = await stat(this.options.outputPath);
      if (!output.isFile() || output.size < 1 || output.size > this.options.maximumBytes) {
        throw new ProcessorError("OUTPUT_SIZE_LIMIT_EXCEEDED", 422);
      }
      this.finalized = true;
      return output.size;
    } catch (error) {
      throw safeCanonicalError(error, this.options.signal);
    }
  }

  public async abort(): Promise<void> {
    if (this.aborted || this.finalized) return;
    this.aborted = true;
    this.closing = true;
    this.document.destroy();
    await this.completed.catch(() => undefined);
    await unlinkIfPresent(this.options.outputPath).catch(() => undefined);
  }

  private assertWritable(): void {
    if (this.closing || this.finalized || this.aborted) {
      throw new ProcessorError("INTERNAL_ERROR", 500, true);
    }
  }

  private throwIfStreamFailed(): void {
    if (this.streamFailure) {
      throw safeCanonicalError(this.streamFailure, this.options.signal);
    }
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function safeCanonicalError(error: unknown, signal?: AbortSignal): ProcessorError {
  if (error instanceof ProcessorError) return error;
  if (isAbortError(error) || signal?.aborted) {
    return new ProcessorError("PROCESSING_TIMEOUT", 422);
  }
  if (isResourceCapacityError(error)) {
    return new ProcessorError("PROCESSOR_CAPACITY_EXHAUSTED", 503, true);
  }
  return new ProcessorError("MALFORMED_DOCUMENT", 422);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
