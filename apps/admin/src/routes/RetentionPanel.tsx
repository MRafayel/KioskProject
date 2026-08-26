import { useCallback, useState } from "react";

import type { AdminRetentionResponse } from "@printing-kiosk/admin-access";

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
import { FilterKpi, KpiRow, StatusPill } from "../features/observability/surfaces.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { usePageTrail } from "../features/observability/usePageTrail.js";

type CleanupRun = AdminRetentionResponse["items"][number];

/**
 * The tiles above the table, and what each one filters to.
 *
 * `PROBLEMS` is the server's own filter — overdue or given up — and is what the
 * page opens on, because a deletion that happened on schedule is not news and
 * this screen exists for the ones that did not. `GAVE_UP` and `OVERDUE` are
 * overlapping facets of that set: a run can have stopped after its deadline.
 * Clearing the active card turns the server filter off.
 */
type CardId = "PROBLEMS" | "OVERDUE" | "GAVE_UP" | "PENDING";

/** A run the worker has stopped retrying. Documents are still there. */
function gaveUp(run: CleanupRun): boolean {
  return run.status === "DEAD_LETTER";
}

function hasProblem(run: CleanupRun): boolean {
  return gaveUp(run) || run.overdue;
}

/**
 * How far a stuck run got, said in words.
 *
 * The checkpoint ladder is ordered so that each rung is a real statement about
 * what still exists: a run parked at `ACCESS_REVOKED` has closed the door but
 * deleted nothing, and one at `STORAGE_RECONCILED` has removed the bytes and
 * still holds the rows that name them. That distinction is the whole reason an
 * operator opens this page, so it belongs on the row rather than encoded in a
 * constant only the worker reads.
 */
const CHECKPOINT_MEANING: Readonly<Record<string, string>> = {
  SCHEDULED: "Nothing deleted yet",
  ACCESS_REVOKED: "Access closed, files still there",
  ARTIFACTS_DELETED: "Known files gone, storage not swept",
  STORAGE_RECONCILED: "Storage clear, metadata remains",
  METADATA_SCRUBBED: "Finishing",
  COMPLETED: "Done"
};

function flagsFor(run: CleanupRun): string[] {
  const flags: string[] = [];
  if (gaveUp(run)) flags.push("Gave up");
  if (run.overdue) flags.push("Past its deadline");
  return flags;
}

/**
 * Whether customer documents have actually been destroyed.
 *
 * The most important read in the panel. A dead-lettered cleanup means documents
 * that should no longer exist still do, and nothing else in this system will say
 * so on its own — the worker has stopped trying, and the row is waiting for a
 * person. That is why problems are the default view.
 *
 * Laid out like the Print sessions page, because it is the same kind of screen. The three
 * counts that used to sit above the table as a read-only strip are now the
 * filter for it: somebody who has just read "2 gave up" wants those two.
 */
