/**
 * Serial benchmark + output-fingerprint harness for the document processor.
 *
 * Usage:
 *   pnpm --filter @printing-kiosk/document-processor bench -- \
 *     --file ~/Downloads/Screenshot.pdf --runs 3 --out baseline.json
 *
 * The processor accepts one request at a time by design, so runs are strictly
 * serial. This measures the client-visible request duration; the per-stage
 * split comes from the processor's own `processor.timing` log line, which is
 * enabled with PROCESSOR_TIMING_LOG=1.
 *
 * It also records an output fingerprint — page count, ordering, per-page
 * dimensions and preview digests — so a later run can be compared against an
 * earlier one to prove an optimization did not change the result.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { extract } from "tar-stream";

interface PageFingerprint {
  pageNumber: number;
  widthPixels: number;
  heightPixels: number;
  previewSha256: string;
  previewSizeBytes: number;
}

interface RunResult {
  milliseconds: number;
  tarBytes: number;
  normalizedBytes: number;
  normalizedSha256: string;
  pageCount: number;
  pages: PageFingerprint[];
}

interface BenchSummary {
  file: string;
  kind: string;
  inputBytes: number;
  runs: number;
  milliseconds: { mean: number; min: number; max: number; all: number[] };
  perPageMilliseconds: number;
  normalizedBytes: number;
  tarBytes: number;
  pageCount: number;
  /** Stable across runs; the thing to diff before/after an optimization. */
  fingerprint: { normalizedSha256: string; pages: PageFingerprint[] };
}

const options = parseArguments(process.argv.slice(2));
const body = await readFile(options.file);
const kind = detectKind(body);
const sha256 = createHash("sha256").update(body).digest("hex");

process.stdout.write(
  `file=${options.file} kind=${kind} bytes=${String(body.byteLength)} runs=${String(options.runs)}\n`
);

const results: RunResult[] = [];
for (let run = 1; run <= options.runs; run += 1) {
  const result = await processOnce(body, kind, sha256);
  results.push(result);
  process.stdout.write(
    `run ${String(run)}/${String(options.runs)}: ${result.milliseconds.toFixed(0)}ms ` +
      `pages=${String(result.pageCount)} ` +
      `normalized=${formatMebibytes(result.normalizedBytes)} tar=${formatMebibytes(result.tarBytes)}\n`
  );
}

assertRunsAgree(results);

const durations = results.map((result) => result.milliseconds);
const first = results[0];
if (!first) throw new Error("NO_RUNS");
const summary: BenchSummary = {
  file: options.file,
  kind,
  inputBytes: body.byteLength,
  runs: options.runs,
  milliseconds: {
    mean: mean(durations),
    min: Math.min(...durations),
    max: Math.max(...durations),
    all: durations
  },
  perPageMilliseconds: mean(durations) / first.pageCount,
  normalizedBytes: first.normalizedBytes,
  tarBytes: first.tarBytes,
  pageCount: first.pageCount,
  fingerprint: { normalizedSha256: first.normalizedSha256, pages: first.pages }
};

process.stdout.write(
  `\nmean=${summary.milliseconds.mean.toFixed(0)}ms ` +
    `min=${summary.milliseconds.min.toFixed(0)}ms ` +
    `max=${summary.milliseconds.max.toFixed(0)}ms ` +
    `perPage=${summary.perPageMilliseconds.toFixed(0)}ms\n`
);

