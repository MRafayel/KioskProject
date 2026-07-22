import { DeleteObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

import type { Environment } from "@printing-kiosk/config";

const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const OBJECT_OPERATION_TIMEOUT_MS = 10_000;

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

export interface ObjectStore {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
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
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: input.key
      }),
      { abortSignal: signal }
    );
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
