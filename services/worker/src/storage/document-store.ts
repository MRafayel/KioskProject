import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
  type DeleteMarkerEntry,
  type ObjectVersion
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_VERSION_DELETE_PASSES = 3;
const MAX_VERSION_DELETE_BATCH_SIZE = 1_000;
const QUARANTINE_PREFIX = "quarantine/v1/";
const DERIVATIVE_PREFIXES = ["normalized/v1/", "previews/v1/"] as const;

export interface DocumentStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  serverSideEncryption?: "AES256" | "aws:kms";
  kmsKeyId?: string;
  operationTimeoutMilliseconds?: number;
}

export interface StoredDocument {
  body: Readable;
  contentLength: number;
  contentType?: string;
}

export interface PutArtifactInput {
  key: string;
  body: Readable;
  contentLength: number;
  contentType: "application/pdf" | "image/webp";
  signal?: AbortSignal;
}

export interface DocumentStore {
  getQuarantined(key: string, signal?: AbortSignal): Promise<StoredDocument>;
  putArtifact(input: PutArtifactInput): Promise<void>;
  deleteObject(key: string, signal?: AbortSignal): Promise<void>;
  checkReady(signal?: AbortSignal): Promise<void>;
}

export class S3DocumentStore implements DocumentStore {
  private readonly client: S3Client;
  private readonly operationTimeoutMilliseconds: number;

  public constructor(
    private readonly options: DocumentStoreOptions,
    client?: S3Client
  ) {
    this.operationTimeoutMilliseconds =
      options.operationTimeoutMilliseconds ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.client =
      client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: options.forcePathStyle,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey
        }
      });
  }

  public async getQuarantined(key: string, signal?: AbortSignal): Promise<StoredDocument> {
    assertObjectKey(key, [QUARANTINE_PREFIX]);
    const operationSignal = this.withDeadline(signal);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { abortSignal: operationSignal }
    );
    if (!result.Body || typeof result.Body !== "object" || !("pipe" in result.Body)) {
      throw codedError("OBJECT_BODY_UNAVAILABLE");
    }
    if (
      result.ContentLength === undefined ||
      !Number.isSafeInteger(result.ContentLength) ||
      result.ContentLength < 1
    ) {
      throw codedError("OBJECT_LENGTH_INVALID");
    }
    return {
      body: result.Body,
      contentLength: result.ContentLength,
      ...(result.ContentType ? { contentType: result.ContentType } : {})
    };
  }

  public async putArtifact(input: PutArtifactInput): Promise<void> {
    assertObjectKey(input.key, DERIVATIVE_PREFIXES);
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
      throw codedError("ARTIFACT_LENGTH_INVALID");
    }
    const operationSignal = this.withDeadline(input.signal);
    operationSignal.throwIfAborted();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.options.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        ...(this.options.serverSideEncryption
          ? {
              ServerSideEncryption: this.options.serverSideEncryption,
              ...(this.options.kmsKeyId ? { SSEKMSKeyId: this.options.kmsKeyId } : {})
            }
          : {})
      },
      queueSize: 1,
      partSize: MULTIPART_PART_SIZE_BYTES,
      leavePartsOnError: false
    });
    const abort = () => {
      input.body.destroy(asError(operationSignal.reason, "Artifact upload aborted."));
      void upload.abort().catch(() => undefined);
    };
    operationSignal.addEventListener("abort", abort, { once: true });
    try {
      await upload.done();
    } finally {
      operationSignal.removeEventListener("abort", abort);
    }
  }

  public async deleteObject(key: string, signal?: AbortSignal): Promise<void> {
    assertObjectKey(key, DERIVATIVE_PREFIXES);
    const operationSignal = this.withDeadline(signal);
    operationSignal.throwIfAborted();

    // Delete the current object first. This removes an unversioned object and,
    // for a versioned bucket, creates a delete marker that is removed below.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }), {
      abortSignal: operationSignal
    });

    let deletePasses = 0;
    while (true) {
      operationSignal.throwIfAborted();
      const versions = await listExactObjectVersions(
        this.client,
        this.options.bucket,
        key,
        operationSignal
      );
      if (versions.length === 0) return;
      if (deletePasses >= MAX_VERSION_DELETE_PASSES) {
        throw codedError("OBJECT_VERSION_DELETE_RECONCILIATION_EXHAUSTED");
      }

      for (let index = 0; index < versions.length; index += MAX_VERSION_DELETE_BATCH_SIZE) {
        operationSignal.throwIfAborted();
        const batch = versions.slice(index, index + MAX_VERSION_DELETE_BATCH_SIZE);
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.options.bucket,
            Delete: {
              Objects: batch.map((versionId) => ({ Key: key, VersionId: versionId })),
              Quiet: true
            }
          }),
          { abortSignal: operationSignal }
        );
        if (response.Errors && response.Errors.length > 0) {
          throw codedError("OBJECT_VERSION_DELETE_FAILED");
        }
      }
      deletePasses += 1;
    }
  }

  public async checkReady(signal?: AbortSignal): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }), {
      abortSignal: this.withDeadline(signal)
    });
  }

  /**
   * Exact-key verifier used by cleanup reconciliation and integration tests.
   * ListBucket is intentionally available to the worker while GetObject remains
   * restricted to quarantined originals.
   */
  public async hasObject(key: string, signal?: AbortSignal): Promise<boolean> {
    assertObjectKey(key, [QUARANTINE_PREFIX, ...DERIVATIVE_PREFIXES]);
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: key,
        MaxKeys: 100
      }),
      { abortSignal: this.withDeadline(signal) }
    );
    return Boolean(result.Contents?.some((candidate) => candidate.Key === key));
  }

  private withDeadline(signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.operationTimeoutMilliseconds);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }
}

function assertObjectKey(key: string, allowedPrefixes: readonly string[]): void {
  if (
    key.length < 1 ||
    key.length > 512 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").includes("..") ||
    !allowedPrefixes.some((prefix) => key.startsWith(prefix))
  ) {
    throw codedError("OBJECT_KEY_OUT_OF_SCOPE");
  }
}

function codedError(code: string): Error {
  return new Error(code);
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}

async function listExactObjectVersions(
  client: S3Client,
  bucket: string,
  key: string,
  signal: AbortSignal
): Promise<string[]> {
  const versionIds = new Set<string>();
  const seenCursors = new Set<string>();
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  while (true) {
    signal.throwIfAborted();
    const response = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {})
      }),
      { abortSignal: signal }
    );

    collectExactVersionIds(response.Versions, key, versionIds);
    collectExactVersionIds(response.DeleteMarkers, key, versionIds);

    if (!response.IsTruncated) return [...versionIds];

    if (!response.NextKeyMarker) {
      throw codedError("OBJECT_VERSION_LIST_PAGINATION_INVALID");
    }
    const nextCursor = `${response.NextKeyMarker}\0${response.NextVersionIdMarker ?? ""}`;
    if (seenCursors.has(nextCursor)) {
      throw codedError("OBJECT_VERSION_LIST_PAGINATION_INVALID");
    }
    seenCursors.add(nextCursor);
    keyMarker = response.NextKeyMarker;
    versionIdMarker = response.NextVersionIdMarker;
  }
}

function collectExactVersionIds(
  entries: Array<ObjectVersion | DeleteMarkerEntry> | undefined,
  key: string,
  versionIds: Set<string>
): void {
  for (const entry of entries ?? []) {
    if (entry.Key !== key) continue;
    if (!entry.VersionId) {
      throw codedError("OBJECT_VERSION_ID_INVALID");
    }
    versionIds.add(entry.VersionId);
  }
}
