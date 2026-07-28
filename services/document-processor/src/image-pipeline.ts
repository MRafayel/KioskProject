import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import type { ProcessorConfig } from "./config.js";
import { ProcessorError, isResourceCapacityError } from "./errors.js";
import type { StageRecorder } from "./timings.js";

type SharpInstance = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpInstance["metadata"]>>;

const A4_SHORT_EDGE_PIXELS_AT_300_DPI = 2_480;
const A4_LONG_EDGE_PIXELS_AT_300_DPI = 3_508;
const MAX_CANONICAL_PAGE_BYTES = 32 * 1024 * 1024;

export interface CanonicalPage {
  pageNumber: number;
  imagePath: string;
  previewPath: string;
  previewArchivePath: string;
  widthPixels: number;
  heightPixels: number;
}

export class SharpImagePipeline {
  private readonly timeoutSeconds: number;

  public constructor(private readonly config: ProcessorConfig) {
    sharp.cache(false);
    sharp.concurrency(1);
    this.timeoutSeconds = Math.max(1, Math.ceil(config.toolTimeoutMilliseconds / 1_000));
  }

  public async normalizePage(input: {
    sourcePath: string;
    pageNumber: number;
    canonicalDirectory: string;
    previewDirectory: string;
    signal?: AbortSignal;
    timings?: StageRecorder;
  }): Promise<CanonicalPage> {
    input.signal?.throwIfAborted();
    await Promise.all([
      mkdir(input.canonicalDirectory, { recursive: true, mode: 0o700 }),
      mkdir(input.previewDirectory, { recursive: true, mode: 0o700 })
    ]);

    const metadata = await this.readMetadata(input.sourcePath);
    const pages = metadata.pages ?? 1;
    if (pages !== 1) {
      throw new ProcessorError("UNSUPPORTED_DOCUMENT_CONTENT", 422);
    }
    if (!metadata.width || !metadata.height) {
      throw new ProcessorError("MALFORMED_DOCUMENT", 422);
    }

    const orientationSwapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const orientedWidth = orientationSwapsAxes ? metadata.height : metadata.width;
    const orientedHeight = orientationSwapsAxes ? metadata.width : metadata.height;
    this.assertDimensions(orientedWidth, orientedHeight);

    const landscape = orientedWidth > orientedHeight;
    const widthPixels = landscape
      ? A4_LONG_EDGE_PIXELS_AT_300_DPI
      : A4_SHORT_EDGE_PIXELS_AT_300_DPI;
    const heightPixels = landscape
      ? A4_SHORT_EDGE_PIXELS_AT_300_DPI
      : A4_LONG_EDGE_PIXELS_AT_300_DPI;
    const suffix = String(input.pageNumber).padStart(6, "0");
    const imagePath = join(input.canonicalDirectory, `page-${suffix}.png`);
    const previewPath = join(input.previewDirectory, `page-${suffix}.webp`);
    const previewArchivePath = `previews/page-${input.pageNumber}.webp`;

    const stopNormalize = input.timings?.start("normalize") ?? (() => undefined);
    let normalizeStopped = false;
    try {
      // Materialise the normalized page once, as raw greyscale pixels, and
      // encode both artifacts from it. Previously the preview re-opened and
      // re-decoded the canonical PNG that the line above had just written —
      // a second full decode of an ~8.7 megapixel image per page. PNG is
      // lossless, so these pixels are exactly what that decode returned and
      // both outputs stay byte-for-byte identical.
      const { data, info } = await this.openUntrusted(input.sourcePath)
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({
          width: widthPixels,
          height: heightPixels,
          fit: "contain",
          background: "#ffffff",
          kernel: sharp.kernel.lanczos3
        })
        .grayscale()
        .toColourspace("b-w")
        .raw()
        .timeout({ seconds: this.timeoutSeconds })
        .toBuffer({ resolveWithObject: true });
      input.signal?.throwIfAborted();

      // The dimensions were derived above and the pixel budget was already
      // checked, so a mismatch here means the pipeline itself misbehaved
      // rather than that the document was bad.
      if (
        info.width !== widthPixels ||
        info.height !== heightPixels ||
        info.channels !== 1 ||
        data.byteLength !== widthPixels * heightPixels
      ) {
        throw new ProcessorError("INTERNAL_ERROR", 500, true);
      }
      const rawPage = {
        raw: { width: info.width, height: info.height, channels: 1 as const }
      };

      // Raw input carries no colourspace, and the encoders promote to sRGB
      // without this. Restating it keeps the canonical page single-channel
      // greyscale, exactly as the previous file-to-file pipeline produced.
      await sharp(data, rawPage)
        .toColourspace("b-w")
        .png({
          compressionLevel: this.config.canonicalPngCompressionLevel,
          adaptiveFiltering: this.config.canonicalPngAdaptiveFiltering,
          palette: false,
          force: true
        })
        .timeout({ seconds: this.timeoutSeconds })
        .toFile(imagePath);
      input.signal?.throwIfAborted();
      stopNormalize();
      normalizeStopped = true;

      const stopPreview = input.timings?.start("preview") ?? (() => undefined);
      try {
        await sharp(data, rawPage)
          .toColourspace("b-w")
          .resize({
            width: Math.min(this.config.previewWidth, widthPixels),
            height: Math.min(this.config.previewHeight, heightPixels),
            fit: "inside",
            withoutEnlargement: true,
            kernel: sharp.kernel.lanczos3
          })
          .webp({
            quality: 82,
            alphaQuality: 100,
            effort: this.config.previewWebpEffort,
            force: true
          })
          .timeout({ seconds: this.timeoutSeconds })
          .toFile(previewPath);
      } finally {
        stopPreview();
      }
      input.signal?.throwIfAborted();
    } catch (error) {
      if (!normalizeStopped) stopNormalize();
      if (error instanceof ProcessorError) throw error;
      if (input.signal?.aborted || isSharpTimeout(error)) {
        throw new ProcessorError("PROCESSING_TIMEOUT", 422);
      }
      if (isResourceCapacityError(error)) {
        throw new ProcessorError("PROCESSOR_CAPACITY_EXHAUSTED", 503, true);
      }
      throw new ProcessorError("MALFORMED_DOCUMENT", 422);
    }

    const [canonicalStat, previewStat] = await Promise.all([stat(imagePath), stat(previewPath)]);
    if (
      !canonicalStat.isFile() ||
      canonicalStat.size < 1 ||
      canonicalStat.size > MAX_CANONICAL_PAGE_BYTES ||
      !previewStat.isFile() ||
      previewStat.size < 1 ||
      previewStat.size > this.config.maxPreviewBytes
    ) {
      throw new ProcessorError("OUTPUT_SIZE_LIMIT_EXCEEDED", 422);
    }
    return {
      pageNumber: input.pageNumber,
      imagePath,
      previewPath,
      previewArchivePath,
      widthPixels,
      heightPixels
    };
  }

