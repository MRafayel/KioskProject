import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { PassThrough, Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface UploadProbe {
  abortCalls: number;
  options: {
    params?: Record<string, unknown>;
    leavePartsOnError?: boolean;
    partSize?: number;
    queueSize?: number;
  };
  resolveDone: (value: { ETag?: string }) => void;
  rejectDone: (error: Error) => void;
}

const uploadState = vi.hoisted(() => ({ instances: [] as UploadProbe[] }));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class MockUpload {
    public abortCalls = 0;
    public readonly options: UploadProbe["options"];
    public readonly resolveDone: UploadProbe["resolveDone"];
    public readonly rejectDone: UploadProbe["rejectDone"];
    private readonly completion: Promise<{ ETag?: string }>;

    public constructor(options: UploadProbe["options"]) {
      this.options = options;
      let resolveDone!: UploadProbe["resolveDone"];
      let rejectDone!: UploadProbe["rejectDone"];
      this.completion = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      this.resolveDone = resolveDone;
      this.rejectDone = rejectDone;
      uploadState.instances.push(this);
    }

    public done(): Promise<{ ETag?: string }> {
      return this.completion;
    }

    public abort(): Promise<void> {
      this.abortCalls += 1;
      this.rejectDone(new Error("synthetic multipart upload aborted"));
      return Promise.resolve();
    }
  }
}));

import { S3ObjectStore } from "./object-store.js";

beforeEach(() => {
  uploadState.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S3ObjectStore upload safety", () => {
  it("fails before constructing an upload when its signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("upload deadline elapsed");
    controller.abort(reason);
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: {} as S3Client
    });

    await expect(
      store.putObject({
        key: "quarantine/v1/session/file/object",
        body: Readable.from([Buffer.from("private")]),
        contentType: "application/octet-stream",
        signal: controller.signal
      })
    ).rejects.toBe(reason);

    expect(uploadState.instances).toHaveLength(0);
  });

  it("destroys the upload body and aborts multipart work when the signal fires", async () => {
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: {} as S3Client
    });
    const body = new PassThrough();
    const bodyErrors: Error[] = [];
    body.on("error", (error: Error) => bodyErrors.push(error));
    const controller = new AbortController();
    const upload = store.putObject({
      key: "quarantine/v1/session/file/object",
      body,
      contentType: "application/octet-stream",
      signal: controller.signal
    });
    const reason = new Error("phone disconnected");

    controller.abort(reason);

    await expect(upload).rejects.toThrow("synthetic multipart upload aborted");
    await vi.waitFor(() => expect(bodyErrors).toEqual([reason]));
    expect(body.destroyed).toBe(true);
    expect(uploadState.instances).toHaveLength(1);
    expect(uploadState.instances[0]?.abortCalls).toBe(1);
  });

  it("requests bounded multipart cleanup and configured server-side encryption", async () => {
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: {} as S3Client,
      serverSideEncryption: "aws:kms",
      kmsKeyId: "test-kms-key"
    });
    const result = store.putObject({
      key: "quarantine/v1/session/file/object",
      body: Readable.from([Buffer.from("private")]),
      contentType: "application/octet-stream"
    });
    const probe = uploadState.instances[0];
    if (!probe) throw new Error("EXPECTED_UPLOAD_PROBE");

    probe.resolveDone({ ETag: "synthetic-etag" });

    await expect(result).resolves.toEqual({ etag: "synthetic-etag" });
    expect(probe.options).toMatchObject({
      leavePartsOnError: false,
      queueSize: 2,
      params: {
        Bucket: "private-test-bucket",
        Key: "quarantine/v1/session/file/object",
        ContentType: "application/octet-stream",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: "test-kms-key"
      }
    });
    expect(probe.options.partSize).toBe(5 * 1024 * 1024);
  });
});

describe("S3ObjectStore deletion deadlines", () => {
  it("forwards external cancellation to the delete request", async () => {
    const transport = blockingS3Client();
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: transport.client
    });
    const controller = new AbortController();
    const deletion = store.deleteObject({
      key: "quarantine/v1/session/file/object",
      signal: controller.signal
    });
    const reason = new Error("cleanup canceled");

    controller.abort(reason);

    await expect(deletion).rejects.toBe(reason);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.command).toBeInstanceOf(DeleteObjectCommand);
    expect((transport.calls[0]?.command as DeleteObjectCommand).input).toEqual({
      Bucket: "private-test-bucket",
      Key: "quarantine/v1/session/file/object"
    });
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it("aborts deletion when the internal object-operation deadline fires", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const transport = blockingS3Client();
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: transport.client
    });
    const deletion = store.deleteObject({ key: "quarantine/v1/session/file/object" });
    const reason = new Error("synthetic object timeout");
    reason.name = "TimeoutError";

    deadline.abort(reason);

    await expect(deletion).rejects.toBe(reason);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(transport.calls[0]?.signal).toBe(deadline.signal);
  });
});