if (options.out) {
  await writeFile(options.out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${options.out}\n`);
}

async function processOnce(
  payload: Buffer,
  documentKind: string,
  digest: string
): Promise<RunResult> {
  const started = process.hrtime.bigint();
  const { status, tar } = await postDocument(payload, documentKind, digest);
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (status !== 200) {
    throw new Error(`PROCESSOR_STATUS_${String(status)}: ${tar.toString("utf8").slice(0, 200)}`);
  }
  const unpacked = await unpackTar(tar);
  return { milliseconds: elapsed, tarBytes: tar.byteLength, ...unpacked };
}

function postDocument(
  payload: Buffer,
  documentKind: string,
  digest: string
): Promise<{ status: number; tar: Buffer }> {
  return new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        host: options.host,
        port: options.port,
        path: "/internal/v1/process",
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/octet-stream",
          // Explicit length: the server rejects chunked transfer encoding.
          "content-length": String(payload.byteLength),
          "x-document-kind": documentKind,
          "x-content-sha256": digest,
          "x-processor-protocol-version": "1"
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, tar: Buffer.concat(chunks) })
        );
        response.on("error", reject);
      }
    );
    clientRequest.setTimeout(options.timeoutMilliseconds, () => {
      clientRequest.destroy(new Error("BENCH_REQUEST_TIMEOUT"));
    });
    clientRequest.on("error", reject);
    clientRequest.end(payload);
  });
}

async function unpackTar(tar: Buffer): Promise<Omit<RunResult, "milliseconds" | "tarBytes">> {
  const entries = new Map<string, Buffer>();
  const extractor = extract();
  const done = new Promise<void>((resolve, reject) => {
    extractor.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });
    extractor.on("finish", resolve);
    extractor.on("error", reject);
  });
  extractor.end(tar);
  await done;

  if (options.dump) {
    const normalized = entries.get("normalized/document.pdf");
    if (normalized) await writeFile(options.dump, normalized);
  }

  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error("MANIFEST_MISSING");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    pageCount: number;
    normalized: { sizeBytes: number; sha256: string };
    pages: {
      pageNumber: number;
      widthPixels: number;
      heightPixels: number;
      preview: { path: string; sha256: string; sizeBytes: number };
    }[];
  };

  // Verify the archive actually contains what the manifest claims, so a
  // fingerprint can never be recorded from a truncated or reordered response.
  const pages: PageFingerprint[] = manifest.pages.map((page) => {
    const preview = entries.get(page.preview.path);
    if (!preview) throw new Error(`PREVIEW_MISSING_${String(page.pageNumber)}`);
    const actual = createHash("sha256").update(preview).digest("hex");
    if (actual !== page.preview.sha256) {
      throw new Error(`PREVIEW_DIGEST_MISMATCH_${String(page.pageNumber)}`);
    }
    return {
      pageNumber: page.pageNumber,
      widthPixels: page.widthPixels,
      heightPixels: page.heightPixels,
      previewSha256: actual,
      previewSizeBytes: preview.byteLength
    };
  });
  if (pages.length !== manifest.pageCount) throw new Error("PAGE_COUNT_MISMATCH");
  pages.forEach((page, index) => {
    if (page.pageNumber !== index + 1) throw new Error("PAGE_ORDER_MISMATCH");
  });

  return {
    normalizedBytes: manifest.normalized.sizeBytes,
    normalizedSha256: manifest.normalized.sha256,
    pageCount: manifest.pageCount,
    pages
  };
}

/**
 * The processor is deterministic, so repeated runs on the same input must
 * produce the same artifacts. A disagreement means the benchmark itself is
 * unreliable and no timing conclusion drawn from it would be trustworthy.
 */
function assertRunsAgree(runs: RunResult[]): void {
  const [reference, ...rest] = runs;
  if (!reference) throw new Error("NO_RUNS");
  for (const run of rest) {
    if (
      run.normalizedSha256 !== reference.normalizedSha256 ||
      run.pageCount !== reference.pageCount ||
      JSON.stringify(run.pages) !== JSON.stringify(reference.pages)
    ) {
      throw new Error("NONDETERMINISTIC_OUTPUT_ACROSS_RUNS");
    }
  }
}

function detectKind(payload: Buffer): "PDF" | "JPEG" | "PNG" {
  if (payload.subarray(0, 5).toString("latin1") === "%PDF-") return "PDF";
  if (payload[0] === 0xff && payload[1] === 0xd8 && payload[2] === 0xff) return "JPEG";
  if (
    payload.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "PNG";
  }
  throw new Error("UNSUPPORTED_INPUT_KIND");
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function parseArguments(argv: string[]): {
  file: string;
  runs: number;
  out?: string;
  dump?: string;
  host: string;
  port: number;
  token: string;
  timeoutMilliseconds: number;
} {
  const values = new Map<string, string>();
  // `pnpm run bench -- --file x` forwards a bare "--", so scan for flags
  // rather than assuming fixed key/value pairs at even offsets.
  const tokens = argv.filter((token) => token !== "--");
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index];
    if (!key?.startsWith("--")) continue;
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    values.set(key.slice(2), value);
    index += 1;
  }
  const file = values.get("file");
  if (!file) throw new Error("USAGE: --file <path> [--runs N] [--out summary.json]");
  const out = values.get("out");
  const dump = values.get("dump");
  return {
    file,
    runs: Number(values.get("runs") ?? 3),
    ...(out ? { out } : {}),
    ...(dump ? { dump } : {}),
    host: values.get("host") ?? "127.0.0.1",
    port: Number(values.get("port") ?? 3200),
    token:
      values.get("token") ??
      process.env.DOCUMENT_PROCESSOR_AUTH_TOKEN ??
      process.env.PROCESSOR_AUTH_TOKEN ??
      "development-processor-auth-token-change-me",
    timeoutMilliseconds: Number(values.get("timeout") ?? 300_000)
  };
}
