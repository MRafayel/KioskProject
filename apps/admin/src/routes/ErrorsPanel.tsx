import { useCallback, useState } from "react";

import {
  incidentKey,
  ADMIN_ERROR_SUBSYSTEMS,
  type AdminErrorsResponse
} from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Panel,
  RowWhen,
  StateBadge,
  Table,
  When,
  humanizeState
} from "../features/observability/components.js";
import { FilterKpi, Kpi, KpiRow, StatusPill } from "../features/observability/surfaces.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";

type Group = AdminErrorsResponse["groups"][number];

/**
 * The tiles above the table.
 *
 * All three filter the loaded groups rather than the server: the errors
 * endpoint takes a time window and nothing else, so no tile can narrow what the
 * others count and all three keep showing real numbers whichever is pressed.
 *
 * `UNCLAIMED` is the worklist — a failure nobody has said they are handling —
 * and `RECURRED` is the one that undoes the reassurance of the other: somebody
 * claimed it, and it has happened again since.
 */
type CardId = "UNCLAIMED" | "RECURRED" | "REPEATED";

const MATCHES: Readonly<Record<CardId, (group: Group) => boolean>> = {
  UNCLAIMED: (group) => group.acknowledgedAt === null,
  RECURRED: (group) => group.recurredSinceAcknowledgement,
  REPEATED: (group) => group.count >= 5
};

function flagsFor(group: Group): string[] {
  const flags: string[] = [];
  if (group.recurredSinceAcknowledgement) flags.push("Happened again since");
  else if (group.acknowledgedAt === null) flags.push("Nobody on it");
  return flags;
}

/**
 * Error occurrences, grouped by what broke.
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
  const [subsystem, setSubsystem] = useState("");
  const [active, setActive] = useState<CardId | null>(null);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  const load = useCallback(() => observabilityApi.errors(windowHours), [windowHours]);
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });
  const canAcknowledge = session.can("incident.acknowledge");

  const groups = state.data?.groups ?? [];
  const count = (predicate: (group: Group) => boolean) => groups.filter(predicate).length;

  const unclaimed = count(MATCHES.UNCLAIMED);
  const recurred = count(MATCHES.RECURRED);
  const repeated = count(MATCHES.REPEATED);
  const occurrences = groups.reduce((total, group) => total + group.count, 0);

  const visible = groups
    .filter((group) => (active ? MATCHES[active](group) : true))
    .filter((group) => (subsystem ? group.subsystem === subsystem : true));

  const LABELS: Readonly<Record<CardId, string>> = {
    UNCLAIMED: "nobody has claimed",
    RECURRED: "that came back after being claimed",
    REPEATED: "that happened five times or more"
  };

  const filtered = active !== null || subsystem !== "";
  const clearFilter = useCallback(() => {
    setActive(null);
    setSubsystem("");
  }, []);

  const choose = useCallback(
    (card: CardId) => setActive((current) => (current === card ? null : card)),
    []
  );

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p
            className={`page-head__summary page-head__summary--${
              state.data === null ? "calm" : unclaimed + recurred === 0 ? "calm" : "critical"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {state.data === null
              ? "Looking for errors…"
              : groups.length === 0
                ? "No errors in this window"
                : unclaimed + recurred === 0
                  ? "Every error group in this window has somebody on it"
                  : `${unclaimed + recurred} error groups need somebody`}
          </p>
          <p className="page-head__meta">
            {visible.length > 0
              ? `${visible.length} error groups · ${occurrences} occurrences`
              : "Nothing to show"}
            {active ? ` · ${LABELS[active]}` : ""}
            {subsystem ? ` · ${humanizeState(subsystem)}` : ""}
            {state.data?.truncated ? " · more distinct error patterns exist than are shown" : ""}
            {filtered ? (
              <button type="button" className="button-link page-head__clear" onClick={clearFilter}>
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
          <label className="inline-field">
            Subsystem
            <select value={subsystem} onChange={(event) => setSubsystem(event.target.value)}>
              <option value="">Any</option>
              {ADMIN_ERROR_SUBSYSTEMS.map((value) => (
                <option key={value} value={value}>
                  {humanizeState(value)}
                </option>
              ))}
            </select>
          </label>
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

      {groups.length > 0 ? (
        <KpiRow>
          <FilterKpi
            noun="error groups"
            card="UNCLAIMED"
            label="Nobody on it"
            value={unclaimed}
            resting={
              unclaimed === 0 ? "Every group is claimed" : "No one has said they are looking"
            }
            tone={unclaimed > 0 ? "critical" : undefined}
            elevated={unclaimed > 0 && active === null}
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="error groups"
            card="RECURRED"
            label="Came back"
            value={recurred}
            resting={
              recurred === 0 ? "Nothing has recurred" : "Claimed, and it happened again since"
            }
            tone={recurred > 0 ? "critical" : undefined}
            elevated={unclaimed === 0 && recurred > 0 && active === null}
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="error groups"
            card="REPEATED"
            label="Five or more"
            value={repeated}
            resting={repeated === 0 ? "Nothing is repeating hard" : "The same thing, many times"}
            tone={repeated > 0 ? "warn" : undefined}
            active={active}
            onChoose={choose}
          />
          {/* Not a filter: "all occurrences" is the unfiltered view, and a tile
              that filtered to everything would be a button that does nothing
              three times out of four. It stays a readout. */}
          <Kpi
            label="Error occurrences"
            value={occurrences}
            foot={`across ${groups.length} error groups`}
          />
        </KpiRow>
      ) : null}

      <Panel
        title="Error groups"
        state={state}
        emptyMessage="No errors in this window."
        hint={
          groups.length > 0
            ? "One row is one error pattern, however many times it occurred."
            : undefined
        }
      >
        {state.data && visible.length === 0 ? (
          <Empty>
            {filtered ? (
              <>
                No error groups match that filter.{" "}
                <button type="button" className="button-link" onClick={clearFilter}>
                  Clear the filter
                </button>
              </>
            ) : (
              "No errors in this window."
            )}
          </Empty>
        ) : null}

        {visible.length > 0 ? (
          <Table
            className="data-table"
            pane
            paneClassName="data-pane"
            columns={["Last seen", "Subsystem", "Code", "Kiosk", "Occurrences", "Being handled"]}
          >
            {visible.map((group) => {
              const key = incidentKey(group);
              const flags = flagsFor(group);
              return (
                <tr
                  key={key}
                  className={
                    group.recurredSinceAcknowledgement
                      ? "is-alarming-row"
                      : group.acknowledgedAt === null
                        ? "is-quiet-row"
                        : undefined
                  }
                >
                  <td data-label="Last seen">
                    <RowWhen value={group.lastSeenAt} />
                  </td>
                  <td data-label="Subsystem">
                    <StateBadge value={group.subsystem} tone="neutral" humanize />
                  </td>
                  <td data-label="Code">
                    <code>{group.code}</code>
                    {flags.length > 0 ? (
                      <span className="row-flags">
                        {flags.map((flag) => (
                          <StatusPill
                            key={flag}
                            tone={flag === "Nobody on it" ? "warn" : "critical"}
                          >
                            {flag}
                          </StatusPill>
                        ))}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Kiosk">{group.kioskId ?? <span className="muted">—</span>}</td>
                  <td data-label="Occurrences">{group.count}</td>
                  <td data-label="Being handled">
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
    </>
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
  group: Group;
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
        className="acknowledge reveal"
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
        <button type="button" className="button-quiet" onClick={onOpen}>
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
