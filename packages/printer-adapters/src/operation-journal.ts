import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { OPERATION_ID_PATTERN } from "./submission.js";
import { PrinterAdapterError } from "./types.js";

/**
 * What this machine already told a device.
 *
 * A print queue is not a durable record of what a kiosk did. Spoolers restart,
 * job history is purged on a timer, and a device that has forgotten a job
 * answers a status query exactly the way a device that never received one does.
 * Believing that answer is how one paid job becomes two printed jobs.
 *
 * So the intent is written here first, before any device call, and it is what
 * separates the two cases afterwards: no journal entry means nothing was ever
 * handed over and the work is safe to submit; an entry whose jobs the device
 * cannot account for means the outcome is unknown, and unknown is reported
 * rather than resolved.
 *
 * Entries are pruned by age on the same cutoff as device output, because past
 * the job's own deadline no redelivery can still arrive to be resolved.
 */

export interface DeviceOperationDocument {
  position: number;
  /** The identifier the device's own queue gave this document, once known. */
  jobId: string | null;
  /** The name the job was submitted under, which is how it is found again. */
  jobName: string;
}

export interface DeviceOperationRecord {
  operationId: string;
  queueName: string;
  submittedAt: string;
  documentCount: number;
  documents: DeviceOperationDocument[];
}

const RECORD_SUFFIX = ".json";

export class DeviceOperationJournal {
  private readonly directory: string;

  public constructor(directory: string) {
    this.directory = resolve(directory);
  }

  /**
   * Record the intent to submit. Called before the first device call, so a
   * process killed between here and the queue still leaves evidence that
   * something may have been handed over.
   */
  public async open(record: DeviceOperationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(record);
  }

  /** Attach the queue's own job identifier as soon as the device returns one. */
  public async recordJobId(operationId: string, position: number, jobId: string): Promise<void> {
    const record = await this.read(operationId);
    if (!record) return;
    const document = record.documents.find((entry) => entry.position === position);
    if (!document) return;
    document.jobId = jobId;
    await this.write(record);
  }

  public async read(operationId: string): Promise<DeviceOperationRecord | null> {
    let contents: string;
    try {
      contents = await readFile(this.recordPath(operationId), "utf8");
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      // A truncated record is still evidence that a submission started, and
      // treating it as absent is the one reading that could reprint a paid job.
      return { operationId, queueName: "", submittedAt: "", documentCount: 0, documents: [] };
    }
    return asRecord(operationId, parsed);
  }

  public async discard(operationId: string): Promise<void> {
    await rm(this.recordPath(operationId), { force: true });
  }

  /**
   * Drop entries last touched before a cutoff and answer how many went.
   *
   * By age rather than wholesale: more than one agent instance may share this
   * directory, and a peer's in-flight operation is always newer than the cutoff
   * because a job is settled at its own deadline.
   */
  public async discardBefore(cutoff: Date): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) return 0;
      throw error;
    }

    let discarded = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(RECORD_SUFFIX)) continue;
      const operationId = entry.name.slice(0, -RECORD_SUFFIX.length);
      if (!OPERATION_ID_PATTERN.test(operationId)) continue;
      const path = this.childPath(entry.name);
      const stats = await stat(path).catch((error: unknown) => {
        if (isMissingPath(error)) return null;
        throw error;
      });
      if (!stats || stats.mtimeMs >= cutoff.getTime()) continue;
      await rm(path, { force: true });
      discarded += 1;
    }
    return discarded;
  }

  private async write(record: DeviceOperationRecord): Promise<void> {
    await writeFile(this.recordPath(record.operationId), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600
    });
  }

  private recordPath(operationId: string): string {
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new PrinterAdapterError("OPERATION_ID_INVALID");
    }
    return this.childPath(operationId + RECORD_SUFFIX);
  }

  /**
   * Join a validated segment and prove the result stayed inside the journal
   * directory. The pattern check already excludes separators; the containment
   * check makes that a property of the filesystem rather than of a regular
   * expression somebody may later relax.
   */
  private childPath(segment: string): string {
    const candidate = resolve(this.directory, segment);
    if (!candidate.startsWith(this.directory + sep) || candidate === this.directory) {
      throw new PrinterAdapterError("OPERATION_ID_INVALID");
    }
    return candidate;
  }
}

/**
 * The job name a document is submitted under.
 *
 * It carries the operation, the document's position and how many documents the
 * operation has, so a queue listing alone is enough to tell a complete operation
 * from a partial one after a restart. It contains no customer filename — the
 * adapter never sees one — and the operation identifier is a random UUID, so
 * nothing here is legible to somebody reading the printer's display.
 */
export function deviceJobName(
  operationId: string,
  position: number,
  documentCount: number
): string {
  return `${operationId}#${pad(position)}of${pad(documentCount)}`;
}

const JOB_NAME_PATTERN = /^([0-9a-f-]{36})#(\d{3})of(\d{3})$/iu;

export interface ParsedJobName {
  operationId: string;
  position: number;
  documentCount: number;
}

export function parseDeviceJobName(value: string): ParsedJobName | null {
  const match = JOB_NAME_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, operationId, position, documentCount] = match;
  if (!OPERATION_ID_PATTERN.test(operationId!)) return null;
  const parsedCount = Number(documentCount);
  const parsedPosition = Number(position);
  if (parsedCount < 1 || parsedPosition >= parsedCount) return null;
  return {
    operationId: operationId!.toLowerCase(),
    position: parsedPosition,
    documentCount: parsedCount
  };
}

function pad(value: number): string {
  return String(value).padStart(3, "0");
}

function asRecord(operationId: string, value: unknown): DeviceOperationRecord {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const documents = Array.isArray(source.documents) ? source.documents : [];
  return {
    operationId,
    queueName: typeof source.queueName === "string" ? source.queueName : "",
    submittedAt: typeof source.submittedAt === "string" ? source.submittedAt : "",
    documentCount:
      typeof source.documentCount === "number" && Number.isSafeInteger(source.documentCount)
        ? source.documentCount
        : documents.length,
    documents: documents.flatMap((entry) => {
      const document = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      if (typeof document.position !== "number" || !Number.isSafeInteger(document.position)) {
        return [];
      }
      return [
        {
          position: document.position,
          jobId: typeof document.jobId === "string" ? document.jobId : null,
          jobName: typeof document.jobName === "string" ? document.jobName : ""
        }
      ];
    })
  };
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT");
}
