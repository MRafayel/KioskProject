import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { PreviewActorRateLimiter, previewIpRateKey, readVerifiedPreview } from "./previews.js";

const validWebp = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0, 1, 2, 3])
]);

describe("readVerifiedPreview", () => {
  it("returns only a bounded WebP matching the durable ledger digest", async () => {
    await expect(
      readVerifiedPreview({
        body: Readable.from([validWebp.subarray(0, 6), validWebp.subarray(6)]),
        expectedBytes: validWebp.byteLength,
        expectedSha256: createHash("sha256").update(validWebp).digest("hex"),
        maximumBytes: 1_024
      })
    ).resolves.toEqual(validWebp);
  });

  it("rejects replacement bytes even when their length and signature match", async () => {
    const replaced = Buffer.from(validWebp);
    replaced.writeUInt8((replaced.at(-1) ?? 0) ^ 0xff, replaced.length - 1);
    await expect(
      readVerifiedPreview({
        body: Readable.from([replaced]),
        expectedBytes: replaced.byteLength,
        expectedSha256: createHash("sha256").update(validWebp).digest("hex"),
        maximumBytes: 1_024
      })
    ).rejects.toThrow("PREVIEW_INTEGRITY_MISMATCH");
  });

  it("stops reading when storage exceeds the ledger size", async () => {
    await expect(
      readVerifiedPreview({
        body: Readable.from([validWebp, Buffer.from([4])]),
        expectedBytes: validWebp.byteLength,
        expectedSha256: createHash("sha256").update(validWebp).digest("hex"),
        maximumBytes: 1_024
      })
    ).rejects.toThrow("PREVIEW_SIZE_MISMATCH");
  });
});

describe("preview request rate limits", () => {
  it("uses only the connection IP for the unauthenticated limiter key", () => {
    const first = previewIpRateKey({
      ip: "203.0.113.7",
      headers: { authorization: "Bearer invalid-one" }
    } as never);
    const second = previewIpRateKey({
      ip: "203.0.113.7",
      headers: { authorization: "Bearer invalid-two" }
    } as never);

    expect(first).toBe(second);
  });

  it("limits each authenticated credential and resets after the fixed window", () => {
    const limiter = new PreviewActorRateLimiter(1_000, 10);

    limiter.consume("preview:credential-1", 2, 1_000);
    limiter.consume("preview:credential-1", 2, 1_100);
    expect(() => limiter.consume("preview:credential-1", 2, 1_200)).toThrow(
      expect.objectContaining({ statusCode: 429, code: "PREVIEW_RATE_LIMIT_REACHED" })
    );
    expect(() => limiter.consume("preview:credential-2", 2, 1_200)).not.toThrow();
    expect(() => limiter.consume("preview:credential-1", 2, 2_000)).not.toThrow();
  });
});
