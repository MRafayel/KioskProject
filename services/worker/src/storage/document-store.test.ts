import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
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

describe("S3DocumentStore orphan listing", () => {
  it("finds a stale object beyond a recent first page and stops at the result limit", async () => {
    const recent = new Date("2030-01-01T11:59:00.000Z");
    const old = new Date("2030-01-01T00:00:00.000Z");
    const cutoff = new Date("2030-01-01T10:00:00.000Z");
    const staleKey = "previews/v1/01900000-0000-7000-8000-000000000001/file/page.webp";
    const transport = scriptedObjectListingClient([
      {
        Contents: [
          { Key: "previews/v1/00000000-0000-7000-8000-000000000001/live", LastModified: recent }
        ],
        IsTruncated: true,
        NextContinuationToken: "second-page"
      },
      {
        Contents: [{ Key: staleKey, LastModified: old }],
        IsTruncated: true,
        NextContinuationToken: "third-page"
      },
      {
        Contents: [
          {
            Key: "previews/v1/02900000-0000-7000-8000-000000000001/also-stale",
            LastModified: old
          }
        ]
      }
    ]);
    const store = new S3DocumentStore(options(), transport.client);

    const listing = await store.listObjectsOlderThan("previews/v1/", cutoff, 1);
    expect(listing.objects).toEqual([{ key: staleKey, lastModified: old }]);
    listing.acknowledge();

    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[0] as ListObjectsV2Command).input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: "previews/v1/",
      MaxKeys: 1
    });
    expect((transport.calls[1] as ListObjectsV2Command).input).toEqual({
      Bucket: "private-test-bucket",
      Prefix: "previews/v1/",
      MaxKeys: 1,
      ContinuationToken: "second-page"
    });
  });

  it("fails closed when a truncated object listing cannot advance its cursor", async () => {
    const transport = scriptedObjectListingClient([
      { IsTruncated: true, NextContinuationToken: "same-page" },
      { IsTruncated: true, NextContinuationToken: "same-page" }
    ]);
    const store = new S3DocumentStore(options(), transport.client);

    await expect(
      store.listObjectsOlderThan("quarantine/v1/", new Date("2030-01-01T10:00:00.000Z"), 10)
    ).rejects.toThrow("OBJECT_LIST_PAGINATION_INVALID");
  });

  it("bounds each scan and resumes from its continuation cursor on the next pass", async () => {
    const recent = new Date("2030-01-01T11:59:00.000Z");
    const old = new Date("2030-01-01T00:00:00.000Z");
    const cutoff = new Date("2030-01-01T10:00:00.000Z");
    const listings: ObjectListing[] = Array.from({ length: 10 }, (_, index) => ({
      Contents: [
        {
          Key: `normalized/v1/01900000-0000-7000-8000-${String(index).padStart(12, "0")}/live`,
          LastModified: recent
        }
      ],
      IsTruncated: true,
      NextContinuationToken: `page-${index + 1}`
    }));
    listings.push({
      Contents: [
        {
          Key: "normalized/v1/01900000-0000-7000-8000-000000000099/stale",
          LastModified: old
        }
      ]
    });
    const transport = scriptedObjectListingClient(listings);
    const store = new S3DocumentStore(options(), transport.client);

    const first = await store.listObjectsOlderThan("normalized/v1/", cutoff, 1);
    expect(first.objects).toEqual([]);
    first.acknowledge();
    expect(transport.calls).toHaveLength(10);

    const second = await store.listObjectsOlderThan("normalized/v1/", cutoff, 1);
    expect(second.objects).toEqual([
      {
        key: "normalized/v1/01900000-0000-7000-8000-000000000099/stale",
        lastModified: old
      }
    ]);
    second.acknowledge();
    expect((transport.calls[10] as ListObjectsV2Command).input.ContinuationToken).toBe("page-10");
  });

  it("retries the same cursor until downstream work acknowledges it", async () => {
    const old = new Date("2030-01-01T00:00:00.000Z");
    const cutoff = new Date("2030-01-01T10:00:00.000Z");
    const staleKey = "previews/v1/01900000-0000-7000-8000-000000000001/stale";
    const transport = scriptedObjectListingClient([
      {
        Contents: [{ Key: staleKey, LastModified: old }],
        IsTruncated: true,
        NextContinuationToken: "after-stale"
      },
      {
        Contents: [{ Key: staleKey, LastModified: old }],
        IsTruncated: true,
        NextContinuationToken: "after-stale"
      }
    ]);
    const store = new S3DocumentStore(options(), transport.client);

    const failedAttempt = await store.listObjectsOlderThan("previews/v1/", cutoff, 1);
    expect(failedAttempt.objects).toHaveLength(1);
    // Simulate a downstream delete failure by deliberately not acknowledging.
    const retry = await store.listObjectsOlderThan("previews/v1/", cutoff, 1);
    expect(retry.objects).toEqual(failedAttempt.objects);
    expect((transport.calls[0] as ListObjectsV2Command).input.ContinuationToken).toBeUndefined();
    expect((transport.calls[1] as ListObjectsV2Command).input.ContinuationToken).toBeUndefined();
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

interface ObjectListing {
  Contents?: Array<{ Key?: string; LastModified?: Date }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

function scriptedObjectListingClient(listings: ObjectListing[]): {
  client: S3Client;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const pendingListings = [...listings];
  const client = {
    send(command: unknown) {
      calls.push(command);
      if (!(command instanceof ListObjectsV2Command)) {
        return Promise.reject(new Error("UNEXPECTED_S3_COMMAND"));
      }
      const response = pendingListings.shift();
      return response
        ? Promise.resolve(response)
        : Promise.reject(new Error("UNEXPECTED_OBJECT_LIST"));
    }
  };

  return { client: client as unknown as S3Client, calls };
}