describe("S3ObjectStore version-aware deletion", () => {
  const key = "quarantine/v1/session/file/object";

  it("preserves unversioned behavior while verifying that no retained versions exist", async () => {
    const transport = scriptedDeletionClient([{}]);
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: transport.client
    });

    await expect(store.deleteObject({ key })).resolves.toBeUndefined();

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(transport.calls[1]).toBeInstanceOf(ListObjectVersionsCommand);
    expect((transport.calls[1] as ListObjectVersionsCommand).input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: key
    });
  });

  it("removes every exact-key version and delete marker across paginated listings", async () => {
    const transport = scriptedDeletionClient([
      {
        Versions: [
          { Key: key, VersionId: "version-2" },
          { Key: `${key}-neighbor`, VersionId: "neighbor-version" }
        ],
        IsTruncated: true,
        NextKeyMarker: key,
        NextVersionIdMarker: "version-1"
      },
      {
        Versions: [{ Key: key, VersionId: "version-1" }],
        DeleteMarkers: [{ Key: key, VersionId: "delete-marker-1" }]
      },
      {}
    ]);
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: transport.client
    });

    await expect(store.deleteObject({ key })).resolves.toBeUndefined();

    const listCommands = transport.calls.filter(
      (command): command is ListObjectVersionsCommand =>
        command instanceof ListObjectVersionsCommand
    );
    expect(listCommands).toHaveLength(3);
    expect(listCommands[1]?.input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: key,
      KeyMarker: key,
      VersionIdMarker: "version-1"
    });
    expect(listCommands[2]?.input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: key
    });

    const batchDelete = transport.calls.find(
      (command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand
    );
    expect(batchDelete?.input).toEqual({
      Bucket: "private-test-bucket",
      Delete: {
        Objects: [
          { Key: key, VersionId: "version-2" },
          { Key: key, VersionId: "version-1" },
          { Key: key, VersionId: "delete-marker-1" }
        ],
        Quiet: true
      }
    });
  });

  it("fails closed when object storage reports that any version deletion failed", async () => {
    const transport = scriptedDeletionClient(
      [[{ Key: key, VersionId: "version-1" }], {}],
      [{ Errors: [{ Code: "AccessDenied", Key: key, VersionId: "version-1" }] }]
    );
    const store = new S3ObjectStore({
      bucket: "private-test-bucket",
      client: transport.client
    });

    await expect(store.deleteObject({ key })).rejects.toThrow("OBJECT_VERSION_DELETE_FAILED");
  });
});

describe("S3ObjectStore authenticated reads", () => {
  it("returns a stream only with bounded authoritative metadata", async () => {
    const body = Readable.from([Buffer.from("RIFF0000WEBP", "ascii")]);
    const calls: unknown[] = [];
    const client = {
      send(command: unknown) {
        calls.push(command);
        return Promise.resolve({
          Body: body,
          ContentLength: 12,
          ContentType: "image/webp",
          ETag: "preview-etag"
        });
      }
    } as unknown as S3Client;
    const store = new S3ObjectStore({ bucket: "private-test-bucket", client });

    await expect(store.getObject({ key: "previews/v1/session/file/page-1.webp" })).resolves.toEqual(
      {
        body,
        contentLength: 12,
        contentType: "image/webp",
        etag: "preview-etag"
      }
    );
    expect(calls[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("fails closed when object storage omits content length", async () => {
    const client = {
      send() {
        return Promise.resolve({
          Body: Readable.from([Buffer.from("private")]),
          ContentType: "image/webp"
        });
      }
    } as unknown as S3Client;
    const store = new S3ObjectStore({ bucket: "private-test-bucket", client });

    await expect(store.getObject({ key: "previews/v1/session/file/page-1.webp" })).rejects.toThrow(
      "OBJECT_LENGTH_INVALID"
    );
  });
});

function blockingS3Client(): {
  client: S3Client;
  calls: Array<{ command: unknown; signal: AbortSignal }>;
} {
  const calls: Array<{ command: unknown; signal: AbortSignal }> = [];
  const client = {
    send(command: unknown, options: { abortSignal: AbortSignal }) {
      const signal = options.abortSignal;
      calls.push({ command, signal });
      return new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
          return;
        }
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Operation aborted.")
            ),
          { once: true }
        );
      });
    }
  };

  return { client: client as unknown as S3Client, calls };
}

interface VersionListing {
  Versions?: Array<{ Key?: string; VersionId?: string }>;
  DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextVersionIdMarker?: string;
}

function scriptedDeletionClient(
  listings: Array<VersionListing | Array<{ Key?: string; VersionId?: string }>>,
  deleteResponses: Array<{ Errors?: unknown[] }> = []
): { client: S3Client; calls: unknown[] } {
  const calls: unknown[] = [];
  const pendingListings = listings.map((listing) =>
    Array.isArray(listing) ? { Versions: listing } : listing
  );
  const pendingDeleteResponses = [...deleteResponses];
  const client = {
    send(command: unknown) {
      calls.push(command);
      if (command instanceof DeleteObjectCommand) return Promise.resolve({});
      if (command instanceof ListObjectVersionsCommand) {
        const response = pendingListings.shift();
        if (!response) return Promise.reject(new Error("UNEXPECTED_VERSION_LIST"));
        return Promise.resolve(response);
      }
      if (command instanceof DeleteObjectsCommand) {
        return Promise.resolve(pendingDeleteResponses.shift() ?? {});
      }
      return Promise.reject(new Error("UNEXPECTED_S3_COMMAND"));
    }
  };

  return { client: client as unknown as S3Client, calls };
}