export function RetentionPanel({
  initialFilter
}: {
  initialFilter?: CardId | "ALL" | undefined;
} = {}) {
  // Problems remain the default. Arriving from "deletion pending" is the one
  // case where somebody asked for the whole list instead.
  const [active, setActive] = useState<CardId | null>(
    initialFilter ? (initialFilter === "ALL" ? null : initialFilter) : "PROBLEMS"
  );

  // Pending and the cleared view need rows the problems-only query does not
  // return. The other cards are facets of the server's problem union.
  const problemsOnly = active === "PROBLEMS" || active === "OVERDUE" || active === "GAVE_UP";
  const pages = usePageTrail();
  const cursor = pages.cursor;
  const load = useCallback(
    () => observabilityApi.retention(problemsOnly, cursor),
    [problemsOnly, cursor]
  );
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });
  const nextCursor = state.data?.nextCursor ?? null;
  const canRetry = useSession().can("document.retention.retry");

  const items = state.data?.items ?? [];
  const visible =
    active === "PROBLEMS"
      ? items.filter(hasProblem)
      : active === "GAVE_UP"
        ? items.filter(gaveUp)
        : active === "OVERDUE"
          ? items.filter((run) => run.overdue)
          : active === "PENDING"
            ? items.filter((run) => run.completedAt === null && !gaveUp(run) && !run.overdue)
            : items;

  const totals = state.data?.totals ?? { pending: 0, overdue: 0, deadLettered: 0 };
  // Count the union from the rows once. `deadLettered` and `overdue` are
  // overlapping server totals and must not be added together as if they were
  // distinct cleanup runs.
  const problemRuns = items.filter(hasProblem).length;
  const hasProblems = totals.deadLettered > 0 || totals.overdue > 0;

  const LABELS: Readonly<Record<CardId, string>> = {
    PROBLEMS: "late or stopped",
    OVERDUE: "past their deadline",
    GAVE_UP: "in a stopped-retry state",
    PENDING: "pending and on time"
  };

  const choose = useCallback((card: CardId) => {
    setActive((current) => (current === card ? null : card));
    pages.reset();
  }, []);

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p
            className={`page-head__summary page-head__summary--${
              state.data === null ? "calm" : hasProblems ? "critical" : "calm"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {state.data === null
              ? "Checking what has been deleted…"
              : !hasProblems
                ? "Documents are being destroyed on schedule"
                : "Some document deletions are late or retries have stopped"}
          </p>
          <p className="page-head__meta">
            {visible.length > 0 ? `Showing ${visible.length} runs` : "Nothing to show"}
            {active ? ` · ${LABELS[active]}` : ""}
            {state.data?.scoped ? " · your assigned kiosks" : ""}
            {active ? (
              <button
                type="button"
                className="button-link page-head__clear"
                onClick={() => {
                  setActive(null);
                  pages.reset();
                }}
              >
                Show all
              </button>
            ) : null}
          </p>
        </div>

        <div className="page-head__actions">
          {state.loading && state.data ? (
            <span className="page-head__refreshing" role="status">
              Refreshing…
            </span>
          ) : null}
          <button
            type="button"
            className="button-primary"
            onClick={state.reload}
            disabled={state.loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {state.data ? (
        <KpiRow>
          <FilterKpi
            noun="cleanup runs"
            card="PROBLEMS"
            label="Problems"
            value={problemRuns}
            resting={problemRuns === 0 ? "No problem runs loaded" : "Distinct problem runs loaded"}
            tone={problemRuns > 0 ? "critical" : undefined}
            active={active}
            onChoose={choose}
          />
          {/* These facet counts come from server totals. They may overlap, so
              neither is used as a total for the Problems card or headline. */}
          <FilterKpi
            noun="cleanup runs"
            card="GAVE_UP"
            label="Gave up"
            value={totals.deadLettered}
            resting={
              totals.deadLettered === 0 ? "Nothing has stopped trying" : "Documents are still there"
            }
            tone={totals.deadLettered > 0 ? "critical" : undefined}
            elevated={totals.deadLettered > 0 && active === null}
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="cleanup runs"
            card="OVERDUE"
            label="Overdue"
            value={totals.overdue}
            resting={totals.overdue === 0 ? "Nothing is late" : "May also have stopped retrying"}
            tone={totals.overdue > 0 ? "critical" : undefined}
            elevated={totals.deadLettered === 0 && totals.overdue > 0 && active === null}
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="cleanup runs"
            card="PENDING"
            label="Pending"
            value={totals.pending}
            resting={totals.pending === 0 ? "Nothing waiting to run" : "Scheduled and on time"}
            active={active}
            onChoose={choose}
          />
        </KpiRow>
      ) : null}

      <Panel
        title="Document retention"
        state={state}
        hint="Deletion is a resumable workflow, not a row update. A run that has given up is shown here because the documents are still there."
      >
        {state.data && visible.length === 0 ? (
          <Empty>
            {active ? (
              <>
                No cleanup runs are {LABELS[active]}.{" "}
                <button
                  type="button"
                  className="button-link"
                  onClick={() => {
                    setActive(null);
                    pages.reset();
                  }}
                >
                  Show all runs
                </button>
              </>
            ) : (
              "No cleanup runs recorded."
            )}
          </Empty>
        ) : null}

        {visible.length > 0 ? (
          <Table
            className="data-table"
            pane
            paneClassName="data-pane"
            columns={[
              "Due",
              "Kiosk",
              "Run",
              "How far it got",
              "Attempts",
              "Last error",
              "Print session state",
              ...(canRetry ? ["Retry"] : [])
            ]}
          >
            {visible.map((run) => {
              const flags = flagsFor(run);
              return (
                <tr
                  key={run.sessionId}
                  className={
                    run.overdue || gaveUp(run)
                      ? "is-alarming-row"
                      : run.completedAt
                        ? undefined
                        : "is-quiet-row"
                  }
                >
                  <td data-label="Due">
                    {run.dueAt ? <RowWhen value={run.dueAt} /> : <span className="muted">—</span>}
                  </td>
                  <td data-label="Kiosk">{run.kioskId}</td>
                  <td data-label="Run">
                    <StateBadge
                      value={run.status}
                      humanize
                      quiet={run.status === "DONE" || run.status === "PENDING"}
                    />
                    {flags.length > 0 ? (
                      <span className="row-flags">
                        {flags.map((flag) => (
                          <StatusPill key={flag} tone="critical">
                            {flag}
                          </StatusPill>
                        ))}
                      </span>
                    ) : null}
                  </td>
                  {/* The checkpoint is the answer to "what is still on disk",
                      so it is said rather than left as a constant to decode. */}
                  <td data-label="How far it got">
                    {CHECKPOINT_MEANING[run.checkpoint] ?? humanizeState(run.checkpoint)}
                    <span className="key-list__meta">
                      <code>{run.checkpoint}</code>
                      {run.objectsDeleted > 0 || run.orphanObjectsDeleted > 0 ? (
                        <>
                          {" · "}
                          {run.objectsDeleted + run.orphanObjectsDeleted} objects removed
                        </>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Attempts">{run.attempts}</td>
                  <td data-label="Last error">
                    {run.lastErrorCode ? (
                      <code>{run.lastErrorCode}</code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="Print session state">
                    <StateBadge value={run.sessionState} humanize quiet />
                    <span className="key-list__meta">
                      {run.deadLetteredAt ? (
                        <>
                          Gave up <When value={run.deadLetteredAt} />
                        </>
                      ) : run.completedAt ? (
                        <>
                          Deleted <When value={run.completedAt} />
                        </>
                      ) : null}
                    </span>
                  </td>
                  {canRetry ? (
                    <td data-label="Retry">
                      {gaveUp(run) ? (
                        <RetentionRetryButton
                          sessionId={run.sessionId}
                          onRequested={state.reload}
                        />
                      ) : (
                        <span className="key-list__meta">—</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </Table>
        ) : null}

        <Pagination
          label="Cleanup run pages"
          page={pages.page}
          pageCount={pages.pageCount}
          hasNext={pages.hasNext(nextCursor)}
          onGo={(target) => pages.go(target, nextCursor)}
        />
      </Panel>
    </>
  );
}

/**
 * Asking retention to try a run again.
 *
 * Deliberately not a confirmation dialog. A dead-lettered run means documents
 * that should be gone are still there, and the cost of asking again is one more
 * attempt by a worker that is safe to run three times — so the friction belongs
 * on the reason, which is recorded, rather than on the click.
 *
 * It reports what actually happened: a request was recorded. The worker picks
 * it up on its next pass, and telling somebody their documents were deleted at
 * the moment they pressed a button would be telling them something this panel
 * does not know.
 */
function RetentionRetryButton({
  sessionId,
  onRequested
}: {
  sessionId: string;
  onRequested: () => void;
}) {
  const [asked, setAsked] = useState(false);
  const [reason, setReason] = useState("");

  const action = useAdminAction<{ reason: string }>(
    useCallback(
      async (input) => observabilityApi.retryRetention({ sessionId, reason: input.reason.trim() }),
      [sessionId]
    )
  );

  if (action.state.succeeded) {
    return <span className="key-list__meta">Requested — the worker will pick it up.</span>;
  }

  if (!asked) {
    return (
      <button
        type="button"
        className="button-quiet"
        onClick={(event) => {
          event.stopPropagation();
          setAsked(true);
        }}
      >
        Try again
      </button>
    );
  }

  const trimmed = reason.trim();
  const ready = trimmed.length >= 8 && !action.state.running;

  return (
    <form
      className="inline-form reveal"
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void action.run({ reason }).then((recorded) => {
          if (recorded) onRequested();
        });
      }}
    >
      <input
        type="text"
        value={reason}
        maxLength={280}
        placeholder="Object storage is back."
        aria-label="Why this should be retried"
        onChange={(event) => setReason(event.target.value)}
      />
      <button type="submit" disabled={!ready}>
        {action.state.running ? "Asking…" : "Ask"}
      </button>
      <button type="button" className="button-quiet" onClick={() => setAsked(false)}>
        Cancel
      </button>
      {action.state.error ? (
        <span className="resolve__error" role="alert">
          {action.state.error}
        </span>
      ) : null}
    </form>
  );
}
