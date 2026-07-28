import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { extract as createTarExtractor } from "tar-stream";

const MANIFEST_ARCHIVE_PATH = "manifest.json";
const NORMALIZED_ARCHIVE_PATH = "normalized/document.pdf";
const PREVIEW_ARCHIVE_PATH = /^previews\/page-([1-9]\d{0,3})\.webp$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;
const ERROR_BODY_LIMIT_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ProcessorDocumentKind = "PDF" | "JPEG" | "PNG";

export interface ProcessorArtifactManifest {
  path: string;
  mime: "application/pdf" | "image/webp";
  sizeBytes: number;
  sha256: string;
}

export interface ProcessorPageManifest {
  pageNumber: number;
  widthPixels: number;
  heightPixels: number;
  preview: ProcessorArtifactManifest & { mime: "image/webp" };
}

export interface ProcessorManifest {
  protocolVersion: 1;
  kind: ProcessorDocumentKind;
  pageCount: number;
  normalized: ProcessorArtifactManifest & { mime: "application/pdf" };
  pages: ProcessorPageManifest[];
  malware: {
    engineVersion: string;
    definitionsVersion: string;
    scannedAt: string;
  };
}

export interface ProcessorArtifact {
  archivePath: string;
  temporaryPath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ProcessorBundle {
  manifest: ProcessorManifest;
  normalized: ProcessorArtifact;
  pages: Array<{
    pageNumber: number;
    widthPixels: number;
    heightPixels: number;
    preview: ProcessorArtifact;
  }>;
  cleanup(): Promise<void>;
}

export interface ProcessDocumentInput {
  body: Readable;
  contentLength: number;
  contentSha256: string;
  kind: ProcessorDocumentKind;
  signal?: AbortSignal;
}

export interface ProcessorClientOptions {
  endpoint: string;
  authToken: string;
  scratchDirectory: string;
  timeoutMilliseconds: number;
  maxResponseBytes: number;
  maxPages: number;
  maxPreviewBytes: number;
  maxNormalizedBytes: number;
}

export class ProcessorRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(code);
    this.name = "ProcessorRequestError";
  }
}

export class DocumentProcessorClient {
  private readonly endpoint: URL;

  public constructor(private readonly options: ProcessorClientOptions) {
    this.endpoint = new URL("/internal/v1/process", options.endpoint);
    if (this.endpoint.protocol !== "http:" && this.endpoint.protocol !== "https:") {
      throw new Error("PROCESSOR_URL_PROTOCOL_UNSUPPORTED");
    }
    if (Buffer.byteLength(options.authToken, "utf8") < 32) {
      throw new Error("PROCESSOR_AUTH_TOKEN_TOO_SHORT");
    }
  }

