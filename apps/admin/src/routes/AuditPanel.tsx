import { useCallback } from "react";

import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Identifier,
  Panel,
  StateBadge,
  Table,
  When
} from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * The record of who did what.
 *
 * The log is append-only in the database — a trigger refuses UPDATE and DELETE
 * — so what is shown here cannot have been edited by anyone, including whoever
 * is reading it. An Operator sees their own actions; a role trusted with the
 * whole log sees everyone's.
 *
 * Metadata passes through an allow-list on the way out. A key that is withheld
 * is named rather than hidden, so an operator chasing an incident can tell the
 * difference between "the system never recorded that" and "this view will not
 * show it".
 */
export function AuditPanel() {
  const load = useCallback(() => observabilityApi.audit(), []);
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });

  return (
    <Panel
      title="Recent activity"
      state={state}
      hint={
        state.data?.scope === "SELF"
          ? "Showing your own actions. The full log is a separate capability."
          : "Append-only. No role in this system can edit or delete an entry."
      }
      actions={
        <button type="button" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      }
    >
      {state.data && state.data.items.length === 0 ? <Empty>No entries.</Empty> : null}

      {state.data && state.data.items.length > 0 ? (
        <Table columns={["When", "Actor", "Action", "Outcome", "Session", "Detail"]}>
          {state.data.items.map((entry) => (
            <tr key={entry.id}>
              <td>
                <When value={entry.occurredAt} />
              </td>
              <td>
                {entry.actorDisplayName ?? entry.actorId}
                <span className="key-list__meta">{entry.actorType}</span>
              </td>
              <td>
                <code>{entry.action}</code>
              </td>
              <td>
                <StateBadge value={entry.outcome} />
              </td>
              <td>
                {entry.sessionId ? (
                  <Identifier value={entry.sessionId} />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {Object.entries(entry.metadata).map(([key, value]) => (
                  <span key={key} className="metadata-chip">
                    {key}: {String(value)}
                  </span>
                ))}
                {entry.redactedKeys.map((key) => (
                  <span
                    key={key}
                    className="metadata-chip metadata-chip--redacted"
                    title="Withheld by the audit viewer's allow-list"
                  >
                    {key}: withheld
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );
}
