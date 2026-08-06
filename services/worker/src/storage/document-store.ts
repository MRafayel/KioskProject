import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
  type DeleteMarkerEntry,
  type ObjectVersion
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

import { SESSION_OBJECT_ROOTS } from "@printing-kiosk/domain";

const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_VERSION_DELETE_PASSES = 3;
const MAX_VERSION_DELETE_BATCH_SIZE = 1_000;
/** Keep orphan discovery bounded while rotating through a large root. */
const MAX_ORPHAN_LIST_PAGES_PER_PASS = 10;
const QUARANTINE_PREFIX = "quarantine/v1/";
const DERIVATIVE_PREFIXES = ["normalized/v1/", "previews/v1/"] as const;
/** Every root retention may delete from. Processing writes stay narrower. */
const RETENTION_PREFIXES = SESSION_OBJECT_ROOTS;
/** Bounds one purge so a pathological prefix cannot hold a worker forever. */
const MAX_PURGE_PASSES = 20;

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

export interface StoredObjectSummary {
  key: string;
  lastModified: Date;
}

/**
 * One bounded orphan-discovery result. The cursor advances only after the
 * reconciler has successfully classified and, where necessary, deleted every
 * returned object. Dropping the acknowledgment retries the same range.
 */
export interface StoredObjectListing {
  objects: StoredObjectSummary[];
  acknowledge: () => void;
}

/**
 * The deletion surface retention needs, kept separate from the processing
 * surface so a cleanup runner can be tested against a fake and so the wider
 * delete scope is visible in one place.
 */
export interface RetentionStore {
  /** Delete named objects. A key that is already gone counts as deleted. */
  deleteObjects(keys: readonly string[], signal?: AbortSignal): Promise<number>;
  /** Delete everything under a prefix and prove nothing is left. */
  purgePrefix(prefix: string, signal?: AbortSignal): Promise<number>;
  /**
   * Abort unfinished multipart uploads under any of the given prefixes so their
   * parts stop existing. With a cutoff, only uploads started before it are
   * touched.
   */
  abortMultipartUploads(
    prefixes: readonly string[],
    startedBefore?: Date,
    signal?: AbortSignal
  ): Promise<number>;
  /** Up to `limit` objects under a prefix last written before a cutoff. */
  listObjectsOlderThan(
    prefix: string,
    cutoff: Date,
    limit: number,
    signal?: AbortSignal
  ): Promise<StoredObjectListing>;
}

export class S3DocumentStore implements DocumentStore {
  private readonly client: S3Client;
  private readonly operationTimeoutMilliseconds: number;
  /** Opaque S3 cursors let successive reconciliation passes resume the scan. */
  private readonly orphanListingCursors = new Map<string, string>();

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
   * Delete named objects, in batches, on behalf of a session's cleanup run.
   *
   * A key that is already gone is a success. Deletion is repeated until every
   * copy is unreachable, so a run that dies half way through and repeats does
   * the same thing the second time as the first.
   */
  public async deleteObjects(keys: readonly string[], signal?: AbortSignal): Promise<number> {
    const unique = [...new Set(keys)];
    for (const key of unique) assertObjectKey(key, RETENTION_PREFIXES);
    if (unique.length === 0) return 0;

    for (let index = 0; index < unique.length; index += MAX_VERSION_DELETE_BATCH_SIZE) {
      const batch = unique.slice(index, index + MAX_VERSION_DELETE_BATCH_SIZE);
      await this.deleteBatch(
        batch.map((key) => ({ key })),
        signal
      );
    }
    // Delete markers and non-current versions are copies too. Removing the
    // current object is not deletion on a bucket that keeps history.
    for (const key of unique) {
      await this.purgeVersions(key, signal);
    }
    return unique.length;
  }

  /**
   * Delete everything under a prefix and verify that nothing remains.
   *
   * This is the step that catches what the artifact ledger did not know about:
   * a partial upload whose row was never written, an artifact stored by a
   * worker whose claim had already been revoked. The prefix is derived from the
   * session identifier alone, so a forgotten key is still found by position.
   */
  public async purgePrefix(prefix: string, signal?: AbortSignal): Promise<number> {
    assertPrefix(prefix);

    let deleted = 0;
    for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
      signal?.throwIfAborted();
      const batch = await this.listPrefixPage(prefix, MAX_VERSION_DELETE_BATCH_SIZE, signal);
      const versions = await this.listPrefixVersionPage(
        prefix,
        MAX_VERSION_DELETE_BATCH_SIZE,
        signal
      );
      if (batch.length === 0 && versions.length === 0) return deleted;

      if (batch.length > 0) {
        await this.deleteBatch(
          batch.map((object) => ({ key: object.key })),
          signal
        );
        deleted += batch.length;
      }
      if (versions.length > 0) {
        await this.deleteBatch(versions, signal);
      }
    }

