/**
 * Per-stage wall-clock instrumentation for one document.
 *
 * The processor previously had no timing signal at all, which made every
 * performance claim unverifiable. This collector exists to answer one question
 * with evidence: which stage owns the request.
 *
 * Constraints it must respect:
 *  - It runs inside the per-page loop, so a stage must cost an integer add and
 *    nothing else. No allocation, no formatting, no logging per page.
 *  - Log volume must not scale with page count. Per-page samples are retained
 *    only when explicitly enabled, and even then they are summarised into one
 *    line at the end rather than emitted as they happen.
 *  - It must never carry customer data. Stage names, counts, and nanosecond
 *    durations only: no paths, digests, filenames, or object keys.
 */

export const TIMING_STAGES = [
  "input", // receive body, hash, signature-check, write to scratch
  "scan", // ClamAV INSTREAM
  "inspect", // qpdf --is-encrypted / --check / --show-npages
  "raster", // pdftoppm
  "normalize", // sharp: decode, resize, canonical encode
  "preview", // sharp: preview resize + WebP encode
  "pdfAppend", // PDFKit page append
  "finalize", // PDF stream close
  "assertOutput", // qpdf --check on the produced PDF
  "manifestHash", // stat + sha256 of every preview
  "tar" // pack, hash, stream the response
] as const;

export type TimingStage = (typeof TIMING_STAGES)[number];

/**
 * The narrow view the processing code depends on. Keeping this separate from
 * the concrete collector means the image pipeline and processor take a
 * three-method interface rather than a logging dependency, and tests can pass
 * `undefined` without constructing anything.
 */
export interface StageRecorder {
  measure<T>(stage: TimingStage, operation: () => Promise<T>): Promise<T>;
  start(stage: TimingStage): () => void;
  countPage(elapsedNanoseconds?: bigint): void;
}

export interface StageSample {
  nanoseconds: number;
  count: number;
}

export interface TimingReport {
  totalNanoseconds: number;
  pageCount: number;
  stages: Record<TimingStage, StageSample>;
  /** Per-page totals, only populated when detail capture is enabled. */
  perPageNanoseconds?: number[];
}

export class TimingCollector implements StageRecorder {
  private readonly nanoseconds = new Map<TimingStage, bigint>();
  private readonly counts = new Map<TimingStage, number>();
  private readonly perPage: number[] = [];
  private readonly startedAt = process.hrtime.bigint();
  private pageCount = 0;

  public constructor(private readonly captureDetail: boolean = false) {}

  /**
   * Times `operation` against `stage`. The stage is recorded even when the
   * operation throws, so a failed request still reports where its time went.
   */
  public async measure<T>(stage: TimingStage, operation: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      return await operation();
    } finally {
      this.record(stage, process.hrtime.bigint() - start);
    }
  }

  /** Times a synchronous span already bounded by the caller. */
  public record(stage: TimingStage, elapsed: bigint): void {
    this.nanoseconds.set(stage, (this.nanoseconds.get(stage) ?? 0n) + elapsed);
    this.counts.set(stage, (this.counts.get(stage) ?? 0) + 1);
  }

  /** Opens a manual span for code that cannot be wrapped in a callback. */
  public start(stage: TimingStage): () => void {
    const begin = process.hrtime.bigint();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.record(stage, process.hrtime.bigint() - begin);
    };
  }

  public countPage(elapsedNanoseconds?: bigint): void {
    this.pageCount += 1;
    if (this.captureDetail && elapsedNanoseconds !== undefined) {
      this.perPage.push(Number(elapsedNanoseconds));
    }
  }

  public report(): TimingReport {
    const stages = {} as Record<TimingStage, StageSample>;
    for (const stage of TIMING_STAGES) {
      stages[stage] = {
        nanoseconds: Number(this.nanoseconds.get(stage) ?? 0n),
        count: this.counts.get(stage) ?? 0
      };
    }
    return {
      totalNanoseconds: Number(process.hrtime.bigint() - this.startedAt),
      pageCount: this.pageCount,
      stages,
      ...(this.captureDetail ? { perPageNanoseconds: [...this.perPage] } : {})
    };
  }
}

/**
 * Renders one line. Milliseconds with one decimal are the useful resolution
 * here — the stages of interest are tens of milliseconds and up, and raw
 * nanosecond counts make the line unreadable when scanning a log.
 */
export function formatTimingReport(report: TimingReport, kind: string): string {
  const parts = TIMING_STAGES.filter((stage) => report.stages[stage].count > 0).map((stage) => {
    const sample = report.stages[stage];
    return `${stage}=${milliseconds(sample.nanoseconds)}ms/${String(sample.count)}`;
  });
  const perPage =
    report.pageCount > 0
      ? ` perPage=${milliseconds(report.totalNanoseconds / report.pageCount)}ms`
      : "";
  return `processor.timing total=${milliseconds(report.totalNanoseconds)}ms kind=${kind} pages=${String(report.pageCount)}${perPage} ${parts.join(" ")}`;
}

function milliseconds(nanoseconds: number): string {
  return (nanoseconds / 1_000_000).toFixed(1);
}
