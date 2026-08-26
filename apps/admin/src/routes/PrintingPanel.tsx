import { useCallback, useState } from "react";

import type { AdminPrintJobsResponse } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Pagination,
  Panel,
  RowWhen,
  StateBadge,
  Table,
  When,
  humanizeState
} from "../features/observability/components.js";
import {
  FilterKpi,
  KpiRow,
  RowOpen,
  Sheet,
  StatusPill
} from "../features/observability/surfaces.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { usePageTrail } from "../features/observability/usePageTrail.js";
import { useDetailSheet } from "../features/observability/useDetailSheet.js";
import {
  RecordedResolution,
  RecoveryCorrectionForm,
  RecoveryResolutionForm
} from "./RecoveryResolutionForm.js";

type PrintJob = AdminPrintJobsResponse["items"][number];

const STATUSES = [
  "QUEUED",
  "DISPATCHED",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "RECOVERY_REQUIRED"
] as const;

/**
 * The tiles above the table, and what each one filters to.
 *
 * Three are print-job statuses the server understands. `UNANSWERED` is not a
 * status — it is `RECOVERY_REQUIRED` with no recorded recovery resolution —
 * so the request sends both conditions. That keeps the worklist server-backed
 * and prevents answered jobs from displacing unresolved ones on a bounded page.
 */
type CardId = "UNANSWERED" | "RECOVERY_REQUIRED" | "FAILED" | "COMPLETED";

const STATUS_CARDS = new Set<string>(["RECOVERY_REQUIRED", "FAILED", "COMPLETED"]);

function activeCard(status: string, unansweredOnly: boolean): CardId | null {
  if (unansweredOnly) return "UNANSWERED";
  return STATUS_CARDS.has(status) ? (status as CardId) : null;
}

/** A print that is waiting for a person to say what came out of the tray. */
function isUnanswered(job: PrintJob): boolean {
  return job.status === "RECOVERY_REQUIRED" && !job.recoveryResolved;
}

/**
 * What is wrong with one print job, decided once and said on the row.
 *
 * `UNCONFIRMED` is the one worth naming in words. It means the queue accepted
 * the job and nothing ever confirmed that paper came out — not a failure, not a
 * success, and the single state a dashboard is most tempted to round up. The
 * system refuses to guess and so does this row.
 */
function flagsFor(job: PrintJob): string[] {
  const flags: string[] = [];
  if (isUnanswered(job)) flags.push("Unresolved recovery");
  if (job.overdue) flags.push("Overdue");
  if (job.resultConfidence === "UNCONFIRMED") flags.push("Never confirmed");
  return flags;
}

function levelFor(job: PrintJob): "critical" | "warn" | "none" {
  if (isUnanswered(job) || job.status === "FAILED") return "critical";
  if (job.status === "RECOVERY_REQUIRED" || job.overdue || job.resultConfidence === "UNCONFIRMED")
    return "warn";
  return "none";
}

/**
 * Print jobs, and what the device actually said.
 *
 * Built as Sessions is built, and for the same reason: this is the same kind of
 * screen — a worklist of records, some of which need a person — so it gets the
 * same table, the same filter tiles and the same detail sheet rather than a
 * second dialect of all three.
 *
 * `UNCONFIRMED` is shown as itself and never rounded up to a success. The
 * system refuses to guess whether paper came out, and a dashboard that quietly
 * decided otherwise would undo the one property that makes a paid print
 * trustworthy.
 */
