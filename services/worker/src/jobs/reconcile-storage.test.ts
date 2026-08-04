import { describe, expect, it, vi, type Mock } from "vitest";

import type { PrismaClient } from "@printing-kiosk/database";

import type { RetentionStore } from "../storage/document-store.js";
import type { CleanupLogger } from "./cleanup-session.js";
import { StorageReconciler } from "./reconcile-storage.js";

const liveSessionId = "01900000-0000-7000-8000-000000000e01";
const cleanedSessionId = "01900000-0000-7000-8000-000000000e02";
const vanishedSessionId = "01900000-0000-7000-8000-000000000e03";
const now = new Date("2030-01-01T12:00:00.000Z");
const old = new Date("2030-01-01T00:00:00.000Z");

const silentLogger: CleanupLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function createReconciler(
  objects: Record<string, { key: string; lastModified: Date }[]>,
  liveSessionIds: string[],
  logger: CleanupLogger = silentLogger
) {
  const findMany = vi.fn().mockResolvedValue(liveSessionIds.map((id) => ({ id })));
  const database = {
    printSession: { findMany }
  } as unknown as PrismaClient;

  const store: { [K in keyof RetentionStore]: Mock<RetentionStore[K]> } = {
    deleteObjects: vi
      .fn<RetentionStore["deleteObjects"]>()
      .mockImplementation((keys) => Promise.resolve(keys.length)),
    purgePrefix: vi.fn<RetentionStore["purgePrefix"]>().mockResolvedValue(0),
    abortMultipartUploads: vi.fn<RetentionStore["abortMultipartUploads"]>().mockResolvedValue(0),
    listObjectsOlderThan: vi
      .fn<RetentionStore["listObjectsOlderThan"]>()
      .mockImplementation((prefix) => Promise.resolve(objects[prefix] ?? []))
  };

  const reconciler = new StorageReconciler({
    database,
    store,
    logger,
    orphanGraceMilliseconds: 7_200_000,
    now: () => now
  });
  return { reconciler, store, findMany };
}

describe("StorageReconciler", () => {
  it("deletes stray objects whose session was already cleaned or no longer exists", async () => {
    const { reconciler, store } = createReconciler(
      {
        "quarantine/v1/": [
          { key: `quarantine/v1/${cleanedSessionId}/f/token`, lastModified: old },
          { key: `quarantine/v1/${vanishedSessionId}/f/token`, lastModified: old }
        ]
      },
      []
    );

    await expect(reconciler.runOnce()).resolves.toBe(2);
    expect(store.deleteObjects).toHaveBeenCalledWith([
      `quarantine/v1/${cleanedSessionId}/f/token`,
      `quarantine/v1/${vanishedSessionId}/f/token`
    ]);
  });

  it("leaves an object alone while its session is still live", async () => {
    const { reconciler, store } = createReconciler(
      {
        "quarantine/v1/": [{ key: `quarantine/v1/${liveSessionId}/f/token`, lastModified: old }]
      },
      [liveSessionId]
    );

    await expect(reconciler.runOnce()).resolves.toBe(0);
    expect(store.deleteObjects).not.toHaveBeenCalled();
  });

  it("asks only for objects older than the orphan grace", async () => {
    const { reconciler, store } = createReconciler({}, []);

    await reconciler.runOnce();

    for (const call of store.listObjectsOlderThan.mock.calls) {
      expect(call[1]).toEqual(new Date("2030-01-01T10:00:00.000Z"));
    }
    expect(store.listObjectsOlderThan.mock.calls.map((call) => call[0])).toEqual([
      "quarantine/v1/",
      "normalized/v1/",
      "previews/v1/"
    ]);
  });

  it("aborts abandoned multipart uploads by age, never in-flight ones", async () => {
    const { reconciler, store } = createReconciler({}, []);
    store.abortMultipartUploads.mockResolvedValue(1);

    await reconciler.runOnce();

    expect(store.abortMultipartUploads).toHaveBeenCalledWith(
      ["quarantine/v1/", "normalized/v1/", "previews/v1/"],
      new Date("2030-01-01T10:00:00.000Z")
    );
  });

  it("ignores a key it does not recognise rather than deleting on a guess", async () => {
    const { reconciler, store, findMany } = createReconciler(
      {
        "quarantine/v1/": [
          { key: "quarantine/v1/not-a-session/file", lastModified: old },
          { key: "quarantine/v1/", lastModified: old }
        ]
      },
      []
    );

    await expect(reconciler.runOnce()).resolves.toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(store.deleteObjects).not.toHaveBeenCalled();
  });

  it("logs a count and a cutoff, never an object key", async () => {
    const entries: Record<string, unknown>[] = [];
    const { reconciler } = createReconciler(
      {
        "previews/v1/": [
          { key: `previews/v1/${cleanedSessionId}/f/r1/g1/page-1.webp`, lastModified: old }
        ]
      },
      [],
      {
        info: () => undefined,
        warn: (fields: Record<string, unknown>) => {
          entries.push(fields);
        },
        error: () => undefined
      }
    );

    await reconciler.runOnce();

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(cleanedSessionId);
    expect(serialized).toContain('"objectsDeleted":1');
  });
});
