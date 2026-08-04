import type { PrismaClient } from "@printing-kiosk/database";
import { SESSION_OBJECT_ROOTS, sessionIdFromObjectKey } from "@printing-kiosk/domain";

import type { RetentionStore } from "../storage/document-store.js";
import type { CleanupLogger } from "./cleanup-session.js";

const DEFAULT_INTERVAL_MILLISECONDS = 900_000;
const DEFAULT_PAGE_SIZE = 200;

export interface StorageReconcilerOptions {
  database: PrismaClient;
  store: RetentionStore;
  logger: CleanupLogger;
  /**
   * How old an object must be before it is treated as nobody's. Configuration
   * validation keeps this longer than any session can live.
   */
  orphanGraceMilliseconds: number;
  intervalMilliseconds?: number;
  pageSize?: number;
  now?: () => Date;
}

/**
 * The safety net beneath per-session cleanup.
 *
 * Session cleanup deletes what a session's records point at and what sits under
 * its prefix. This finds what neither describes: an object whose session row is
 * long gone, bytes written by a process that died before it recorded anything,
 * the parts of a multipart upload nobody completed. It is the reason a bucket
 * lifecycle rule stays a backstop rather than becoming the mechanism.
 *
 * It deletes only by age. An object younger than the cutoff is left alone even
 * if no record explains it, because a record being written concurrently with
 * the bytes is ordinary and taking a document out from under a live upload is
 * not recoverable. The cutoff is longer than the longest a session can live, so
 * anything past it can no longer belong to one.
 */
export class StorageReconciler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running = false;

  private readonly now: () => Date;
  private readonly intervalMilliseconds: number;
  private readonly pageSize: number;

  public constructor(private readonly options: StorageReconcilerOptions) {
    this.now = options.now ?? (() => new Date());
    this.intervalMilliseconds = options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  public close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return Promise.resolve();
  }

  /** One reconciliation pass. Returns the number of stray objects removed. */
  public async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.now();
      const cutoff = new Date(now.getTime() - this.options.orphanGraceMilliseconds);

      // Parts of an upload nobody finished are stored bytes that no listing
      // shows and no row names. They are swept by age for the same reason
      // objects are.
      const aborted = await this.options.store.abortMultipartUploads(SESSION_OBJECT_ROOTS, cutoff);

      const stale: string[] = [];
      for (const root of SESSION_OBJECT_ROOTS) {
        const objects = await this.options.store.listObjectsOlderThan(root, cutoff, this.pageSize);
        stale.push(...objects.map((object) => object.key));
      }
      if (aborted > 0) {
        this.options.logger.warn(
          { multipartUploadsAborted: aborted, olderThan: cutoff.toISOString() },
          "abandoned multipart uploads aborted by storage reconciliation"
        );
      }
      if (stale.length === 0) return 0;

      const orphans = await this.selectOrphans(stale);
      if (orphans.length === 0) return 0;

      const deleted = await this.options.store.deleteObjects(orphans);
      // Only a count and a cutoff reach the log. An object key names a session
      // and a document, and neither belongs in an operational log line.
      this.options.logger.warn(
        { objectsDeleted: deleted, olderThan: cutoff.toISOString() },
        "orphaned document objects removed by storage reconciliation"
      );
      return deleted;
    } finally {
      this.running = false;
    }
  }

  /**
   * Keep only the objects no live session accounts for.
   *
   * The session identifier is read back out of the key and checked against the
   * database in one query. An object whose session is still running is left
   * alone however old it looks; a session that has already been cleaned, or one
   * that no longer exists at all, cannot own anything.
   */
  private async selectOrphans(keys: readonly string[]): Promise<string[]> {
    const bySession = new Map<string, string[]>();

    for (const key of keys) {
      const sessionId = sessionIdFromObjectKey(key);
      // A key this system does not write is not something to delete on a guess.
      if (!sessionId) continue;
      const existing = bySession.get(sessionId);
      if (existing) existing.push(key);
      else bySession.set(sessionId, [key]);
    }
    if (bySession.size === 0) return [];

    const live = await this.options.database.printSession.findMany({
      where: { id: { in: [...bySession.keys()] }, filesDeletedAt: null },
      select: { id: true }
    });
    const liveIds = new Set(live.map((session) => session.id));

    const orphans: string[] = [];
    for (const [sessionId, sessionKeys] of bySession) {
      if (liveIds.has(sessionId)) continue;
      orphans.push(...sessionKeys);
    }
    return orphans;
  }

  private schedule(delayMilliseconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMilliseconds);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.options.logger.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "storage reconciliation pass failed"
      );
    }
    this.schedule(this.intervalMilliseconds);
  }
}
