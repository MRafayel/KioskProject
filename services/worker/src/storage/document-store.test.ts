import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client
} from "@aws-sdk/client-s3";

import { describe, expect, it } from "vitest";

import { S3DocumentStore, type DocumentStoreOptions } from "./document-store.js";

const KEY = "previews/v1/session/file/page-1.webp";

describe("S3DocumentStore version-aware deletion", () => {
  it("preserves unversioned deletion behavior and verifies retained versions", async () => {
    const transport = scriptedDeletionClient([{}]);
    const store = new S3DocumentStore(options(), transport.client);

    await expect(store.deleteObject(KEY)).resolves.toBeUndefined();

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(transport.calls[1]).toBeInstanceOf(ListObjectVersionsCommand);
    expect((transport.calls[1] as ListObjectVersionsCommand).input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: KEY
    });
  });

  it("removes exact-key versions and delete markers across paginated listings", async () => {
    const transport = scriptedDeletionClient([
      {
        Versions: [
          { Key: KEY, VersionId: "version-2" },
          { Key: `${KEY}-neighbor`, VersionId: "neighbor-version" }
        ],
        IsTruncated: true,
        NextKeyMarker: KEY,
        NextVersionIdMarker: "version-1"
      },
      {
        Versions: [{ Key: KEY, VersionId: "version-1" }],
        DeleteMarkers: [{ Key: KEY, VersionId: "delete-marker-1" }]
      },
      {}
    ]);
    const store = new S3DocumentStore(options(), transport.client);

    await expect(store.deleteObject(KEY)).resolves.toBeUndefined();

    const listCommands = transport.calls.filter(
      (command): command is ListObjectVersionsCommand =>
        command instanceof ListObjectVersionsCommand
    );
    expect(listCommands).toHaveLength(3);
    expect(listCommands[1]?.input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: KEY,
      KeyMarker: KEY,
      VersionIdMarker: "version-1"
    });
    expect(listCommands[2]?.input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: KEY
    });

    const batchDelete = transport.calls.find(
      (command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand
    );
    expect(batchDelete?.input.Delete?.Objects).toEqual([
      { Key: KEY, VersionId: "version-2" },
      { Key: KEY, VersionId: "version-1" },
      { Key: KEY, VersionId: "delete-marker-1" }
    ]);
  });

  it("fails closed rather than accepting a partially successful version purge", async () => {
    const transport = scriptedDeletionClient(
      [[{ Key: KEY, VersionId: "version-1" }]],
      [{ Errors: [{ Code: "AccessDenied" }] }]
    );
    const store = new S3DocumentStore(options(), transport.client);

    await expect(store.deleteObject(KEY)).rejects.toThrow("OBJECT_VERSION_DELETE_FAILED");
  });

  it("fails closed when a truncated response cannot advance its cursor", async () => {
    const transport = scriptedDeletionClient([{ IsTruncated: true }]);
    const store = new S3DocumentStore(options(), transport.client);

    await expect(store.deleteObject(KEY)).rejects.toThrow("OBJECT_VERSION_LIST_PAGINATION_INVALID");
  });
});

function options(): DocumentStoreOptions {
  return {
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "private-test-bucket",
    accessKeyId: "test-worker",
    secretAccessKey: "test-worker-secret",
    forcePathStyle: true
  };
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
