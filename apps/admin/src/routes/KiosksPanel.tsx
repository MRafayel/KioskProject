import { useCallback, useState } from "react";

import type { AdminKiosksResponse } from "@printing-kiosk/admin-access";

import { observabilityApi } from "../features/observability/api.js";
import { Empty, Panel, StateBadge, Table, When } from "../features/observability/components.js";
import { FilterKpi, KpiRow, StatusPill } from "../features/observability/surfaces.js";
import { useAdminData } from "../features/observability/useAdminData.js";

type Kiosk = AdminKiosksResponse["items"][number];

/**
 * The tiles above the table.
 *
 * All four filter the loaded rows rather than the server: there is one kiosks
 * endpoint, it returns every kiosk the caller may see, and it takes no filter.
 * So unlike Sessions no tile ever narrows what the others can count, and all
 * four keep showing real numbers whichever one is pressed.
 */
type CardId = "OFFLINE" | "DEGRADED" | "RECOVERY" | "PRINTER" | "ONLINE";

/** A kiosk beyond the degraded heartbeat window, or one that never reported. */
function isOffline(kiosk: Kiosk): boolean {
  return kiosk.liveness === "OFFLINE" || kiosk.liveness === "NEVER_SEEN";
}

function isDegraded(kiosk: Kiosk): boolean {
  return kiosk.liveness === "DEGRADED";
}

/** A printer that is attached but unhappy, or missing where one is expected. */
function printerProblem(kiosk: Kiosk): boolean {
  if (!kiosk.printer) return true;
  return kiosk.printer.health !== "READY" || kiosk.printer.warningCode !== null;
}

const MATCHES: Readonly<Record<CardId, (kiosk: Kiosk) => boolean>> = {
  OFFLINE: isOffline,
  DEGRADED: isDegraded,
  RECOVERY: (kiosk) => kiosk.recoveryRequiredJobs > 0,
  PRINTER: printerProblem,
  ONLINE: (kiosk) => kiosk.liveness === "ONLINE"
};

/** What is wrong with one kiosk, said on the row in words. */
function flagsFor(kiosk: Kiosk): string[] {
  const flags: string[] = [];
  if (kiosk.liveness === "NEVER_SEEN") flags.push("Never reported");
  else if (isOffline(kiosk)) flags.push("Offline");
  else if (isDegraded(kiosk)) flags.push("Heartbeat delayed");
  if (kiosk.recoveryRequiredJobs > 0) flags.push("Recovery-state jobs");
  if (!kiosk.printer) flags.push("No approved printer");
  else if (kiosk.printer.health !== "READY") flags.push("Printer not ready");
  return flags;
}

/**
 * Which kiosks are alive, and what each one is doing.
 *
 * Liveness comes from the heartbeat every authenticated kiosk call writes, so
 * "online" means the device talked to this system recently — not that a poller
 * somewhere believes it should be up.
 *
 * Laid out as Sessions is: the counts worth knowing on top, doubling as the
 * filter for the table beneath them, and a row that needs somebody marking
 * itself and saying why.
 */
