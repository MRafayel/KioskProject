import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { pack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentProcessorClient,
  ProcessorRequestError,
  type ProcessorClientOptions,
  type ProcessorManifest
} from "./processor-client.js";

const servers: Server[] = [];
const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map(async (server) => {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }),
    ...scratchDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true }))
  ]);
});

describe("DocumentProcessorClient", () => {
  it("accepts only an integrity-checked bounded canonical bundle", async () => {
    const normalized = Buffer.from("%PDF-1.4\n%%EOF\n", "ascii");
    const preview = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WEBPVP8 ", "ascii"),
      Buffer.alloc(8)
    ]);
    const manifest = validManifest(normalized, preview);
    const archive = await createArchive([
      ["manifest.json", Buffer.from(JSON.stringify(manifest), "utf8")],
      ["normalized/document.pdf", normalized],
      ["previews/page-1.webp", preview]
    ]);
    const endpoint = await startProcessor((_request, response) => {
      response.writeHead(200, {
        "content-length": String(archive.byteLength),
        "content-type": "application/x-tar",
        "x-content-sha256": sha256(archive)
      });
      response.end(archive);
    });
    const scratch = await createScratchDirectory();
    const client = testClient(endpoint, scratch);
    const source = Buffer.from("%PDF-1.4\nsource\n", "ascii");

    const result = await client.process({
      body: Readable.from([source]),
      contentLength: source.byteLength,
      contentSha256: sha256(source),
      kind: "PDF"
    });

    expect(result.manifest).toEqual(manifest);
    expect(result.normalized).toMatchObject({
      archivePath: "normalized/document.pdf",
      sizeBytes: normalized.byteLength,
      sha256: sha256(normalized)
    });
    expect(result.pages).toHaveLength(1);
    await result.cleanup();
  });

  it("rejects an archive path before it can escape scratch storage", async () => {
    const payload = Buffer.from("private", "utf8");
    const archive = await createArchive([["../escape", payload]]);
    const endpoint = await startProcessor((_request, response) => {
      response.writeHead(200, {
        "content-length": String(archive.byteLength),
        "content-type": "application/x-tar",
        "x-content-sha256": sha256(archive)
      });
      response.end(archive);
    });
    const scratch = await createScratchDirectory();
    const client = testClient(endpoint, scratch);
    const source = Buffer.from("%PDF-1.4\nsource\n", "ascii");

    await expect(
      client.process({
        body: Readable.from([source]),
        contentLength: source.byteLength,
        contentSha256: sha256(source),
        kind: "PDF"
      })
    ).rejects.toMatchObject({ code: "PROCESSOR_ARCHIVE_INVALID" });
  });

  it("preserves only a structured safe processor rejection", async () => {
    const endpoint = await startProcessor((_request, response) => {
      const body = Buffer.from(
        JSON.stringify({ error: { code: "PASSWORD_PROTECTED_PDF", retryable: false } }),
        "utf8"
      );
      response.writeHead(422, {
        "content-length": String(body.byteLength),
        "content-type": "application/json"
      });
      response.end(body);
    });
    const scratch = await createScratchDirectory();
    const client = testClient(endpoint, scratch);
    const source = Buffer.from("%PDF-1.4\nsource\n", "ascii");

    const failure = client.process({
      body: Readable.from([source]),
      contentLength: source.byteLength,
      contentSha256: sha256(source),
      kind: "PDF"
    });
    await expect(failure).rejects.toBeInstanceOf(ProcessorRequestError);
    await expect(failure).rejects.toMatchObject({
      code: "PASSWORD_PROTECTED_PDF",
      retryable: false
    });
  });

  it("fails closed when the response digest is not the received tar", async () => {
    const archive = await createArchive([["manifest.json", Buffer.from("{}")]]);
    const endpoint = await startProcessor((_request, response) => {
      response.writeHead(200, {
        "content-length": String(archive.byteLength),
        "content-type": "application/x-tar",
        "x-content-sha256": "0".repeat(64)
      });
      response.end(archive);
    });
    const scratch = await createScratchDirectory();
    const source = Buffer.from("%PDF-1.4\nsource\n", "ascii");

    await expect(
      testClient(endpoint, scratch).process({
        body: Readable.from([source]),
        contentLength: source.byteLength,
        contentSha256: sha256(source),
        kind: "PDF"
      })
    ).rejects.toMatchObject({ code: "PROCESSOR_RESPONSE_INTEGRITY_FAILED" });
  });

  it.each([
    { statusCode: 401, code: "INVALID_AUTHENTICATION", retryable: false },
    { statusCode: 400, code: "INVALID_PROTOCOL_VERSION", retryable: false },
    { statusCode: 503, code: "PROCESSOR_BUSY", retryable: true }
  ])(
    "destroys an unfinished source stream after an early $statusCode response",
    async ({ statusCode, code, retryable }) => {
      const endpoint = await startProcessor((_request, response) => {
        const body = Buffer.from(JSON.stringify({ error: { code, retryable } }), "utf8");
        response.writeHead(statusCode, {
          "content-length": String(body.byteLength),
          "content-type": "application/json"
        });
        response.end(body);
      });
      const scratch = await createScratchDirectory();
      const source = new NeverEndingSource();

      await expect(
        testClient(endpoint, scratch).process({
          body: source,
          contentLength: 1_024 * 1_024,
          contentSha256: "a".repeat(64),
          kind: "PDF"
        })
      ).rejects.toMatchObject({ code, retryable });
      expect(source.destroyed).toBe(true);
    }
  );

  it("destroys an unfinished source stream when the processor times out", async () => {
    const endpoint = await startProcessor(() => undefined);
    const scratch = await createScratchDirectory();
    const source = new NeverEndingSource();

    await expect(
      testClient(endpoint, scratch, { timeoutMilliseconds: 50 }).process({
        body: source,
        contentLength: 1_024 * 1_024,
        contentSha256: "a".repeat(64),
        kind: "PDF"
      })
    ).rejects.toMatchObject({ code: "PROCESSING_TIMEOUT", retryable: true });
    expect(source.destroyed).toBe(true);
  });
});

