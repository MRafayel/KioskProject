import { describe, expect, it } from "vitest";

import { loadProcessorConfig } from "./config.js";

const BASE_ENV = {
  DOCUMENT_PROCESSOR_AUTH_TOKEN: "test-only-processor-token-32-bytes-long",
  CLAMAV_HOST: "127.0.0.1",
  CLAMAV_PORT: "3310"
} satisfies NodeJS.ProcessEnv;

describe("document processor configuration", () => {
  it("accepts the shared conservative maximum source-pixel limit", () => {
    expect(
      loadProcessorConfig({
        ...BASE_ENV,
        MAX_IMAGE_PIXELS: "200000000"
      }).maxImagePixels
    ).toBe(200_000_000);
  });

  it("rejects a source-pixel limit above the processor hard bound", () => {
    expect(() =>
      loadProcessorConfig({
        ...BASE_ENV,
        MAX_IMAGE_PIXELS: "200000001"
      })
    ).toThrow("PROCESSOR_MAX_IMAGE_PIXELS_INVALID");
  });

  // An unset Compose variable is passed through as an empty string rather than
  // being absent, and Number("") is 0. Every numeric setting must fall back to
  // its default instead of silently becoming zero — reaching the encoder, that
  // would quietly change output quality with no error anywhere.
  it("treats an empty value as unset for every tunable", () => {
    const config = loadProcessorConfig({
      ...BASE_ENV,
      PROCESSOR_PREVIEW_WEBP_EFFORT: "",
      PROCESSOR_CANONICAL_PNG_COMPRESSION_LEVEL: "",
      PROCESSOR_CANONICAL_PNG_ADAPTIVE_FILTERING: "",
      PROCESSOR_RASTER_FORMAT: "",
      PROCESSOR_TIMING_LOG: "",
      PROCESSOR_MAX_PAGES: "",
      PROCESSOR_TIMEOUT_SECONDS: ""
    });

    expect(config.previewWebpEffort).toBe(4);
    expect(config.canonicalPngCompressionLevel).toBe(6);
    expect(config.canonicalPngAdaptiveFiltering).toBe(false);
    expect(config.rasterFormat).toBe("tiff");
    expect(config.timingLog).toBe(false);
    expect(config.maxPages).toBe(200);
    expect(config.processTimeoutMilliseconds).toBe(120_000);
  });

  it("restores the pre-optimization encoders when explicitly configured", () => {
    const config = loadProcessorConfig({
      ...BASE_ENV,
      PROCESSOR_RASTER_FORMAT: "png",
      PROCESSOR_CANONICAL_PNG_COMPRESSION_LEVEL: "9",
      PROCESSOR_CANONICAL_PNG_ADAPTIVE_FILTERING: "true"
    });

    expect(config.rasterFormat).toBe("png");
    expect(config.canonicalPngCompressionLevel).toBe(9);
    expect(config.canonicalPngAdaptiveFiltering).toBe(true);
  });

  it("rejects an unknown raster format", () => {
    expect(() => loadProcessorConfig({ ...BASE_ENV, PROCESSOR_RASTER_FORMAT: "jpeg" })).toThrow(
      "PROCESSOR_RASTER_FORMAT_INVALID"
    );
  });
});
