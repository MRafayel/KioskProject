import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const PROCESSOR_RESPONSE_DIRECTORY = /^processor-response-[A-Za-z0-9_-]{6,64}$/u;

export interface ProcessorScratchCleanupOptions {
  directory: string;
  staleAfterMilliseconds: number;
  now?: () => number;
}

export async function cleanupOrphanedProcessorScratch(
  options: ProcessorScratchCleanupOptions
): Promise<number> {
  assertPositiveDuration(options.staleAfterMilliseconds, "STALE_AFTER_INVALID");
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("PROCESSOR_SCRATCH_ROOT_INVALID");
  }
  if (process.platform !== "win32" && (root.mode & 0o077) !== 0) {
    throw new Error("PROCESSOR_SCRATCH_ROOT_PERMISSIONS_INVALID");
  }
  if (typeof process.getuid === "function" && root.uid !== process.getuid()) {
    throw new Error("PROCESSOR_SCRATCH_ROOT_OWNER_INVALID");
  }

  const now = options.now?.() ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("PROCESSOR_SCRATCH_CLOCK_INVALID");
  const entries = await readdir(directory, { withFileTypes: true });
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !PROCESSOR_RESPONSE_DIRECTORY.test(entry.name)) continue;
    const candidatePath = join(directory, entry.name);
    const first = await lstatIfPresent(candidatePath);
    if (
      !first ||
      !first.isDirectory() ||
      first.isSymbolicLink() ||
      now - first.mtimeMs < options.staleAfterMilliseconds
    ) {
      continue;
    }

    // Re-check identity and age immediately before deletion. Concurrent worker
    // processes may remove and recreate names while this sweep is running.
    const current = await lstatIfPresent(candidatePath);
    if (
      !current ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== first.dev ||
      current.ino !== first.ino ||
      now - current.mtimeMs < options.staleAfterMilliseconds
    ) {
      continue;
    }
    await rm(candidatePath, { recursive: true, force: true });
    deleted += 1;
  }
  return deleted;
}

export class ProcessorScratchJanitor {
  private interval: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  public constructor(
    private readonly options: ProcessorScratchCleanupOptions & {
      intervalMilliseconds: number;
      onError?: (error: unknown) => void;
    }
  ) {
    assertPositiveDuration(options.intervalMilliseconds, "CLEANUP_INTERVAL_INVALID");
  }

  public async start(): Promise<void> {
    if (this.interval) return;
    await this.runOnce();
    this.interval = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.options.onError?.(error));
    }, this.options.intervalMilliseconds);
    this.interval.unref();
  }

  public async close(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.running?.catch(() => undefined);
  }

  public runOnce(): Promise<number> {
    if (this.running) return this.running;
    const running = cleanupOrphanedProcessorScratch(this.options);
    this.running = running;
    const clear = () => {
      if (this.running === running) this.running = undefined;
    };
    void running.then(clear, clear);
    return running;
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPositiveDuration(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