  public async process(input: ProcessDocumentInput): Promise<ProcessorBundle> {
    try {
      assertInput(input);
    } catch (error) {
      cancelSource(input.body);
      throw error;
    }
    const deadline = AbortSignal.timeout(this.options.timeoutMilliseconds);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    let directory: string | undefined;
    let response: IncomingMessage | undefined;

    try {
      directory = await mkdtemp(join(this.options.scratchDirectory, "processor-response-"));
      response = await this.send(input, signal);
      if (response.statusCode !== 200) {
        // A processor can reject from headers alone (busy, authentication,
        // protocol, or request validation). Stop the S3 download immediately
        // instead of leaving its readable stream blocked behind the request.
        cancelSource(input.body);
        throw await parseProcessorError(response, signal);
      }
      const contentType = headerValue(response.headers, "content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/x-tar") {
        throw new ProcessorRequestError("PROCESSOR_RESPONSE_INVALID", true);
      }
      const contentLength = parseBoundedLength(
        headerValue(response.headers, "content-length"),
        this.options.maxResponseBytes
      );
      const responseSha256 = headerValue(response.headers, "x-content-sha256");
      if (!responseSha256 || !SHA256_PATTERN.test(responseSha256)) {
        throw new ProcessorRequestError("PROCESSOR_RESPONSE_INVALID", true);
      }
      const extracted = await extractResponse({
        response,
        directory,
        expectedBytes: contentLength,
        expectedSha256: responseSha256,
        signal,
        maxPages: this.options.maxPages,
        maxPreviewBytes: this.options.maxPreviewBytes,
        maxNormalizedBytes: this.options.maxNormalizedBytes
      });
      const responseDirectory = directory;
      return {
        ...extracted,
        cleanup: () => rm(responseDirectory, { recursive: true, force: true })
      };
    } catch (error) {
      // Cancel an upstream S3 GetObject body on every failed boundary:
      // connection errors, timeouts, early HTTP responses, malformed response
      // archives, and local scratch failures. Destroying an already-ended
      // readable is harmless and keeps this cleanup path idempotent.
      cancelSource(input.body);
      // Invalid headers and truncated/malformed archives can fail before the
      // response body is naturally exhausted. Explicitly destroy that stream
      // so a faulty processor cannot pin a worker socket or keep sending data.
      response?.destroy();
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof ProcessorRequestError) throw error;
      if (signal.aborted) {
        throw new ProcessorRequestError("PROCESSING_TIMEOUT", true);
      }
      throw new ProcessorRequestError("PROCESSOR_UNAVAILABLE", true);
    }
  }

  private send(input: ProcessDocumentInput, signal: AbortSignal): Promise<IncomingMessage> {
    signal.throwIfAborted();
    const requestFunction = this.endpoint.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const outgoing = requestFunction(
        this.endpoint,
        {
          method: "POST",
          headers: {
            accept: "application/x-tar",
            authorization: `Bearer ${this.options.authToken}`,
            "content-length": String(input.contentLength),
            "content-type": "application/octet-stream",
            "x-content-sha256": input.contentSha256,
            "x-document-kind": input.kind
          },
          signal
        },
        (response) => {
          if (response.statusCode !== 200 || !outgoing.writableFinished) {
            cancelRequestUpload(input.body, outgoing);
          }
          resolve(response);
        }
      );
      const onSourceError = (error: Error) => outgoing.destroy(error);
      const onAbort = () => cancelRequestUpload(input.body, outgoing);
      input.body.once("error", onSourceError);
      signal.addEventListener("abort", onAbort, { once: true });
      outgoing.once("error", (error) => {
        cancelRequestUpload(input.body, outgoing);
        reject(error);
      });
      outgoing.once("close", () => {
        input.body.off("error", onSourceError);
        signal.removeEventListener("abort", onAbort);
      });
      input.body.pipe(outgoing);
    });
  }
}

function cancelRequestUpload(body: Readable, outgoing: ReturnType<typeof httpRequest>): void {
  body.unpipe(outgoing);
  cancelSource(body);
  if (!outgoing.writableEnded && !outgoing.destroyed) outgoing.end();
}

function cancelSource(body: Readable): void {
  if (!body.destroyed) body.destroy();
}

