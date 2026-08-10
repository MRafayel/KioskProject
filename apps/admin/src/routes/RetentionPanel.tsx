import { useCallback, useState } from "react";

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
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * Whether customer documents have actually been destroyed.
 *
 * The most important read in the panel. A dead-lettered cleanup means documents
 * that should no longer exist still do, and nothing else in this system will say
 * so on its own — the worker has stopped trying, and the row is waiting for a
 * person. That is why the failures are the default view rather than a filter.
 */
export function RetentionPanel() {
  const [problemsOnly, setProblemsOnly] = useState(true);
  const load = useCallback(() => observabilityApi.retention(problemsOnly), [problemsOnly]);
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });

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
                "Gave up"
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
                </tr>
              ))}
            </Table>
          )}
        </>
      ) : null}
    </Panel>
  );
}
