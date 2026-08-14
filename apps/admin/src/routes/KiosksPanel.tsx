import { useCallback } from "react";

import { observabilityApi } from "../features/observability/api.js";
import { Empty, Panel, StateBadge, Table, When } from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * Which kiosks are alive, and what each one is doing.
 *
 * Liveness comes from the heartbeat every authenticated kiosk call writes, so
 * "online" means the device talked to this system recently — not that a poller
 * somewhere believes it should be up.
 */
export function KiosksPanel() {
  const load = useCallback(() => observabilityApi.kiosks(), []);
  const state = useAdminData(load, { refreshMilliseconds: 15_000 });

  return (
    <Panel
      title="All kiosks"
      state={state}
      hint={state.data?.scoped ? "Showing the kiosks assigned to you." : undefined}
      actions={
        <button type="button" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      }
    >
      {state.data && state.data.items.length === 0 ? (
        <Empty>No kiosks are visible to you.</Empty>
      ) : null}

      {state.data && state.data.items.length > 0 ? (
        <Table
          columns={[
            "Kiosk",
            "Status",
            "Agent",
            "USB printer",
            "Live sessions",
            "Open jobs",
            "Recovery"
          ]}
        >
          {state.data.items.map((kiosk) => (
            <tr key={kiosk.id}>
              <td>
                <strong>{kiosk.name}</strong>
                <span className="key-list__meta">{kiosk.publicCode}</span>
              </td>
              <td>
                <StateBadge value={kiosk.status} />
              </td>
              <td>
                {kiosk.agent ? (
                  <>
                    <StateBadge value={kiosk.agent.liveness} />
                    <span className="key-list__meta">
                      {kiosk.agent.platform} {kiosk.agent.platformRelease ?? ""} · v
                      {kiosk.agent.version}
                    </span>
                    <span className="key-list__meta">
                      Last heartbeat <When value={kiosk.agent.lastHeartbeatAt} />
                    </span>
                  </>
                ) : (
                  <StateBadge value="NOT_REGISTERED" />
                )}
              </td>
              <td>
                {kiosk.printer ? (
                  <>
                    <StateBadge value={kiosk.printer.health} />
                    <strong>{kiosk.printer.queueName}</strong>
                    <span className="key-list__meta">
                      {kiosk.printer.portName ?? "no port"} ·{" "}
                      {kiosk.printer.driverName ?? "no driver"}
                    </span>
                    {kiosk.printer.warningCode ? (
                      <span className="badge badge--bad">{kiosk.printer.warningCode}</span>
                    ) : null}
                  </>
                ) : (
                  <StateBadge value="NOT_APPROVED" />
                )}
              </td>
              <td>{kiosk.liveSessions}</td>
              <td>{kiosk.openPrintJobs}</td>
              <td>
                {kiosk.recoveryRequiredJobs > 0 ? (
                  <strong className="is-alarming-text">{kiosk.recoveryRequiredJobs}</strong>
                ) : (
                  0
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );
}
