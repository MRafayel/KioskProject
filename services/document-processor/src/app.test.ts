import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProcessorServer } from "./app.js";
import type { ProcessorConfig } from "./config.js";
import type {
  InternalDocumentProcessor,
  ProcessDocumentInput,
  ProcessedDocument
} from "./types.js";

const AUTH_TOKEN = "test-only-processor-token-32-bytes-long";
const BODY = Buffer.from("%PDF-1.7\n", "utf8");

describe("document processor HTTP boundary", () => {
  let scratchDirectory: string;
  let fake: FakeProcessor;
  let server: ReturnType<typeof createProcessorServer>;
  let origin: string;

  beforeEach(async () => {
    scratchDirectory = await mkdtemp(join(tmpdir(), "processor-test-"));
    fake = new FakeProcessor(scratchDirectory);
    server = createProcessorServer({
      config: testConfig(scratchDirectory),
      processor: fake
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    server.closeAllConnections();
    await closed;
    await rm(scratchDirectory, { recursive: true, force: true });
  });

  it("rejects an unauthenticated request before invoking the processor", async () => {
    const response = await fetch(`${origin}/internal/v1/process`, {
      method: "POST",
      headers: requestHeaders({ authorization: undefined }),
      body: BODY
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "AUTHENTICATION_REQUIRED", retryable: false }
    });
    expect(fake.processCalls).toBe(0);
  });

  it("requires a fixed length, exact media type, kind and digest", async () => {
    const response = await fetch(`${origin}/internal/v1/process`, {
      method: "POST",
      headers: requestHeaders({ contentType: "application/pdf" }),
      body: BODY
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_CONTENT_TYPE", retryable: false }
    });
    expect(fake.processCalls).toBe(0);
  });

  it("rejects an unsupported protocol version before reading the document", async () => {
    const response = await fetch(`${origin}/internal/v1/process`, {
      method: "POST",
      headers: {
        ...requestHeaders({}),
        "x-processor-protocol-version": "2"
      },
      body: BODY
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_PROTOCOL_VERSION", retryable: false }
    });
    expect(fake.processCalls).toBe(0);
  });

  it("returns a fixed-size private tar response compatible with the worker", async () => {
    const response = await fetch(`${origin}/internal/v1/process`, {
      method: "POST",
      headers: requestHeaders({}),
      body: BODY
    });
    const responseBody = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    expect(Number(response.headers.get("content-length"))).toBe(responseBody.byteLength);
    expect(response.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(responseBody).digest("hex")
    );
    expect(fake.processCalls).toBe(1);
    expect(fake.lastInput).toMatchObject({
      kind: "PDF",
      contentLength: BODY.byteLength,
      expectedSha256: sha256(BODY)
    });
  });

  it("never leaks an unexpected processor error", async () => {
    fake.failure = new Error("private parser stderr and path");
    const response = await fetch(`${origin}/internal/v1/process`, {
      method: "POST",
      headers: requestHeaders({}),
      body: BODY
    });
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(raw)).toEqual({
      error: { code: "INTERNAL_ERROR", retryable: true }
    });
    expect(raw).not.toContain("parser");
    expect(raw).not.toContain("path");
  });

  it("allows only one processing request at a time", async () => {
    let release: (() => void) | undefined;
    fake.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = fetch(`${origin}/internal/v1/process`, {
      method: "POST",
      headers: requestHeaders({}),
      body: BODY
    });
    await fake.started;

    const second = await fetch(`${origin}/internal/v1/process`, {
      method: "POST",
      headers: requestHeaders({}),
      body: BODY
    });
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({
      error: { code: "PROCESSOR_BUSY", retryable: true }
    });

    release?.();
    expect((await first).status).toBe(200);
  });
});

class FakeProcessor implements InternalDocumentProcessor {
  public processCalls = 0;
  public failure: Error | undefined;
  public wait: Promise<void> | undefined;
  public lastInput: ProcessDocumentInput | undefined;
  private startedResolve: (() => void) | undefined;
  public started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  public constructor(private readonly directory: string) {}

  public checkReady() {
    return Promise.resolve({ malwareScanner: "ok" as const, nativeTools: "ok" as const });
  }

  public async process(input: ProcessDocumentInput): Promise<ProcessedDocument> {
    this.processCalls += 1;
    this.lastInput = input;
    for await (const chunk of input.body) {
      // Consume the exact request body before producing an artifact.
      void chunk;
    }
    this.startedResolve?.();
    if (this.wait) await this.wait;
    if (this.failure) throw this.failure;

    const output = join(this.directory, `normalized-${this.processCalls}.pdf`);
    const preview = join(this.directory, `preview-${this.processCalls}.webp`);
    await mkdir(this.directory, { recursive: true });
    const normalizedBytes = Buffer.from("canonical-pdf", "utf8");
    const previewBytes = Buffer.from("inert-webp", "utf8");
    await Promise.all([writeFile(output, normalizedBytes), writeFile(preview, previewBytes)]);
    return {
      manifest: {
        protocolVersion: 1,
        kind: input.kind,
        pageCount: 1,
        normalized: {
          path: "normalized/document.pdf",
          mime: "application/pdf",
          sizeBytes: normalizedBytes.byteLength,
          sha256: sha256(normalizedBytes)
        },
        pages: [
          {
            pageNumber: 1,
            widthPixels: 2_480,
            heightPixels: 3_508,
            preview: {
              path: "previews/page-1.webp",
              mime: "image/webp",
              sizeBytes: previewBytes.byteLength,
              sha256: sha256(previewBytes)
            }
          }
        ],
        malware: {
          engineVersion: "test",
          definitionsVersion: "test",
          scannedAt: new Date(0).toISOString()
        }
      },
      artifacts: [
        {
          archivePath: "normalized/document.pdf",
          filesystemPath: output,
          sizeBytes: normalizedBytes.byteLength
        },
        {
          archivePath: "previews/page-1.webp",
          filesystemPath: preview,
          sizeBytes: previewBytes.byteLength
        }
      ],
      cleanup: () => Promise.resolve()
    };
  }
}

function requestHeaders(overrides: {
  authorization?: string | undefined;
  contentType?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-length": String(BODY.byteLength),
    "content-type": overrides.contentType ?? "application/octet-stream",
    "x-content-sha256": sha256(BODY),
    "x-document-kind": "PDF"
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "authorization")) {
    headers.authorization = `Bearer ${AUTH_TOKEN}`;
  } else if (overrides.authorization !== undefined) {
    headers.authorization = overrides.authorization;
  }
  return headers;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function testConfig(scratchDirectory: string): ProcessorConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH_TOKEN,
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
