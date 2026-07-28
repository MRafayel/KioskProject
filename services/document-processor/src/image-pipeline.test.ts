import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessorConfig } from "./config.js";
import { SharpImagePipeline } from "./image-pipeline.js";

describe("SharpImagePipeline", () => {
  let scratchDirectory: string;

  beforeEach(async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), "sharp-pipeline-test-"));
  });

  afterEach(async () => {
    await rm(scratchDirectory, { recursive: true, force: true });
  });

  it("normalizes an orientation-tagged JPEG to one metadata-free monochrome A4 page", async () => {
    const sourcePath = join(scratchDirectory, "source.jpg");
    await sharp({
      create: {
        width: 8,
        height: 4,
        channels: 3,
        background: { r: 220, g: 40, b: 20 }
      }
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(sourcePath);

    const page = await normalize(sourcePath, testConfig());
    const [canonical, preview, previewFile] = await Promise.all([
      sharp(page.imagePath).metadata(),
      sharp(page.previewPath).metadata(),
      stat(page.previewPath)
    ]);

    expect(page).toMatchObject({
      pageNumber: 1,
      previewArchivePath: "previews/page-1.webp",
      widthPixels: 2_480,
      heightPixels: 3_508
    });
    expect(canonical).toMatchObject({
      format: "png",
      width: 2_480,
      height: 3_508,
      space: "b-w",
      channels: 1
    });
    expect(canonical.orientation).toBeUndefined();
    expect(canonical.exif).toBeUndefined();
    expect(canonical.icc).toBeUndefined();
    expect(canonical.xmp).toBeUndefined();
    expect(preview.format).toBe("webp");
    expect(preview.width).toBeLessThanOrEqual(320);
    expect(preview.height).toBeLessThanOrEqual(320);
    expect(previewFile.size).toBeGreaterThan(0);
    expect(previewFile.size).toBeLessThanOrEqual(testConfig().maxPreviewBytes);
  });

  it("normalizes a PNG to one monochrome landscape A4 page and bounded WebP", async () => {
    const sourcePath = join(scratchDirectory, "source.png");
    await sharp({
      create: {
        width: 8,
        height: 4,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 0.5 }
      }
    })
      .png()
      .toFile(sourcePath);

    const page = await normalize(sourcePath, testConfig());
    const [canonical, preview, previewFile] = await Promise.all([
      sharp(page.imagePath).metadata(),
      sharp(page.previewPath).metadata(),
      stat(page.previewPath)
    ]);

    expect(page).toMatchObject({
      pageNumber: 1,
      widthPixels: 3_508,
      heightPixels: 2_480
    });
    expect(canonical).toMatchObject({
      format: "png",
      width: 3_508,
      height: 2_480,
      space: "b-w",
      channels: 1
    });
    expect(preview.format).toBe("webp");
    expect(preview.width).toBeLessThanOrEqual(320);
    expect(preview.height).toBeLessThanOrEqual(320);
    expect(previewFile.size).toBeGreaterThan(0);
    expect(previewFile.size).toBeLessThanOrEqual(testConfig().maxPreviewBytes);
  });

  it("maps malformed bytes to a safe malformed-document rejection", async () => {
    const sourcePath = join(scratchDirectory, "malformed.png");
    await writeFile(
      sourcePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    );

    await expect(normalize(sourcePath, testConfig())).rejects.toMatchObject({
      code: "MALFORMED_DOCUMENT",
      retryable: false
    });
  });

  it("maps an oversized source edge to IMAGE_DIMENSION_LIMIT_EXCEEDED", async () => {
    const sourcePath = join(scratchDirectory, "wide.png");
    await sharp({
      create: {
        width: 12,
        height: 2,
        channels: 3,
        background: "#808080"
      }
    })
      .png()
      .toFile(sourcePath);

    await expect(
      normalize(sourcePath, testConfig({ maxImageDimension: 10, maxImagePixels: 1_000 }))
    ).rejects.toMatchObject({
      code: "IMAGE_DIMENSION_LIMIT_EXCEEDED",
      retryable: false
    });
  });

  it("maps excessive source pixels to IMAGE_PIXEL_LIMIT_EXCEEDED", async () => {
    const sourcePath = join(scratchDirectory, "many-pixels.png");
    await sharp({
      create: {
        width: 11,
        height: 10,
        channels: 3,
        background: "#808080"
      }
    })
      .png()
      .toFile(sourcePath);

    await expect(
      normalize(sourcePath, testConfig({ maxImageDimension: 20, maxImagePixels: 100 }))
    ).rejects.toMatchObject({
      code: "IMAGE_PIXEL_LIMIT_EXCEEDED",
      retryable: false
    });
  });

  async function normalize(sourcePath: string, config: ProcessorConfig) {
    return new SharpImagePipeline(config).normalizePage({
      sourcePath,
      pageNumber: 1,
      canonicalDirectory: join(scratchDirectory, "canonical"),
      previewDirectory: join(scratchDirectory, "previews"),
      signal: new AbortController().signal
    });
  }
});

function testConfig(overrides: Partial<ProcessorConfig> = {}): ProcessorConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "test-only-processor-token-32-bytes-long",
    scratchDirectory: "/unused",
    maxInputBytes: 1024 * 1024,
    maxResponseBytes: 16 * 1024 * 1024,
    maxNormalizedBytes: 8 * 1024 * 1024,
    maxPreviewBytes: 2 * 1024 * 1024,
    maxPages: 10,
    maxImagePixels: 40_000_000,
    maxImageDimension: 20_000,
    maximumRasterDimension: 3_508,
    rasterFormat: "tiff" as const,
    canonicalPngCompressionLevel: 6,
    canonicalPngAdaptiveFiltering: false,
    previewWebpEffort: 4,
    previewWidth: 320,
    previewHeight: 320,
    processTimeoutMilliseconds: 30_000,
    toolTimeoutMilliseconds: 30_000,
    scannerTimeoutMilliseconds: 1_000,
    scannerDefinitionMaxAgeMilliseconds: 60_000,
    timingLog: false,
    timingDetail: false,
    clamavHost: "127.0.0.1",
    clamavPort: 3310,
    ...overrides
  };
}
