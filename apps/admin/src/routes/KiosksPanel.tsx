import { useCallback, useState } from "react";

import type {
  AddKioskPaperBody,
  AdminKiosksResponse,
  CorrectKioskPaperBody,
  PaperEstimateStatus
} from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import { Empty, Panel, StateBadge, Table, When } from "../features/observability/components.js";
import {
  FilterKpi,
  KpiRow,
  RowOpen,
  Sheet,
  StatusPill
} from "../features/observability/surfaces.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { useDetailSheet } from "../features/observability/useDetailSheet.js";

type Kiosk = AdminKiosksResponse["items"][number];

/**
 * The tiles above the table.
 *
 * All six filter the loaded rows rather than the server: there is one kiosks
 * endpoint, it returns every kiosk the caller may see, and it takes no filter.
 * So unlike Sessions no tile ever narrows what the others can count, and all
 * six keep showing real numbers whichever one is pressed.
 */
type CardId = "OFFLINE" | "DEGRADED" | "RECOVERY" | "PRINTER" | "PAPER" | "ONLINE";

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

function paperIsLow(kiosk: Kiosk): boolean {
  return kiosk.paper.status === "GETTING_LOW" || kiosk.paper.status === "REFILL_SOON";
}

const MATCHES: Readonly<Record<CardId, (kiosk: Kiosk) => boolean>> = {
  OFFLINE: isOffline,
  DEGRADED: isDegraded,
  RECOVERY: (kiosk) => kiosk.recoveryRequiredJobs > 0,
  PRINTER: printerProblem,
  PAPER: paperIsLow,
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
  if (kiosk.paper.status === "REFILL_SOON") flags.push("Refill paper soon");
  else if (kiosk.paper.status === "GETTING_LOW") flags.push("Paper getting low");
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
  const session = useSession();
  const load = useCallback(() => observabilityApi.kiosks(), []);
  const state = useAdminData(load, { refreshMilliseconds: 15_000 });
  const [active, setActive] = useState<CardId | null>(initialFilter ?? null);
  const sheet = useDetailSheet();

  const items = state.data?.items ?? [];
  const count = (predicate: (kiosk: Kiosk) => boolean) => items.filter(predicate).length;

  const offline = count(isOffline);
  const degraded = count(isDegraded);
  const recovery = count((kiosk) => kiosk.recoveryRequiredJobs > 0);
  const printers = count(printerProblem);
  const lowPaper = count(paperIsLow);
  const online = count((kiosk) => kiosk.liveness === "ONLINE");

  const visible = active ? items.filter(MATCHES[active]) : items;
  // A recovery-state job can already have a recorded observation; this response
  // cannot distinguish that from an unresolved recovery, so it stays context
  // rather than being counted as work somebody still has to do.
  const attention = visible.filter(
    (kiosk) => isOffline(kiosk) || isDegraded(kiosk) || printerProblem(kiosk) || paperIsLow(kiosk)
  ).length;
  const urgent = visible.some(
    (kiosk) => isOffline(kiosk) || printerProblem(kiosk) || kiosk.paper.status === "REFILL_SOON"
  );

  const LABELS: Readonly<Record<CardId, string>> = {
    OFFLINE: "offline or never reported",
    DEGRADED: "with a delayed heartbeat",
    RECOVERY: "with recovery-state print jobs",
    PRINTER: "with a printer problem",
    PAPER: "with a low paper estimate",
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
            card="PAPER"
            label="Low paper estimate"
            value={lowPaper}
            resting={lowPaper === 0 ? "No tracked kiosk is low" : "At or below 100 sheets"}
            tone={lowPaper > 0 ? "warn" : undefined}
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
            className="data-table data-table--interactive"
            pane
            paneClassName="data-pane"
            columns={[
              "Kiosk",
              "Status",
              "Agent",
              "USB printer",
              "Paper estimate",
              "Active print sessions",
              "Open print jobs",
              "Recovery-state jobs"
            ]}
          >
            {visible.map((kiosk) => {
              const flags = flagsFor(kiosk);
              const classes = [
                sheet.selected === kiosk.id ? "is-selected" : "",
                isOffline(kiosk) ? "is-alarming-row" : "",
                !isOffline(kiosk) && (printerProblem(kiosk) || kiosk.paper.status === "REFILL_SOON")
                  ? "is-quiet-row"
                  : ""
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <tr
                  key={kiosk.id}
                  className={classes || undefined}
                  onClick={(event) =>
                    sheet.open(
                      kiosk.id,
                      event.currentTarget.querySelector<HTMLButtonElement>(".row-open")
                    )
                  }
                >
                  <td data-label="Kiosk">
                    <RowOpen
                      open={sheet.selected === kiosk.id}
                      onOpen={(opener) => sheet.open(kiosk.id, opener)}
                      label={`Open ${kiosk.name}, ${paperStatusLabel(
                        kiosk.paper.status
                      ).toLowerCase()}`}
                    >
                      <strong>{kiosk.name}</strong>
                      <span className="key-list__meta">{kiosk.publicCode}</span>
                    </RowOpen>
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
                  <td data-label="Paper estimate">
                    <PaperEstimate summary={kiosk.paper} />
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

      {sheet.selected ? (
        <KioskPaperSheet
          kiosk={items.find((kiosk) => kiosk.id === sheet.selected) ?? null}
          canManage={session.can("kiosk.paper.manage")}
          onChanged={state.reload}
          onClose={sheet.close}
        />
      ) : null}
    </>
  );
}

function PaperEstimate({ summary }: { summary: Kiosk["paper"] }) {
  return (
    <span className="paper-estimate">
      <strong>
        {summary.estimatedSheets === null
          ? "Estimate unavailable"
          : `~${summary.estimatedSheets.toLocaleString()} sheets`}
      </strong>
      <StatusPill tone={paperStatusTone(summary.status)}>
        {paperStatusLabel(summary.status)}
      </StatusPill>
    </span>
  );
}

function KioskPaperSheet({
  kiosk,
  canManage,
  onChanged,
  onClose
}: {
  kiosk: Kiosk | null;
  canManage: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const kioskId = kiosk?.id ?? "";
  const load = useCallback(() => observabilityApi.kioskPaper(kioskId), [kioskId]);
  const detail = useAdminData(load);
  const paper = detail.data?.paper ?? kiosk?.paper ?? null;

  const changed = useCallback(() => {
    detail.reload();
    onChanged();
  }, [detail, onChanged]);

  return (
    <Sheet
      title={kiosk?.name ?? "Kiosk paper"}
      subtitle={
        kiosk ? (
          <>
            <span>{kiosk.publicCode}</span>
            <span aria-hidden="true">·</span>
            <StateBadge value={kiosk.liveness} humanize quiet={kiosk.liveness === "ONLINE"} />
          </>
        ) : (
          <span>Loading…</span>
        )
      }
      onClose={onClose}
    >
      {detail.error ? (
        <div className="panel__error" role="alert">
          <span className="panel__error-text">{detail.error}</span>
          <button type="button" onClick={detail.reload}>
            Try again
          </button>
        </div>
      ) : null}

      {paper ? (
        <section className="paper-summary" aria-labelledby="paper-estimate-title">
          <div>
            <h3 id="paper-estimate-title">Paper estimate</h3>
            <p className="paper-summary__value">
              {paper.estimatedSheets === null
                ? "Estimate unavailable"
                : `~${paper.estimatedSheets.toLocaleString()} sheets remaining`}
            </p>
            <StatusPill tone={paperStatusTone(paper.status)}>
              {paperStatusLabel(paper.status)}
            </StatusPill>
          </div>
          <p className="paper-summary__note">
            Software estimate only — this printer has no paper-level sensor. Confirmed physical
            sheets are deducted automatically. This is the current count, not a running total: every
            refill, correction and print writes it directly, and who changed it is recorded in the
            audit log.
          </p>
          <dl className="detail-grid">
            <div>
              <dt>Last paper refill</dt>
              <dd>
                {paper.lastRefill ? (
                  <>
                    <strong>+{paper.lastRefill.sheetsAdded.toLocaleString()} sheets</strong>
                    <span className="key-list__meta">
                      {paper.lastRefill.recordedByDisplayName ?? "Admin user"} ·{" "}
                      <When value={paper.lastRefill.recordedAt} />
                    </span>
                    {paper.lastRefill.note ? (
                      <span className="key-list__meta">{paper.lastRefill.note}</span>
                    ) : null}
                  </>
                ) : (
                  "No refill recorded"
                )}
              </dd>
            </div>
            <div>
              <dt>Low-paper guidance</dt>
              <dd>
                Getting low at {paper.gettingLowAtSheets} sheets · refill soon at{" "}
                {paper.refillSoonAtSheets}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {canManage && paper ? (
        <PaperActions
          kioskId={kioskId}
          estimatedSheets={paper.estimatedSheets}
          onChanged={changed}
        />
      ) : null}

      {detail.loading && !detail.data ? <p className="panel__status">Loading…</p> : null}
    </Sheet>
  );
}

function PaperActions({
  kioskId,
  estimatedSheets,
  onChanged
}: {
  kioskId: string;
  estimatedSheets: number | null;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"REFILL" | "CORRECTION" | null>(null);
  const [sheets, setSheets] = useState("");
  const [note, setNote] = useState("");
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [message, setMessage] = useState<string | null>(null);

  const refill = useAdminAction<AddKioskPaperBody>(
    useCallback((body) => observabilityApi.addKioskPaper(kioskId, body), [kioskId])
  );
  const correction = useAdminAction<CorrectKioskPaperBody>(
    useCallback((body) => observabilityApi.correctKioskPaper(kioskId, body), [kioskId])
  );

  const action = mode === "CORRECTION" ? correction : refill;
  const parsed = Number(sheets);
  const numberValid =
    Number.isInteger(parsed) && parsed >= (mode === "REFILL" ? 1 : 0) && parsed <= 100_000;
  const trimmed = note.trim();
  const noteValid =
    mode === "CORRECTION" ? trimmed.length >= 3 : trimmed.length === 0 || trimmed.length >= 3;
  const ready = mode !== null && numberValid && noteValid && !action.state.running;

  const edit = (value: string, setValue: (next: string) => void) => {
    setValue(value);
    setRequestKey(newRequestKey());
    setMessage(null);
    refill.reset();
    correction.reset();
  };

  const closeForm = () => {
    setMode(null);
    setSheets("");
    setNote("");
    setRequestKey(newRequestKey());
    refill.reset();
    correction.reset();
  };

  return (
    <section className="paper-actions" aria-labelledby="paper-actions-title">
      <h3 id="paper-actions-title">Update estimate</h3>
      {mode === null ? (
        <div className="paper-actions__choices">
          <button
            type="button"
            className="button-primary"
            onClick={() => {
              setMode("REFILL");
              setSheets("");
              setNote("");
              setMessage(null);
            }}
          >
            Add paper
          </button>
          <button
            type="button"
            className="button-quiet"
            onClick={() => {
              setMode("CORRECTION");
              setSheets(String(estimatedSheets ?? 0));
              setNote("");
              setMessage(null);
            }}
          >
            Correct estimate
          </button>
          {message ? (
            <span className="paper-actions__success" role="status">
              {message}
            </span>
          ) : null}
        </div>
      ) : (
        <form
          className="resolve paper-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            const run =
              mode === "REFILL"
                ? refill.run({
                    sheetsAdded: parsed,
                    ...(trimmed ? { note: trimmed } : {}),
                    requestKey
                  })
                : correction.run({ estimatedSheets: parsed, reason: trimmed, requestKey });
            void run.then((recorded) => {
              if (!recorded) return;
              const success =
                mode === "REFILL"
                  ? `Added ${parsed.toLocaleString()} sheets to the estimate.`
                  : `Corrected the estimate to ${parsed.toLocaleString()} sheets.`;
              closeForm();
              setMessage(success);
              onChanged();
            });
          }}
        >
          <h3>{mode === "REFILL" ? "Add paper" : "Correct paper estimate"}</h3>
          <label className="resolve__field">
            {mode === "REFILL" ? "Physical sheets loaded" : "Estimated sheets remaining"}
            <input
              type="number"
              min={mode === "REFILL" ? 1 : 0}
              max={100_000}
              step={1}
              required
              value={sheets}
              onChange={(event) => edit(event.target.value, setSheets)}
            />
          </label>
          <label className="resolve__field">
            {mode === "REFILL" ? (
              <>
                Note <span className="resolve__optional">(optional)</span>
              </>
            ) : (
              "Reason for correction"
            )}
            <textarea
              rows={2}
              maxLength={280}
              required={mode === "CORRECTION"}
              value={note}
              onChange={(event) => edit(event.target.value, setNote)}
              placeholder={
                mode === "REFILL" ? "New ream loaded" : "Counted the tray after clearing a jam"
              }
            />
          </label>
          <p className="resolve__optional">
            {mode === "REFILL"
              ? "This increases the current estimate and keeps a permanent refill record."
              : "This sets the estimate to the number entered; earlier activity remains in history."}
          </p>
          {action.state.error ? (
            <p className="resolve__error" role="alert">
              {action.state.error}
            </p>
          ) : null}
          <div className="resolve__actions">
            <button type="submit" disabled={!ready}>
              {action.state.running
                ? "Recording…"
                : mode === "REFILL"
                  ? "Add to estimate"
                  : "Correct estimate"}
            </button>
            <button type="button" className="button-quiet" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function paperStatusLabel(status: PaperEstimateStatus): string {
  if (status === "HEALTHY") return "Healthy";
  if (status === "GETTING_LOW") return "Getting low";
  if (status === "REFILL_SOON") return "Refill soon";
  return "Estimate unavailable";
}

function paperStatusTone(status: PaperEstimateStatus): "neutral" | "good" | "warn" | "critical" {
  if (status === "HEALTHY") return "good";
  if (status === "GETTING_LOW") return "warn";
  if (status === "REFILL_SOON") return "critical";
  return "neutral";
}

function newRequestKey(): string {
  return globalThis.crypto.randomUUID();
}
