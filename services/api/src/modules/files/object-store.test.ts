import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
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
