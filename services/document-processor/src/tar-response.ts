import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { pack } from "tar-stream";

import { ProcessorError, safeProcessorError } from "./errors.js";
import { hashFile } from "./hash-file.js";
import { OutputLimitTransform } from "./streams.js";
import type { ProcessedDocument, TarArtifact } from "./types.js";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const SAFE_ARCHIVE_PATH =
  /^(?:manifest\.json|normalized\/document\.pdf|previews\/page-[1-9]\d{0,3}\.webp)$/u;

export async function sendProcessedDocumentTar(input: {
  response: ServerResponse;
  document: ProcessedDocument;
  maximumBytes: number;
  scratchDirectory: string;
  signal?: AbortSignal;
}): Promise<void> {
  const manifest = Buffer.from(`${JSON.stringify(input.document.manifest)}\n`, "utf8");
  const artifacts = await verifyArtifacts(input.document.artifacts);
  const expectedMaximum = estimateTarBytes([
    { sizeBytes: manifest.byteLength },
    ...artifacts.map(({ sizeBytes }) => ({ sizeBytes }))
  ]);
  if (expectedMaximum > input.maximumBytes) {
    throw new ProcessorError("OUTPUT_SIZE_LIMIT_EXCEEDED", 422);
  }
  await mkdir(input.scratchDirectory, { recursive: true, mode: 0o700 });
  const responseDirectory = await mkdtemp(join(input.scratchDirectory, "response-"));
  const responsePath = join(responseDirectory, "document.tar");
  const archive = pack();
  try {
    const limiter = new OutputLimitTransform(input.maximumBytes);
    const built = input.signal
      ? pipeline(archive, limiter, createWriteStream(responsePath, { flags: "wx", mode: 0o600 }), {
          signal: input.signal
        })
      : pipeline(archive, limiter, createWriteStream(responsePath, { flags: "wx", mode: 0o600 }));
    void built.catch(() => undefined);
    await addBuffer(archive, "manifest.json", manifest);
    for (const artifact of artifacts) {
      input.signal?.throwIfAborted();
      await addFile(archive, artifact);
    }
    archive.finalize();
    await built;

    const tar = await stat(responsePath);
    if (!tar.isFile() || tar.size < 1 || tar.size > input.maximumBytes) {
      throw new ProcessorError("OUTPUT_SIZE_LIMIT_EXCEEDED", 422);
    }
    const sha256 = await hashFile(responsePath);
    input.response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(tar.size),
      "content-type": "application/x-tar",
      "x-content-sha256": sha256,
      "x-content-type-options": "nosniff",
      "x-processor-protocol-version": "1"
    });
    await (input.signal
      ? pipeline(createReadStream(responsePath), input.response, { signal: input.signal })
      : pipeline(createReadStream(responsePath), input.response));
  } catch (error) {
    archive.destroy();
    if (error instanceof ProcessorError) throw error;
    throw safeProcessorError(error);
  } finally {
    await rm(responseDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyArtifacts(artifacts: TarArtifact[]): Promise<TarArtifact[]> {
  const paths = new Set<string>();
  const verified: TarArtifact[] = [];
  for (const artifact of artifacts) {
    if (!SAFE_ARCHIVE_PATH.test(artifact.archivePath) || paths.has(artifact.archivePath)) {
      throw new ProcessorError("INTERNAL_ERROR", 500, true);
    }
    paths.add(artifact.archivePath);
    const file = await lstat(artifact.filesystemPath);
    if (!file.isFile() || file.isSymbolicLink() || file.size !== artifact.sizeBytes) {
      throw new ProcessorError("INTERNAL_ERROR", 500, true);
    }
    verified.push(artifact);
  }
  if (!paths.has("normalized/document.pdf")) {
    throw new ProcessorError("INTERNAL_ERROR", 500, true);
  }
  return verified;
}

async function addBuffer(
  archive: ReturnType<typeof pack>,
  name: string,
  value: Buffer
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    archive.entry(tarHeader(name, value.byteLength), value, (error: Error | null | undefined) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function addFile(archive: ReturnType<typeof pack>, artifact: TarArtifact): Promise<void> {
  const entry = archive.entry(tarHeader(artifact.archivePath, artifact.sizeBytes));
  await pipeline(createReadStream(artifact.filesystemPath), entry);
}

function tarHeader(name: string, size: number) {
  return {
    name,
    size,
    mode: 0o600,
    uid: 10_001,
    gid: 10_001,
    mtime: new Date(0),
    type: "file" as const
  };
}

function estimateTarBytes(entries: Array<{ sizeBytes: number }>): number {
  return (
    entries.reduce(
      (total, entry) =>
        total + TAR_BLOCK_BYTES + Math.ceil(entry.sizeBytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES,
      0
    ) + TAR_END_BYTES
  );
}
