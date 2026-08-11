import { useCallback, useState } from "react";

import { incidentKey, type AdminErrorsResponse } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import { Empty, Panel, StateBadge, Table, When } from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * Failures, grouped by what broke.
 *
 * Thirty rows of the same code from one kiosk is one problem, and a list makes
 * it look like thirty. Grouping is also what keeps the query bounded.
 *
 * Some subsystems report no kiosk: an upload, a payment or a cleanup failure
 * belongs to a session rather than to a device. Those rows are still filtered
 * to the caller's kiosks; they simply cannot name one — and an Operator, whose
 * view is scoped to devices, cannot acknowledge one for that reason.
 */
export function ErrorsPanel() {
  const session = useSession();
  const [windowHours, setWindowHours] = useState(24);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  const load = useCallback(() => observabilityApi.errors(windowHours), [windowHours]);
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });
  const canAcknowledge = session.can("incident.acknowledge");

  return (
    <Panel
      title="Failure groups"
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
        <Table columns={["Subsystem", "Code", "Kiosk", "Count", "Last seen", "Being handled"]}>
          {state.data.groups.map((group) => {
            const key = incidentKey(group);
            return (
              <tr key={key}>
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
                <td>
                  <Acknowledgement
                    group={group}
                    canAcknowledge={canAcknowledge}
                    open={acknowledging === key}
                    onOpen={() => setAcknowledging(acknowledging === key ? null : key)}
                    onDone={() => {
                      setAcknowledging(null);
                      state.reload();
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </Table>
      ) : null}
    </Panel>
  );
}

/**
 * Who is on this, and a way to say it is you.
 *
 * Acknowledging clears nothing and fixes nothing — it exists so two operators
 * do not both walk to the same kiosk. It is therefore drawn as a note rather
 * than as a resolution, and a failure that has happened again since somebody
 * claimed it says so, because that is the case where "somebody is on it" stops
 * being reassuring.
 */
function Acknowledgement({
  group,
  canAcknowledge,
  open,
  onOpen,
  onDone
}: {
  group: AdminErrorsResponse["groups"][number];
  canAcknowledge: boolean;
  open: boolean;
  onOpen: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const action = useAdminAction<string>(
    useCallback(
      async (note: string) =>
        observabilityApi.acknowledgeIncident({
          subsystem: group.subsystem,
          code: group.code,
          kioskId: group.kioskId,
          reason: note.trim()
        }),
      [group.subsystem, group.code, group.kioskId]
    )
  );

  if (open) {
    return (
      <form
        className="acknowledge"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim().length < 8 || action.state.running) return;
          void action.run(reason).then((recorded) => {
            if (recorded) onDone();
          });
        }}
      >
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={280}
          placeholder="Walking over to check the paper path."
          aria-label={`Why you are handling ${group.code}`}
        />
        <button type="submit" disabled={reason.trim().length < 8 || action.state.running}>
          {action.state.running ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onOpen}>
          Cancel
        </button>
        {action.state.error ? (
          <span className="acknowledge__error" role="alert">
            {action.state.error}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <div className="acknowledge">
      {group.acknowledgedAt ? (
        <span className="acknowledge__by">
          {group.acknowledgedBy ?? "Someone"} &middot; <When value={group.acknowledgedAt} />
          {group.recurredSinceAcknowledgement ? (
            <span className="badge badge--bad">happened again since</span>
          ) : null}
        </span>
      ) : (
        <span className="muted">—</span>
      )}
      {canAcknowledge ? (
        <button type="button" className="button-link" onClick={onOpen}>
          {group.acknowledgedAt ? "I have it now" : "I am on it"}
        </button>
      ) : null}
    </div>
  );
}
