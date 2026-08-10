import { useCallback, useState } from "react";

import { observabilityApi } from "../features/observability/api.js";
import { Empty, Panel, StateBadge, Table, When } from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * Failures, grouped by what broke.
 *
 * Thirty rows of the same code from one kiosk is one problem, and a list makes
 * it look like thirty. Grouping is also what keeps the query bounded.
 *
 * Some subsystems report no kiosk: an upload, a payment or a cleanup failure
 * belongs to a session rather than to a device. Those rows are still filtered
 * to the caller's kiosks; they simply cannot name one.
 */
export function ErrorsPanel() {
  const [windowHours, setWindowHours] = useState(24);
  const load = useCallback(() => observabilityApi.errors(windowHours), [windowHours]);
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });

  return (
    <Panel
      title="Errors"
      state={state}
      hint={state.data?.truncated ? "More distinct failures exist than are shown." : undefined}
      actions={
        <>
          <label className="inline-field">
            Window
            <select
              value={windowHours}
              onChange={(event) => setWindowHours(Number(event.target.value))}
            >
              <option value={1}>1 hour</option>
              <option value={24}>24 hours</option>
              <option value={168}>7 days</option>
            </select>
          </label>
          <button type="button" onClick={state.reload} disabled={state.loading}>
            Refresh
          </button>
        </>
      }
    >
      {state.data && state.data.groups.length === 0 ? (
        <Empty>Nothing failed in this window.</Empty>
      ) : null}

      {state.data && state.data.groups.length > 0 ? (
        <Table columns={["Subsystem", "Code", "Kiosk", "Count", "Last seen"]}>
          {state.data.groups.map((group) => (
            <tr key={`${group.subsystem}:${group.code}:${group.kioskId ?? ""}`}>
              <td>
                <StateBadge value={group.subsystem} tone="neutral" />
              </td>
              <td>
                <code>{group.code}</code>
              </td>
              <td>{group.kioskId ?? <span className="muted">—</span>}</td>
              <td>{group.count}</td>
              <td>
                <When value={group.lastSeenAt} />
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );
}