  private async readMetadata(path: string): Promise<SharpMetadata> {
    try {
      // Reading only the JPEG/PNG header without Sharp's pixel-limit gate lets
      // us return the precise dimension or pixel-limit rejection below. The
      // actual decode still uses the strict configured pixel limit.
      return await sharp(path, {
        failOn: "warning",
        limitInputPixels: false,
        sequentialRead: true,
        unlimited: false,
        animated: false,
        pages: 1
      }).metadata();
    } catch {
      throw new ProcessorError("MALFORMED_DOCUMENT", 422);
    }
  }

  private openUntrusted(path: string): SharpInstance {
    return sharp(path, {
      failOn: "warning",
      limitInputPixels: this.config.maxImagePixels,
      sequentialRead: true,
      unlimited: false,
      animated: false,
      pages: 1
    });
  }

  private assertDimensions(width: number, height: number): void {
    if (width > this.config.maxImageDimension || height > this.config.maxImageDimension) {
      throw new ProcessorError("IMAGE_DIMENSION_LIMIT_EXCEEDED", 422);
    }
    if (width > Math.floor(this.config.maxImagePixels / height)) {
      throw new ProcessorError("IMAGE_PIXEL_LIMIT_EXCEEDED", 422);
    }
  }
}

function isSharpTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.toLocaleLowerCase("en-US").includes("timeout");
}