async function createScratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "processor-client-test-"));
  scratchDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function testClient(
  endpoint: string,
  scratchDirectory: string,
  overrides: Partial<ProcessorClientOptions> = {}
): DocumentProcessorClient {
  return new DocumentProcessorClient({
    endpoint,
    authToken: "processor-test-token-with-at-least-32-bytes",
    scratchDirectory,
    timeoutMilliseconds: 5_000,
    maxResponseBytes: 5 * 1024 * 1024,
    maxPages: 5,
    maxPreviewBytes: 1_024 * 1_024,
    maxNormalizedBytes: 1_024 * 1_024,
    ...overrides
  });
}

class NeverEndingSource extends Readable {
  private sentInitialChunk = false;

  public override _read(): void {
    if (this.sentInitialChunk) return;
    this.sentInitialChunk = true;
    this.push(Buffer.alloc(16 * 1_024, 0x61));
  }
}

function validManifest(normalized: Buffer, preview: Buffer): ProcessorManifest {
  return {
    protocolVersion: 1,
    kind: "PDF",
    pageCount: 1,
    normalized: {
      path: "normalized/document.pdf",
      mime: "application/pdf",
      sizeBytes: normalized.byteLength,
      sha256: sha256(normalized)
    },
    pages: [
      {
        pageNumber: 1,
        widthPixels: 900,
        heightPixels: 1200,
        preview: {
          path: "previews/page-1.webp",
          mime: "image/webp",
          sizeBytes: preview.byteLength,
          sha256: sha256(preview)
        }
      }
    ],
    malware: {
      engineVersion: "1.4.3",
      definitionsVersion: "27801",
      scannedAt: "2026-07-24T00:00:00.000Z"
    }
  };
}

async function createArchive(entries: Array<[string, Buffer]>): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.once("end", () => resolve(Buffer.concat(chunks)));
    archive.once("error", reject);
  });
  for (const [name, value] of entries) {
    await new Promise<void>((resolve, reject) => {
      archive.entry({ name, size: value.byteLength, type: "file" }, value, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  archive.finalize();
  return completed;
}

async function startProcessor(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
  return `http://127.0.0.1:${address.port}`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