async function extractResponse(input: {
  response: IncomingMessage;
  directory: string;
  expectedBytes: number;
  expectedSha256: string;
  signal: AbortSignal;
  maxPages: number;
  maxPreviewBytes: number;
  maxNormalizedBytes: number;
}): Promise<Omit<ProcessorBundle, "cleanup">> {
  const extract = createTarExtractor();
  const artifacts = new Map<string, ProcessorArtifact>();
  let manifestPath: string | undefined;
  let responseBytes = 0;
  const responseHash = createHash("sha256");
  let entryCount = 0;
  let extractionError: unknown;

  extract.on("entry", (header, entry, next) => {
    void (async () => {
      entryCount += 1;
      if (entryCount > input.maxPages + 2 || header.type !== "file") {
        throw new ProcessorRequestError("PROCESSOR_ARCHIVE_INVALID", true);
      }
      const archivePath = header.name;
      const entryLimit = entryByteLimit(
        archivePath,
        input.maxPages,
        input.maxPreviewBytes,
        input.maxNormalizedBytes
      );
      const temporaryPath = join(input.directory, `entry-${String(entryCount).padStart(4, "0")}`);
      const result = await writeAndHashEntry(entry, temporaryPath, entryLimit, input.signal);
      if (artifacts.has(archivePath) || (manifestPath && archivePath === MANIFEST_ARCHIVE_PATH)) {
        throw new ProcessorRequestError("PROCESSOR_ARCHIVE_INVALID", true);
      }
      if (archivePath === MANIFEST_ARCHIVE_PATH) manifestPath = temporaryPath;
      else artifacts.set(archivePath, { archivePath, temporaryPath, ...result });
    })()
      .then(next)
      .catch((error: unknown) => {
        extractionError = error;
        // Do not destroy the entry with an error before a pipeline has
        // attached its listener: that would create an uncaught EventEmitter
        // error for a header rejected before body consumption.
        entry.resume();
        extract.destroy(asError(error));
      });
  });

  const countResponseBytes = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      responseBytes += chunk.byteLength;
      if (responseBytes > input.expectedBytes) {
        callback(new ProcessorRequestError("PROCESSOR_RESPONSE_LENGTH_MISMATCH", true));
        return;
      }
      responseHash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(input.response, countResponseBytes, extract, { signal: input.signal });
  } catch (error) {
    throw extractionError ?? error;
  }
  if (responseBytes !== input.expectedBytes || !manifestPath) {
    throw new ProcessorRequestError("PROCESSOR_RESPONSE_LENGTH_MISMATCH", true);
  }
  if (responseHash.digest("hex") !== input.expectedSha256) {
    throw new ProcessorRequestError("PROCESSOR_RESPONSE_INTEGRITY_FAILED", true);
  }

  const rawManifest = await readFile(manifestPath, "utf8");
  const manifest = parseManifest(rawManifest, input.maxPages);
  assertArtifactMatches(manifest.normalized, artifacts.get(manifest.normalized.path));
  const normalized = artifacts.get(NORMALIZED_ARCHIVE_PATH);
  if (!normalized || manifest.normalized.path !== NORMALIZED_ARCHIVE_PATH) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  await assertArtifactSignature(normalized, "application/pdf");
  const pages = manifest.pages.map((page) => {
    const preview = artifacts.get(page.preview.path);
    assertArtifactMatches(page.preview, preview);
    if (!preview) throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
    return {
      pageNumber: page.pageNumber,
      widthPixels: page.widthPixels,
      heightPixels: page.heightPixels,
      preview
    };
  });
  const referenced = new Set([
    manifest.normalized.path,
    ...manifest.pages.map((page) => page.preview.path)
  ]);
  if (referenced.size !== artifacts.size) {
    throw new ProcessorRequestError("PROCESSOR_ARCHIVE_INVALID", true);
  }
  await Promise.all(pages.map((page) => assertArtifactSignature(page.preview, "image/webp")));
  return { manifest, normalized, pages };
}

function entryByteLimit(
  path: string,
  maxPages: number,
  maxPreviewBytes: number,
  maxNormalizedBytes: number
): number {
  if (path === MANIFEST_ARCHIVE_PATH) return MAX_MANIFEST_BYTES;
  if (path === NORMALIZED_ARCHIVE_PATH) return maxNormalizedBytes;
  const preview = PREVIEW_ARCHIVE_PATH.exec(path);
  if (preview?.[1] && Number(preview[1]) <= maxPages) return maxPreviewBytes;
  throw new ProcessorRequestError("PROCESSOR_ARCHIVE_INVALID", true);
}