export function KiosksPanel({ initialFilter }: { initialFilter?: CardId | undefined } = {}) {
  const load = useCallback(() => observabilityApi.kiosks(), []);
  const state = useAdminData(load, { refreshMilliseconds: 15_000 });
  const [active, setActive] = useState<CardId | null>(initialFilter ?? null);

  const items = state.data?.items ?? [];
  const count = (predicate: (kiosk: Kiosk) => boolean) => items.filter(predicate).length;

  const offline = count(isOffline);
  const degraded = count(isDegraded);
  const recovery = count((kiosk) => kiosk.recoveryRequiredJobs > 0);
  const printers = count(printerProblem);
  const online = count((kiosk) => kiosk.liveness === "ONLINE");

  const visible = active ? items.filter(MATCHES[active]) : items;
  // A recovery-state job can already have a recorded observation; this response
  // cannot distinguish that from an unresolved recovery, so it stays context
  // rather than being counted as work somebody still has to do.
  const attention = visible.filter(
    (kiosk) => isOffline(kiosk) || isDegraded(kiosk) || printerProblem(kiosk)
  ).length;
  const urgent = visible.some((kiosk) => isOffline(kiosk) || printerProblem(kiosk));

  const LABELS: Readonly<Record<CardId, string>> = {
    OFFLINE: "offline or never reported",
    DEGRADED: "with a delayed heartbeat",
    RECOVERY: "with recovery-state print jobs",
    PRINTER: "with a printer problem",
    ONLINE: "online"
  };

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
              state.data === null ? "calm" : attention === 0 ? "calm" : urgent ? "critical" : "busy"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {state.data === null
              ? "Checking the kiosks…"
              : visible.length === 0
                ? active
                  ? `No kiosks ${LABELS[active]}`
                  : "No kiosks are visible to you"
                : attention === 0
                  ? `All ${visible.length} kiosks are online and printing`
                  : `${attention} of these ${visible.length} kiosks need attention`}
          </p>
          <p className="page-head__meta">
            {visible.length > 0 ? `Showing ${visible.length}` : "Nothing to show"}
            {active ? ` · ${LABELS[active]}` : ""}
            {state.data?.scoped ? " · assigned to you" : ""}
            {active ? (
              <button
                type="button"
                className="button-link page-head__clear"
                onClick={() => setActive(null)}
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

      {items.length > 0 ? (
        <KpiRow>
          <FilterKpi
            noun="kiosks"
            card="OFFLINE"
            label="Offline or never seen"
            value={offline}
            resting={offline === 0 ? "No kiosk is offline" : "Offline or has never reported"}
            tone={offline > 0 ? "critical" : undefined}
            elevated={offline > 0 && active === null}
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="kiosks"
            card="DEGRADED"
            label="Degraded"
            value={degraded}
            resting={degraded === 0 ? "No delayed heartbeats" : "Heartbeat delayed 2–10 minutes"}
            tone={degraded > 0 ? "warn" : undefined}
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="kiosks"
            card="RECOVERY"
            label="With recovery-state jobs"
            value={recovery}
            resting={
              recovery === 0 ? "No recovery-state jobs" : "Resolved and unresolved jobs together"
            }
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="kiosks"
            card="PRINTER"
            label="Printer problems"
            value={printers}
            resting={printers === 0 ? "Every printer is ready" : "Not ready, or none approved"}
            tone={printers > 0 ? "warn" : undefined}
            active={active}
            onChoose={choose}
          />
          <FilterKpi
            noun="kiosks"
            card="ONLINE"
            label="Online"
            value={online}
            resting={`of ${items.length} kiosks`}
            active={active}
            onChoose={choose}
          />
        </KpiRow>
      ) : null}

      <Panel
        title="All kiosks"
        state={state}
        emptyMessage="No kiosks to show."
        hint={state.data?.scoped ? "Showing the kiosks assigned to you." : undefined}
      >
        {state.data && visible.length === 0 ? (
          <Empty>
            {active ? (
              <>
                No kiosks are {LABELS[active]}.{" "}
                <button type="button" className="button-link" onClick={() => setActive(null)}>
                  Clear the filter
                </button>
              </>
            ) : (
              "No kiosks are visible to you."
            )}
          </Empty>
        ) : null}

        {visible.length > 0 ? (
          <Table
            className="data-table"
            pane
            paneClassName="data-pane"
            columns={[
              "Kiosk",
              "Status",
              "Agent",
              "USB printer",
              "Active print sessions",
              "Open print jobs",
              "Recovery-state jobs"
            ]}
          >
            {visible.map((kiosk) => {
              const flags = flagsFor(kiosk);
              return (
                <tr
                  key={kiosk.id}
                  className={
                    isOffline(kiosk)
                      ? "is-alarming-row"
                      : printerProblem(kiosk)
                        ? "is-quiet-row"
                        : undefined
                  }
                >
                  <td data-label="Kiosk">
                    <strong>{kiosk.name}</strong>
                    <span className="key-list__meta">{kiosk.publicCode}</span>
                  </td>
                  <td data-label="Status">
                    <StateBadge value={kiosk.status} humanize quiet={kiosk.status === "ACTIVE"} />
                    {flags.length > 0 ? (
                      <span className="row-flags">
                        {flags.map((flag) => (
                          <StatusPill
                            key={flag}
                            tone={
                              flag === "Offline" || flag === "Never reported" ? "critical" : "warn"
                            }
                          >
                            {flag}
                          </StatusPill>
                        ))}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Agent">
                    {kiosk.agent ? (
                      <>
                        <StateBadge
                          value={kiosk.agent.liveness}
                          humanize
                          quiet={kiosk.agent.liveness === "ONLINE"}
                        />
                        <span className="key-list__meta">
                          {kiosk.agent.platform} {kiosk.agent.platformRelease ?? ""} · v
                          {kiosk.agent.version}
                        </span>
                        <span className="key-list__meta">
                          Last heartbeat <When value={kiosk.agent.lastHeartbeatAt} />
                        </span>
                      </>
                    ) : (
                      <StateBadge value="NOT_REGISTERED" humanize />
                    )}
                  </td>
                  <td data-label="USB printer">
                    {kiosk.printer ? (
                      <>
                        <StateBadge
                          value={kiosk.printer.health}
                          humanize
                          quiet={kiosk.printer.health === "READY"}
                        />
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
                      <StateBadge value="NOT_APPROVED" humanize />
                    )}
                  </td>
                  <td data-label="Active print sessions">{kiosk.liveSessions}</td>
                  <td data-label="Open print jobs">{kiosk.openPrintJobs}</td>
                  <td data-label="Recovery-state jobs">
                    {kiosk.recoveryRequiredJobs > 0 ? (
                      <strong className="is-alarming-text">{kiosk.recoveryRequiredJobs}</strong>
                    ) : (
                      0
                    )}
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
