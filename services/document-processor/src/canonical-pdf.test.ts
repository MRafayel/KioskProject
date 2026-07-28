import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CanonicalPdfWriter } from "./canonical-pdf.js";
import type { CanonicalPage } from "./image-pipeline.js";

describe("CanonicalPdfWriter", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "canonical-pdf-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("embeds pages incrementally and removes each canonical image before finalization", async () => {
    const first = await page(1, false);
    const second = await page(2, true);
    const outputPath = join(directory, "normalized.pdf");
    const writer = new CanonicalPdfWriter({
      outputPath,
      maximumBytes: 1024 * 1024,
      signal: new AbortController().signal
    });

    await writer.addPage(first);
    await expect(access(first.imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(second.imagePath)).resolves.toBeUndefined();

    await writer.addPage(second);
    await expect(access(second.imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    const size = await writer.finalize();

    expect(size).toBeGreaterThan(0);
    expect((await stat(outputPath)).size).toBe(size);
    const pdf = await readFile(outputPath);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("D:19700101000000Z");
  });

  it("removes the current page and partial PDF when bounded output generation fails", async () => {
    const canonicalPage = await page(1, false);
    const outputPath = join(directory, "too-large.pdf");
    const writer = new CanonicalPdfWriter({
      outputPath,
      maximumBytes: 64,
      signal: new AbortController().signal
    });

    let failure: unknown;
    try {
      await writer.addPage(canonicalPage);
      await writer.finalize();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "OUTPUT_SIZE_LIMIT_EXCEEDED" });
    await expect(access(canonicalPage.imagePath)).rejects.toMatchObject({ code: "ENOENT" });

    await writer.abort();
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  async function page(pageNumber: number, landscape: boolean): Promise<CanonicalPage> {
    const imagePath = join(directory, `page-${pageNumber}.png`);
    await sharp({
      create: {
        width: landscape ? 40 : 30,
        height: landscape ? 30 : 40,
        channels: 3,
        background: pageNumber === 1 ? "#222222" : "#dddddd"
      }
    })
      .grayscale()
      .toColourspace("b-w")
      .png()
      .toFile(imagePath);
    return {
      pageNumber,
      imagePath,
      previewPath: join(directory, `preview-${pageNumber}.webp`),
      previewArchivePath: `previews/page-${pageNumber}.webp`,
      widthPixels: landscape ? 3_508 : 2_480,
      heightPixels: landscape ? 2_480 : 3_508
    };
  }
});