    // Something is being recreated as fast as it is deleted, or the store is
    // refusing without erroring. Either way the run must not claim success.
    throw codedError("OBJECT_PREFIX_PURGE_EXHAUSTED");
  }

  /**
   * Abort every unfinished multipart upload under the given prefixes.
   *
   * Parts of an interrupted upload are stored bytes that no object listing
   * shows and no ledger row names. Without this they would survive cleanup and
   * wait for a lifecycle rule that is only ever a backstop.
   *
   * The listing is deliberately unfiltered and matched here rather than by the
   * store. `ListMultipartUploads` prefix filtering is not portable — MinIO
   * returns nothing for a prefix that plainly has uploads under it — and a
   * sweep that silently finds none of them is worse than one extra pass. The
   * cost is bounded: only uploads currently in flight are ever listed, and all
   * the prefixes of one session are matched in a single scan.
   */
  public async abortMultipartUploads(
    prefixes: readonly string[],
    startedBefore?: Date,
    signal?: AbortSignal
  ): Promise<number> {
    for (const prefix of prefixes) assertPrefix(prefix);
    if (prefixes.length === 0) return 0;

    let aborted = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    const seenCursors = new Set<string>();

    while (true) {
      signal?.throwIfAborted();
      const response = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.options.bucket,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {})
        }),
        { abortSignal: this.withDeadline(signal) }
      );

      for (const upload of response.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue;
        if (!prefixes.some((prefix) => upload.Key?.startsWith(prefix))) continue;
        // An upload younger than the cutoff may still be in progress. Aborting
        // one mid-flight turns a customer's upload into a failure for no gain.
        if (startedBefore && !(upload.Initiated && upload.Initiated < startedBefore)) continue;
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.options.bucket,
            Key: upload.Key,
            UploadId: upload.UploadId
          }),
          { abortSignal: this.withDeadline(signal) }
        );
        aborted += 1;
      }

      if (!response.IsTruncated) return aborted;
      const nextCursor = `${response.NextKeyMarker ?? ""}\0${response.NextUploadIdMarker ?? ""}`;
      if (!response.NextKeyMarker || seenCursors.has(nextCursor)) {
        throw codedError("MULTIPART_LIST_PAGINATION_INVALID");
      }
      seenCursors.add(nextCursor);
      keyMarker = response.NextKeyMarker;
      uploadIdMarker = response.NextUploadIdMarker;
    }
  }

  /**
   * Objects under a prefix untouched since a cutoff. The reconciler asks for
   * these to find bytes no session record accounts for; the age test is what
   * keeps it from taking an object out from under a live upload.
   */
  public async listObjectsOlderThan(
    prefix: string,
    cutoff: Date,
    limit: number,
    signal?: AbortSignal
  ): Promise<StoredObjectListing> {
    assertPrefix(prefix);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_VERSION_DELETE_BATCH_SIZE) {
      throw codedError("OBJECT_LIST_LIMIT_INVALID");
    }

    // S3 orders this listing by key, not by LastModified. Filtering only the
    // first page can therefore leave an old object behind a stable page of
    // newer/live keys forever. Rotate an opaque continuation cursor across
    // calls, but cap the pages one reconciliation may spend here: discovery
    // must make progress without turning a large live bucket into an unbounded
    // worker pass. `limit` remains the deletion budget.
    const stale: StoredObjectSummary[] = [];
    const seenCursors = new Set<string>();
    const operationSignal = this.withDeadline(signal);
    let continuationToken = this.orphanListingCursors.get(prefix);
    if (continuationToken) seenCursors.add(continuationToken);
    let acknowledgedCursor: string | undefined;

    const result = (): StoredObjectListing => ({
      objects: stale,
      acknowledge: () => {
        if (acknowledgedCursor) this.orphanListingCursors.set(prefix, acknowledgedCursor);
        else this.orphanListingCursors.delete(prefix);
      }
    });

    try {
      for (let page = 0; page < MAX_ORPHAN_LIST_PAGES_PER_PASS; page += 1) {
        operationSignal.throwIfAborted();
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.options.bucket,
            Prefix: prefix,
            // A page cannot overflow the caller's deletion budget. Without
            // this, slicing the last page while advancing past all of it would
            // hide the discarded stale keys until a complete bucket wrap.
            MaxKeys: Math.max(1, limit - stale.length),
            ...(continuationToken ? { ContinuationToken: continuationToken } : {})
          }),
          { abortSignal: operationSignal }
        );

        for (const entry of response.Contents ?? []) {
          if (!entry.Key || !entry.Key.startsWith(prefix)) continue;
          const object = { key: entry.Key, lastModified: entry.LastModified ?? new Date(0) };
          if (object.lastModified.getTime() < cutoff.getTime()) stale.push(object);
        }

        if (!response.IsTruncated) {
          acknowledgedCursor = undefined;
          return result();
        }
        const nextCursor = response.NextContinuationToken;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw codedError("OBJECT_LIST_PAGINATION_INVALID");
        }
        seenCursors.add(nextCursor);
        acknowledgedCursor = nextCursor;
        continuationToken = nextCursor;
        if (stale.length >= limit) return result();
      }

      return result();
    } catch (error) {
      // An opaque token may become invalid after the bucket changes. Reset it
      // so the next scheduled pass can recover from the root rather than
      // repeating the same bad cursor forever.
      this.orphanListingCursors.delete(prefix);
      throw error;
    }
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

  private async deleteBatch(
    entries: readonly { key: string; versionId?: string }[],
    signal?: AbortSignal
  ): Promise<void> {
    const operationSignal = this.withDeadline(signal);
    operationSignal.throwIfAborted();
    const response = await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.options.bucket,
        Delete: {
          Objects: entries.map((entry) => ({
            Key: entry.key,
            ...(entry.versionId ? { VersionId: entry.versionId } : {})
          })),
          Quiet: true
        }
      }),
      { abortSignal: operationSignal }
    );
    if (response.Errors && response.Errors.length > 0) {
      throw codedError("OBJECT_BATCH_DELETE_FAILED");
    }
  }

  private async purgeVersions(key: string, signal?: AbortSignal): Promise<void> {
    for (let pass = 0; pass <= MAX_VERSION_DELETE_PASSES; pass += 1) {
      signal?.throwIfAborted();
      const versions = await listExactObjectVersions(
        this.client,
        this.options.bucket,
        key,
        this.withDeadline(signal)
      );
      if (versions.length === 0) return;
      if (pass === MAX_VERSION_DELETE_PASSES) {
        throw codedError("OBJECT_VERSION_DELETE_RECONCILIATION_EXHAUSTED");
      }
      for (let index = 0; index < versions.length; index += MAX_VERSION_DELETE_BATCH_SIZE) {
        await this.deleteBatch(
          versions
            .slice(index, index + MAX_VERSION_DELETE_BATCH_SIZE)
            .map((versionId) => ({ key, versionId })),
          signal
        );
      }
    }
  }

  private async listPrefixPage(
    prefix: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<StoredObjectSummary[]> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: prefix,
        MaxKeys: limit
      }),
      { abortSignal: this.withDeadline(signal) }
    );
    const objects: StoredObjectSummary[] = [];
    for (const entry of response.Contents ?? []) {
      // A response is only ever trusted to the extent it stays inside the
      // prefix that was asked for.
      if (!entry.Key || !entry.Key.startsWith(prefix)) continue;
      objects.push({ key: entry.Key, lastModified: entry.LastModified ?? new Date(0) });
    }
    return objects;
  }

  private async listPrefixVersionPage(
    prefix: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<{ key: string; versionId: string }[]> {
    const response = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.options.bucket,
        Prefix: prefix,
        MaxKeys: limit
      }),
      { abortSignal: this.withDeadline(signal) }
    );
    const entries: { key: string; versionId: string }[] = [];
    for (const entry of [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]) {
      if (!entry.Key || !entry.Key.startsWith(prefix)) continue;
      if (!entry.VersionId) throw codedError("OBJECT_VERSION_ID_INVALID");
      entries.push({ key: entry.Key, versionId: entry.VersionId });
    }
    return entries;
  }
}

/**
 * A prefix is handed straight to a bulk delete, so it is checked rather than
 * trusted: it must name one of the roots this system writes, and it must not
 * contain a traversal segment that could reach outside it.
 */
function assertPrefix(prefix: string): void {
  if (
    prefix.length < 1 ||
    prefix.length > 512 ||
    prefix.startsWith("/") ||
    prefix.includes("\\") ||
    prefix.split("/").includes("..") ||
    !SESSION_OBJECT_ROOTS.some((root) => prefix.startsWith(root))
  ) {
    throw codedError("OBJECT_PREFIX_OUT_OF_SCOPE");
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
