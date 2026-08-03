import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PDF_SIGNATURE = "%PDF-";

export interface SpooledDocument {
  documentId: string;
  position: number;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface DocumentRequest {
  printJobId: string;
  documentId: string;
  position: number;
  sha256: string;
  sizeBytes: number;
  claimToken: string;
}

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PrintSpoolOptions {
  directory: string;
  apiOrigin: string;
  authorization: string;
  maxDocumentBytes: number;
  fetch?: UpstreamFetch;
  timeoutMilliseconds?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The kiosk's local copy of what it is about to print.
 *
 * Nothing a customer typed reaches a path here: a spooled file is named from
 * fresh random bytes inside a directory named after the operation. Every
 * download is bounded, its length is checked against the manifest, and its
 * digest must match before the bytes are allowed near a device — a truncated or
 * substituted artifact is refused rather than printed.
 */
export class PrintSpool {
  private readonly directory: string;
  private readonly fetch: UpstreamFetch;

  public constructor(private readonly options: PrintSpoolOptions) {
    this.directory = resolve(options.directory, "operations");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  public async fetchDocuments(
    operationId: string,
    requests: readonly DocumentRequest[]
  ): Promise<SpooledDocument[]> {
    const target = this.operationDirectory(operationId);
    await mkdir(target, { recursive: true, mode: 0o700 });

    const spooled: SpooledDocument[] = [];
    for (const request of requests) {
      spooled.push(await this.fetchOne(target, request));
    }
    return spooled;
  }

  /**
   * Remove one operation's local copies. Deleting the spool is the point at
   * which the customer's document stops existing on this machine.
   */
  public async discard(operationId: string): Promise<void> {
    await rm(this.operationDirectory(operationId), { recursive: true, force: true });
  }

  private async fetchOne(target: string, request: DocumentRequest): Promise<SpooledDocument> {
    if (request.sizeBytes < 1 || request.sizeBytes > this.options.maxDocumentBytes) {
      throw new Error("PRINT_DOCUMENT_TOO_LARGE");
    }

    const url = new URL(
      `/v1/agent/print-jobs/${encodeURIComponent(request.printJobId)}` +
        `/documents/${encodeURIComponent(request.documentId)}`,
      this.options.apiOrigin
    );
    const response = await this.fetch(url, {
      method: "GET",
      headers: {
        accept: "application/pdf",
        authorization: this.options.authorization,
        "x-print-claim-token": request.claimToken
      },
      signal: AbortSignal.timeout(this.options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MS)
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("PRINT_DOCUMENT_UNAVAILABLE");
    }

    const bytes = Buffer.from(await readBounded(response.body, request.sizeBytes));
    if (
      bytes.byteLength !== request.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== request.sha256 ||
      bytes.subarray(0, PDF_SIGNATURE.length).toString("ascii") !== PDF_SIGNATURE
    ) {
      throw new Error("PRINT_DOCUMENT_INTEGRITY_FAILED");
    }

    // A random local name. The customer's filename is never known here and
    // could not become a path even if it were.
    const path = this.childPath(target, `${randomBytes(16).toString("hex")}.pdf`);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });

    return {
      documentId: request.documentId,
      position: request.position,
      path,
      sha256: request.sha256,
      sizeBytes: request.sizeBytes
    };
  }

  private operationDirectory(operationId: string): string {
    if (!OPERATION_ID_PATTERN.test(operationId)) throw new Error("PRINT_OPERATION_ID_INVALID");
    return this.childPath(this.directory, operationId);
  }

  private childPath(parent: string, segment: string): string {
    const candidate = resolve(parent, segment);
    if (!candidate.startsWith(parent + sep) || candidate === parent) {
      throw new Error("PRINT_SPOOL_PATH_INVALID");
    }
    return candidate;
  }
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      // Stop the moment the response exceeds what the manifest promised rather
      // than buffering whatever the other side decides to send.
      if (received > expectedBytes) throw new Error("PRINT_DOCUMENT_TOO_LARGE");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