async function writeAndHashEntry(
  input: Readable,
  path: string,
  maximumBytes: number,
  signal: AbortSignal
): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maximumBytes) {
        callback(new ProcessorRequestError("PROCESSOR_ARTIFACT_TOO_LARGE", true));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(input, inspect, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
  if (sizeBytes < 1) throw new ProcessorRequestError("PROCESSOR_ARTIFACT_EMPTY", true);
  return { sizeBytes, sha256: hash.digest("hex") };
}

function parseManifest(raw: string, maxPages: number): ProcessorManifest {
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  if (!isRecord(value) || value.protocolVersion !== 1 || !isKind(value.kind)) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  const pageCount = positiveInteger(value.pageCount, maxPages);
  const normalized = parseArtifact(value.normalized, "application/pdf");
  if (!Array.isArray(value.pages) || value.pages.length !== pageCount) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  const pages = value.pages.map((candidate, index) => {
    if (!isRecord(candidate) || candidate.pageNumber !== index + 1) {
      throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
    }
    const preview = parseArtifact(
      candidate.preview,
      "image/webp"
    ) as ProcessorPageManifest["preview"];
    if (preview.path !== `previews/page-${index + 1}.webp`) {
      throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
    }
    return {
      pageNumber: index + 1,
      widthPixels: positiveInteger(candidate.widthPixels, 20_000),
      heightPixels: positiveInteger(candidate.heightPixels, 20_000),
      preview
    };
  });
  if (!isRecord(value.malware)) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  const engineVersion = safeMetadata(value.malware.engineVersion);
  const definitionsVersion = safeMetadata(value.malware.definitionsVersion);
  const scannedAt = safeTimestamp(value.malware.scannedAt);

  return {
    protocolVersion: 1,
    kind: value.kind,
    pageCount,
    normalized: normalized as ProcessorManifest["normalized"],
    pages,
    malware: { engineVersion, definitionsVersion, scannedAt }
  };
}

function parseArtifact(value: unknown, mime: "application/pdf" | "image/webp") {
  if (!isRecord(value) || value.mime !== mime) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  const path = value.path;
  const sha256 = value.sha256;
  if (typeof path !== "string" || typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  return {
    path,
    mime,
    sizeBytes: positiveInteger(value.sizeBytes, 2_147_000_000),
    sha256
  };
}

function assertArtifactMatches(
  manifest: ProcessorArtifactManifest,
  artifact: ProcessorArtifact | undefined
): void {
  if (
    !artifact ||
    manifest.path !== artifact.archivePath ||
    manifest.sizeBytes !== artifact.sizeBytes ||
    manifest.sha256 !== artifact.sha256
  ) {
    throw new ProcessorRequestError("PROCESSOR_ARTIFACT_INTEGRITY_FAILED", true);
  }
}

async function assertArtifactSignature(
  artifact: ProcessorArtifact,
  mime: "application/pdf" | "image/webp"
): Promise<void> {
  const handle = await open(artifact.temporaryPath, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const valid =
      mime === "application/pdf"
        ? bytesRead >= 5 && bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))
        : bytesRead >= 12 &&
          bytes.subarray(0, 4).equals(Buffer.from("RIFF", "ascii")) &&
          bytes.subarray(8, 12).equals(Buffer.from("WEBP", "ascii"));
    if (!valid) throw new ProcessorRequestError("PROCESSOR_ARTIFACT_INVALID", true);
  } finally {
    await handle.close();
  }
}

async function parseProcessorError(
  response: IncomingMessage,
  signal: AbortSignal
): Promise<ProcessorRequestError> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of response) {
      signal.throwIfAborted();
      const chunk = value as Buffer;
      bytes += chunk.byteLength;
      if (bytes > ERROR_BODY_LIMIT_BYTES) {
        return new ProcessorRequestError("PROCESSOR_RESPONSE_INVALID", true);
      }
      chunks.push(chunk);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      isRecord(parsed) &&
      isRecord(parsed.error) &&
      typeof parsed.error.code === "string" &&
      /^[A-Z0-9_]{3,80}$/u.test(parsed.error.code) &&
      typeof parsed.error.retryable === "boolean"
    ) {
      return new ProcessorRequestError(parsed.error.code, parsed.error.retryable);
    }
  } catch {
    // The processor boundary is untrusted; malformed errors become a generic
    // transient failure and never leak its body or parser diagnostics.
  }
  return new ProcessorRequestError(
    response.statusCode && response.statusCode >= 400 && response.statusCode < 500
      ? "DOCUMENT_REJECTED"
      : "PROCESSOR_UNAVAILABLE",
    !(response.statusCode && response.statusCode >= 400 && response.statusCode < 500)
  );
}

function assertInput(input: ProcessDocumentInput): void {
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
    throw new ProcessorRequestError("OBJECT_LENGTH_INVALID", true);
  }
  if (!SHA256_PATTERN.test(input.contentSha256) || !isKind(input.kind)) {
    throw new ProcessorRequestError("PROCESSOR_REQUEST_INVALID", false);
  }
}

function parseBoundedLength(value: string | undefined, maximum: number): number {
  if (!value || !/^[1-9]\d{0,9}$/u.test(value)) {
    throw new ProcessorRequestError("PROCESSOR_RESPONSE_LENGTH_REQUIRED", true);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximum) {
    throw new ProcessorRequestError("PROCESSOR_RESPONSE_TOO_LARGE", true);
  }
  return length;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  return value as number;
}

function safeMetadata(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:+-]{1,80}$/u.test(value)) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  return value;
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ProcessorRequestError("PROCESSOR_MANIFEST_INVALID", true);
  }
  return value;
}

function isKind(value: unknown): value is ProcessorDocumentKind {
  return value === "PDF" || value === "JPEG" || value === "PNG";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("PROCESSOR_ARCHIVE_INVALID");
}