export function PrintingPanel({
  initialStatus,
  initialUnresolved = false
}: {
  initialStatus?: string | undefined;
  initialUnresolved?: boolean | undefined;
} = {}) {
  const session = useSession();
  // Opening state only. The shell remounts this panel when the reason for
  // arriving changes, so a filter chosen on the overview shows up here without
  // taking the control away from the person once they are looking at it.
  const [status, setStatus] = useState(initialUnresolved ? "" : (initialStatus ?? ""));
  /** A first-class worklist filter, kept mutually exclusive with `status`. */
  const [unansweredOnly, setUnansweredOnly] = useState(initialUnresolved);

  const sheet = useDetailSheet();
  const selected = sheet.selected;

  const pages = usePageTrail();
  const cursor = pages.cursor;
  const load = useCallback(
    () =>
      observabilityApi.printJobs({
        status: unansweredOnly ? "RECOVERY_REQUIRED" : status || undefined,
        recoveryResolved: unansweredOnly ? "false" : undefined,
        cursor
      }),
    [status, unansweredOnly, cursor]
  );
  const list = useAdminData(load, { refreshMilliseconds: 15_000 });
  const nextCursor = list.data?.nextCursor ?? null;

  const items = list.data?.items ?? [];
  const count = (predicate: (job: PrintJob) => boolean) => items.filter(predicate).length;

  const unanswered = count(isUnanswered);
  const recovery = count((job) => job.status === "RECOVERY_REQUIRED");
  const failed = count((job) => job.status === "FAILED");
  const completed = count((job) => job.status === "COMPLETED");
  const unconfirmed = count((job) => job.resultConfidence === "UNCONFIRMED");

  const visible = unansweredOnly ? items.filter(isUnanswered) : items;
  const attention = visible.filter((job) => levelFor(job) === "critical").length;

  const active = activeCard(status, unansweredOnly);
  const filtered = unansweredOnly || status !== "";
  const narrowed = unansweredOnly || status !== "";

  const describeFilter = () =>
    unansweredOnly ? "with unresolved recovery" : humanizeState(status);

  const clearFilter = useCallback(() => {
    setStatus("");
    setUnansweredOnly(false);
    pages.reset();
  }, [pages]);

  /** One segmented control: choosing a filter replaces whatever was on. */
  const chooseCard = useCallback((card: CardId) => {
    if (card === "UNANSWERED") {
      setStatus("");
      setUnansweredOnly((current) => !current);
      pages.reset();
      return;
    }
    setUnansweredOnly(false);
    setStatus((current) => (current === card ? "" : card));
    pages.reset();
  }, []);

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p
            className={`page-head__summary page-head__summary--${
              list.data === null ? "calm" : attention === 0 ? "calm" : "critical"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {list.data === null
              ? "Loading recent print jobs…"
              : visible.length === 0
                ? filtered
                  ? `No print jobs ${describeFilter().toLowerCase()}`
                  : "No print jobs recorded yet"
                : attention === 0
                  ? "Recent prints are landing normally"
                  : `${attention} of these ${visible.length} print jobs need review`}
          </p>
          <p className="page-head__meta">
            {visible.length > 0 ? `Showing ${visible.length} most recent` : "Nothing to show"}
            {filtered ? ` · ${describeFilter()}` : ""}
            {list.data?.scoped ? " · your assigned kiosks" : ""}
            {filtered ? (
              <button type="button" className="button-link page-head__clear" onClick={clearFilter}>
                Show all
              </button>
            ) : null}
          </p>
        </div>

        <div className="page-head__actions">
          {list.loading && list.data ? (
            <span className="page-head__refreshing" role="status">
              Refreshing…
            </span>
          ) : null}
          <label className="inline-field">
            Status
            <select
              value={unansweredOnly ? "UNRESOLVED" : status}
              onChange={(event) => {
                // The dropdown and the tiles are the same filter reached two
                // ways, so choosing here turns off whatever a tile had on.
                const next = event.target.value;
                setStatus(next === "UNRESOLVED" ? "" : next);
                setUnansweredOnly(next === "UNRESOLVED");
                pages.reset();
              }}
            >
              <option value="">Any</option>
              <option value="UNRESOLVED">Unresolved recovery</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {humanizeState(value)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button-primary"
            onClick={list.reload}
            disabled={list.loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {items.length > 0 ? (
        <KpiRow>
          <FilterKpi
            noun="print jobs"
            card="UNANSWERED"
            label="Unresolved recovery"
            value={unanswered}
            resting={
              unanswered === 0
                ? "Every recovery has an observation"
                : "No observation has been recorded yet"
            }
            tone={unanswered > 0 ? "critical" : undefined}
            elevated={unanswered > 0 && active === null}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
            noun="print jobs"
            card="RECOVERY_REQUIRED"
            label="Recovery-state jobs"
            value={recovery}
            resting={recovery === 0 ? "None on this page" : "Resolved and unresolved together"}
            tone={recovery > 0 ? "warn" : undefined}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
            noun="print jobs"
            card="FAILED"
            label="Failed print jobs"
            value={failed}
            resting={failed === 0 ? "None on this page" : "The print did not land"}
            tone={failed > 0 ? "critical" : undefined}
            elevated={unanswered === 0 && failed > 0 && active === null}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
            noun="print jobs"
            card="COMPLETED"
            label="Completed print jobs"
            value={completed}
            resting={`${unconfirmed} never confirmed`}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
        </KpiRow>
      ) : null}

      <Panel title="Recent print jobs" state={list} emptyMessage="No print jobs to show.">
        {list.data && visible.length === 0 ? (
          <Empty>
            {filtered ? (
              <>
                {unansweredOnly
                  ? "Every recovery-state job on this page has an observation."
                  : `No print jobs are ${humanizeState(status).toLowerCase()}.`}{" "}
                <button type="button" className="button-link" onClick={clearFilter}>
                  Clear the filter
                </button>
              </>
            ) : (
              "No print jobs have been recorded yet."
            )}
          </Empty>
        ) : null}

        {visible.length > 0 ? (
          <Table
            className="data-table data-table--interactive"
            pane
            paneClassName="data-pane"
            columns={["Created", "Kiosk", "Status", "Result", "Sheets", "Attempts"]}
          >
            {visible.map((job) => {
              const level = levelFor(job);
              const flags = flagsFor(job);
              const classes = [
                selected === job.id ? "is-selected" : "",
                level === "critical" ? "is-alarming-row" : "",
                level === "warn" ? "is-quiet-row" : ""
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <tr
                  key={job.id}
                  className={classes || undefined}
                  onClick={(event) =>
                    sheet.open(
                      job.id,
                      event.currentTarget.querySelector<HTMLButtonElement>(".row-open")
                    )
                  }
                >
                  <td data-label="Created">
                    <RowOpen
                      open={selected === job.id}
                      onOpen={(opener) => sheet.open(job.id, opener)}
                      label={`Print job on ${job.kioskId}, ${humanizeState(
                        job.status
                      )}, created ${new Date(job.createdAt).toLocaleString()}`}
                    >
                      <RowWhen value={job.createdAt} />
                    </RowOpen>
                  </td>
                  <td data-label="Kiosk">{job.kioskId}</td>
                  <td data-label="Status">
                    <StateBadge
                      value={job.status}
                      humanize
                      quiet={job.status === "COMPLETED" || job.status === "PRINTING"}
                    />
                    {flags.length > 0 ? (
                      <span className="row-flags">
                        {flags.map((flag) => (
                          <StatusPill key={flag} tone={flag === "Overdue" ? "warn" : "critical"}>
                            {flag}
                          </StatusPill>
                        ))}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Result">
                    <StateBadge
                      value={job.resultConfidence}
                      humanize
                      quiet={job.resultConfidence === "CONFIRMED"}
                    />
                    {job.failureCode ? (
                      <span className="key-list__meta">{job.failureCode}</span>
                    ) : null}
                  </td>
                  <td data-label="Sheets">
                    {job.sheetsProduced ?? "—"} / {job.physicalSheets}
                  </td>
                  <td data-label="Attempts">
                    {job.dispatchAttempts}
                    <span className="row-chevron" aria-hidden="true">
                      {" ›"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : null}

        <Pagination
          label="Print job pages"
          page={pages.page}
          pageCount={pages.pageCount}
          hasNext={pages.hasNext(nextCursor)}
          onGo={(target) => pages.go(target, nextCursor)}
        />
      </Panel>

      {selected ? (
        <PrintJobSheet
          printJobId={selected}
          canSeeDiagnostics={session.can("print.diagnostics.read")}
          canResolveRecovery={session.can("print.recovery.resolve")}
          canCorrectRecovery={session.can("print.recovery.correct")}
          onResolved={list.reload}
          onClose={sheet.close}
        />
      ) : null}
    </>
  );
}

/**
 * One print job, opened over the table.
 *
 * This one holds a form as well as a record: recording what an operator saw at
 * the tray is the only write on this screen, and it now happens in the sheet
 * rather than a screenful below the row that prompted it. Recording it reloads
 * the list behind, so the row's "needs a person" flag clears while the sheet is
 * still open and the operator can see that their answer landed.
 */
function PrintJobSheet({
  printJobId,
  canSeeDiagnostics,
  canResolveRecovery,
  canCorrectRecovery,
  onResolved,
  onClose
}: {
  printJobId: string;
  canSeeDiagnostics: boolean;
  canResolveRecovery: boolean;
  canCorrectRecovery: boolean;
  onResolved: () => void;
  onClose: () => void;
}) {
  const load = useCallback(() => observabilityApi.printJob(printJobId), [printJobId]);
  const detail = useAdminData(load);
  const job = detail.data?.job ?? null;

  return (
    <Sheet
      title="Print job detail"
      onClose={onClose}
      subtitle={
        job ? (
          <>
            <StateBadge value={job.status} humanize />
            <span>{job.kioskId}</span>
            <span aria-hidden="true">·</span>
            <When value={job.createdAt} />
          </>
        ) : (
          <span>Loading…</span>
        )
      }
    >
      {detail.error ? (
        <div className="panel__error" role="alert">
          <span className="panel__error-text">{detail.error}</span>
          <button type="button" onClick={detail.reload}>
            Try again
          </button>
        </div>
      ) : null}

      {detail.loading && !detail.data ? (
        <p className="panel__status" role="status">
          Loading…
        </p>
      ) : null}

      {detail.data && job ? (
        <>
          {flagsFor(job).length > 0 ? (
            <div className="sheet__flags">
              {flagsFor(job).map((flag) => (
                <StatusPill key={flag} tone={flag === "Overdue" ? "warn" : "critical"}>
                  {flag}
                </StatusPill>
              ))}
            </div>
          ) : null}

          {/* The identifiers, which used to be a truncated leading column. An
              operator quoting one into a ticket needs the whole string. */}
          <dl className="sheet__ids">
            <div className="sheet__id">
              <dt>Print job ID</dt>
              <dd>{job.id}</dd>
            </div>
            <div className="sheet__id">
              <dt>Print session ID</dt>
              <dd>{job.sessionId}</dd>
            </div>
          </dl>

          <h3>What happened</h3>
          <dl className="detail-grid">
            <div>
              <dt>Result</dt>
              <dd>
                <StateBadge value={job.resultConfidence} humanize />
              </dd>
            </div>
            <div>
              <dt>Sheets</dt>
              <dd>
                {job.sheetsProduced ?? "—"} of {job.physicalSheets} paid for
              </dd>
            </div>
            <div>
              <dt>Dispatched</dt>
              <dd>
                <When value={job.dispatchedAt} />
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>
                <When value={job.startedAt} />
              </dd>
            </div>
            <div>
              <dt>Settled</dt>
              <dd>
                <When value={job.completedAt ?? job.failedAt} />
              </dd>
            </div>
            <div>
              <dt>Manifest redacted</dt>
              <dd>
                <When value={job.manifestRedactedAt} />
              </dd>
            </div>
          </dl>

          {job.status === "RECOVERY_REQUIRED" || detail.data.resolution ? (
            <>
              <h3>Recovery</h3>
              {detail.data.resolution ? (
                <>
                  <RecordedResolution
                    resolution={detail.data.resolution}
                    corrections={detail.data.corrections}
                  />
                  {canCorrectRecovery ? (
                    <RecoveryCorrectionForm
                      printJobId={printJobId}
                      supersedesId={detail.data.corrections.at(-1)?.id ?? detail.data.resolution.id}
                      currentOutcome={
                        detail.data.corrections.at(-1)?.outcome ?? detail.data.resolution.outcome
                      }
                      onCorrected={() => {
                        detail.reload();
                        onResolved();
                      }}
                    />
                  ) : null}
                </>
              ) : canResolveRecovery ? (
                <RecoveryResolutionForm
                  printJobId={printJobId}
                  deviceSheets={job.sheetsProduced}
                  paidSheets={job.physicalSheets}
                  onRecorded={() => {
                    detail.reload();
                    onResolved();
                  }}
                />
              ) : (
                <Empty>
                  This print is waiting for somebody to say what happened at the tray. Recording
                  that is an Operator capability your role does not hold.
                </Empty>
              )}
            </>
          ) : null}

          {detail.data.command ? (
            <>
              <h3>Kiosk command</h3>
              <p className="panel__status">
                <StateBadge value={detail.data.command.status} /> after{" "}
                {detail.data.command.attempts} attempt
                {detail.data.command.attempts === 1 ? "" : "s"}
                {detail.data.command.resultCode ? (
                  <>
                    {" — "}
                    <code>{detail.data.command.resultCode}</code>
                  </>
                ) : null}
              </p>
            </>
          ) : null}

          <h3>Device ledger</h3>
          {!canSeeDiagnostics ? (
            <Empty>
              Deep diagnostics are a Technical Admin capability. The job&apos;s own outcome above is
              what your role sees.
            </Empty>
          ) : detail.data.ledger && detail.data.ledger.length > 0 ? (
            <Table columns={["#", "Event", "Status", "Confidence", "Code", "When"]}>
              {detail.data.ledger.map((event) => (
                <tr key={event.sequence}>
                  <td>{event.sequence}</td>
                  <td>
                    <code>{event.type}</code>
                  </td>
                  <td>
                    <StateBadge value={event.status} />
                  </td>
                  <td>
                    <StateBadge value={event.confidence} />
                  </td>
                  <td>{event.failureCode ?? event.warningCode ?? "—"}</td>
                  <td>
                    <When value={event.createdAt} />
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>No ledger entries.</Empty>
          )}
        </>
      ) : null}
    </Sheet>
  );
}
