import { useCallback, useState } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Counters,
  Empty,
  Identifier,
  Panel,
  StateBadge,
  Table,
  When
} from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * Whether customer documents have actually been destroyed.
 *
 * The most important read in the panel. A dead-lettered cleanup means documents
 * that should no longer exist still do, and nothing else in this system will say
 * so on its own — the worker has stopped trying, and the row is waiting for a
 * person. That is why the failures are the default view rather than a filter.
 */
export function RetentionPanel({
  initialProblemsOnly
}: { initialProblemsOnly?: boolean | undefined } = {}) {
  // Failures remain the default. Arriving from "deletion pending" is the one
  // case where somebody asked for the whole list instead.
  const [problemsOnly, setProblemsOnly] = useState(initialProblemsOnly ?? true);
  const load = useCallback(() => observabilityApi.retention(problemsOnly), [problemsOnly]);
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });
  const canRetry = useSession().can("document.retention.retry");

  return (
    <Panel
      title="Document retention"
      state={state}
      hint="Deletion is a resumable workflow, not a row update. A run that has given up is shown here because the documents are still there."
      actions={
        <>
          <label className="inline-field">
            <input
              type="checkbox"
              checked={problemsOnly}
              onChange={(event) => setProblemsOnly(event.target.checked)}
            />
            Problems only
          </label>
          <button type="button" onClick={state.reload} disabled={state.loading}>
            Refresh
          </button>
        </>
      }
    >
      {state.data ? (
        <>
          <Counters
            items={[
              { label: "Pending", value: state.data.totals.pending },
              { label: "Overdue", value: state.data.totals.overdue, alarming: true },
              { label: "Gave up", value: state.data.totals.deadLettered, alarming: true }
            ]}
          />

          {state.data.items.length === 0 ? (
            <Empty>
              {problemsOnly
                ? "No deletion is overdue or stuck. Documents are being destroyed on schedule."
                : "No cleanup runs recorded."}
            </Empty>
          ) : (
            <Table
              columns={[
                "Session",
                "Kiosk",
                "Session state",
                "Run",
                "Checkpoint",
                "Attempts",
                "Last error",
                "Due",
                "Gave up",
                ...(canRetry ? ["Retry"] : [])
              ]}
            >
              {state.data.items.map((run) => (
                <tr key={run.sessionId} className={run.overdue ? "is-alarming-row" : undefined}>
                  <td>
                    <Identifier value={run.sessionId} />
                  </td>
                  <td>{run.kioskId}</td>
                  <td>
                    <StateBadge value={run.sessionState} />
                  </td>
                  <td>
                    <StateBadge value={run.status} />
                  </td>
                  <td>
                    <code>{run.checkpoint}</code>
                  </td>
                  <td>{run.attempts}</td>
                  <td>{run.lastErrorCode ?? "—"}</td>
                  <td>
                    <When value={run.dueAt} />
                  </td>
                  <td>
                    <When value={run.deadLetteredAt} />
                  </td>
                  {canRetry ? (
                    <td>
                      {run.status === "DEAD_LETTER" ? (
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
              ))}
            </Table>
          )}
        </>
      ) : null}
    </Panel>
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
      <button type="button" className="button-quiet" onClick={() => setAsked(true)}>
        Try again
      </button>
    );
  }

  const trimmed = reason.trim();
  const ready = trimmed.length >= 8 && !action.state.running;

  return (
    <form
      className="inline-form"
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
      {action.state.error ? (
        <span className="resolve__error" role="alert">
          {action.state.error}
        </span>
      ) : null}
    </form>
  );
}
