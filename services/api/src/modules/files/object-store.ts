import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  S3Client,
  type DeleteMarkerEntry,
  type ObjectVersion
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

import type { Environment } from "@printing-kiosk/config";

const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const OBJECT_OPERATION_TIMEOUT_MS = 10_000;
const MAX_VERSION_DELETE_PASSES = 3;
const MAX_VERSION_DELETE_BATCH_SIZE = 1_000;

export interface PutObjectInput {
  key: string;
  body: Readable;
  contentType: string;
  signal?: AbortSignal;
}

export interface PutObjectResult {
  etag?: string;
}

export interface DeleteObjectInput {
  key: string;
  signal?: AbortSignal;
}

export interface GetObjectInput {
  key: string;
  signal?: AbortSignal;
}

export interface GetObjectResult {
  body: Readable;
  contentLength: number;
  contentType?: string;
  etag?: string;
}

export interface ObjectStore {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  deleteObject(input: DeleteObjectInput): Promise<void>;
  checkReady(signal?: AbortSignal): Promise<void>;
}

export interface S3ObjectStoreOptions {
  bucket: string;
  client: S3Client;
  serverSideEncryption?: "AES256" | "aws:kms";
  kmsKeyId?: string;
}

export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly serverSideEncryption: "AES256" | "aws:kms" | undefined;
  private readonly kmsKeyId: string | undefined;

  public constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.client = options.client;
    this.serverSideEncryption = options.serverSideEncryption;
    this.kmsKeyId = options.kmsKeyId;
  }

  public async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    input.signal?.throwIfAborted();

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ...(this.serverSideEncryption
          ? {
              ServerSideEncryption: this.serverSideEncryption,
              ...(this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {})
            }
          : {})
      },
      queueSize: 2,
      partSize: MULTIPART_PART_SIZE_BYTES,
      leavePartsOnError: false
    });

    const onAbort = () => {
      input.body.destroy(asError(input.signal?.reason, "Object upload aborted."));
      void upload.abort().catch(() => undefined);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await upload.done();
      return result.ETag ? { etag: result.ETag } : {};
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  public async deleteObject(input: DeleteObjectInput): Promise<void> {
    const signal = withDeadline(input.signal);
    signal.throwIfAborted();

    // Delete the current object first. This removes an unversioned object and,
    // for a versioned bucket, creates a delete marker that is removed below.
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: input.key
      }),
      { abortSignal: signal }
    );

    let deletePasses = 0;
    while (true) {
      signal.throwIfAborted();
      const versions = await listExactObjectVersions(this.client, this.bucket, input.key, signal);
      if (versions.length === 0) return;
      if (deletePasses >= MAX_VERSION_DELETE_PASSES) {
        throw new Error("OBJECT_VERSION_DELETE_RECONCILIATION_EXHAUSTED");
      }

      for (let index = 0; index < versions.length; index += MAX_VERSION_DELETE_BATCH_SIZE) {
        signal.throwIfAborted();
        const batch = versions.slice(index, index + MAX_VERSION_DELETE_BATCH_SIZE);
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: batch.map((versionId) => ({
                Key: input.key,
                VersionId: versionId
              })),
              Quiet: true
            }
          }),
          { abortSignal: signal }
        );
        if (response.Errors && response.Errors.length > 0) {
          throw new Error("OBJECT_VERSION_DELETE_FAILED");
        }
      }
      deletePasses += 1;
    }
  }

  public async getObject(input: GetObjectInput): Promise<GetObjectResult> {
    const signal = withDeadline(input.signal);
    signal.throwIfAborted();
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key
      }),
      { abortSignal: signal }
    );
    if (!response.Body || typeof response.Body !== "object" || !("pipe" in response.Body)) {
      throw new Error("OBJECT_BODY_UNAVAILABLE");
    }
    if (
      response.ContentLength === undefined ||
      !Number.isSafeInteger(response.ContentLength) ||
      response.ContentLength < 0
    ) {
      throw new Error("OBJECT_LENGTH_INVALID");
    }

    return {
      body: response.Body,
      contentLength: response.ContentLength,
      ...(response.ContentType ? { contentType: response.ContentType } : {}),
      ...(response.ETag ? { etag: response.ETag } : {})
    };
  }

  public async checkReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.bucket }),
      signal ? { abortSignal: signal } : undefined
    );
  }
}

type S3Environment = Pick<
  Environment,
  | "S3_ENDPOINT"
  | "S3_REGION"
  | "S3_BUCKET"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "S3_FORCE_PATH_STYLE"
  | "S3_SERVER_SIDE_ENCRYPTION"
  | "S3_KMS_KEY_ID"
>;

export function createS3ObjectStore(environment: S3Environment): S3ObjectStore {
  const client = new S3Client({
    endpoint: environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: environment.S3_ACCESS_KEY_ID,
      secretAccessKey: environment.S3_SECRET_ACCESS_KEY
    }
  });

  return new S3ObjectStore({
    bucket: environment.S3_BUCKET,
    client,
    ...(environment.S3_SERVER_SIDE_ENCRYPTION
      ? { serverSideEncryption: environment.S3_SERVER_SIDE_ENCRYPTION }
      : {}),
    ...(environment.S3_KMS_KEY_ID ? { kmsKeyId: environment.S3_KMS_KEY_ID } : {})
  });
}

function withDeadline(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(OBJECT_OPERATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
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
      throw new Error("OBJECT_VERSION_LIST_PAGINATION_INVALID");
    }
    const nextCursor = `${response.NextKeyMarker}\0${response.NextVersionIdMarker ?? ""}`;
    if (seenCursors.has(nextCursor)) {
      throw new Error("OBJECT_VERSION_LIST_PAGINATION_INVALID");
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
      throw new Error("OBJECT_VERSION_ID_INVALID");
    }
    versionIds.add(entry.VersionId);
  }
}
