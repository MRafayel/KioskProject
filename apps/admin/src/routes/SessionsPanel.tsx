import { useCallback, useState } from "react";

import { adminSessionStateSchema, type AdminSessionSummary } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Duration,
  Empty,
  Identifier,
  Money,
  Panel,
  StateBadge,
  Table,
  When,
  humanizeState
} from "../features/observability/components.js";
import { Kpi, KpiRow, StatusPill } from "../features/observability/surfaces.js";
import { useAdminData } from "../features/observability/useAdminData.js";

const SESSION_STATES = adminSessionStateSchema.options;

/**
 * The states that mean a person has to look, and the ones that merely ended.
 *
 * `RECOVERY_REQUIRED` and `FAILED` are somebody's job. `CANCELED` and `EXPIRED`
 * are ordinary endings that happen every day — a customer walked away, a
 * session timed out — so they stay visible and stay quiet. Ranking them the
 * same would bury the two that matter under the two that do not.
 */
const NEEDS_SOMEBODY = new Set(["RECOVERY_REQUIRED", "FAILED"]);
const ENDED_EARLY = new Set(["CANCELED", "EXPIRED"]);

/** Workflow statuses that are a problem wherever they appear on a row. */
const BAD_WORKFLOW = new Set(["FAILED", "RECOVERY_REQUIRED", "DEAD_LETTER", "ERROR", "REJECTED"]);

/** A payment that took the customer's money. */
const PAID = new Set(["CAPTURED", "SUCCEEDED", "PAID"]);

type Level = "critical" | "warn" | "none";

interface Assessment {
  level: Level;
  /** Short phrases naming what is wrong, shown on the row itself. */
  flags: string[];
}

/**
 * What is wrong with one session, decided once and used everywhere.
 *
 * The cross-state case is the reason this exists rather than living in the
 * markup. "Payment captured" and "print failed" are two ordinary-looking cells
 * eight columns apart, and the combination — the customer was charged and got
 * nothing — is the single most expensive thing this table can show. Nobody
 * finds it by comparing columns, so the row says it in words.
 */
function assess(item: AdminSessionSummary): Assessment {
  const flags: string[] = [];
  const printBad = item.printJobStatus !== null && BAD_WORKFLOW.has(item.printJobStatus);
  const cleanupBad = BAD_WORKFLOW.has(item.cleanupStatus);
  const paid = item.paymentStatus !== null && PAID.has(item.paymentStatus);

  if (paid && printBad) flags.push("Charged, not printed");
  else if (printBad) flags.push("Print problem");

  // An undeleted document past its deadline is a privacy failure, and outranks
  // everything else this table can show. Same ordering as the overview.
  if (cleanupBad) flags.push("Deletion problem");

  if (NEEDS_SOMEBODY.has(item.state)) {
    return { level: "critical", flags };
  }
  if (flags.length > 0) return { level: "critical", flags };
  if (ENDED_EARLY.has(item.state)) return { level: "warn", flags };
  return { level: "none", flags };
}

/**
 * Sessions, and one session in full.
 *
 * The table is the investigation surface and is deliberately unchanged in what
 * it carries. What changed is what the page says before you reach it: a
 * sentence on whether these sessions are healthy, four counts, and a row that
 * marks itself when something about it needs a person.
 *
 * Every number above the table is counted from the page below it and says so.
 * There is no endpoint that aggregates sessions, and inventing one in the
 * browser by implying these counts cover more than the rows they were counted
 * from would be worse than not having them.
 *
 * The detail view is where the document-privacy rule is most visible: it shows
 * how many files there were, how big, how many pages, and what happened to
 * them — and offers no way to see one, because there is no such endpoint and
 * no grant behind it.
 */
export function SessionsPanel({ initialState }: { initialState?: string | undefined } = {}) {
  const session = useSession();
  // Opening state only; see PrintingPanel for why this is not kept in sync.
  const [state, setState] = useState<string>(initialState ?? "");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string | null>(null);

  const cursor = cursors[cursors.length - 1];
  const load = useCallback(
    () => observabilityApi.sessions({ state: state || undefined, cursor }),
    [state, cursor]
  );
  const list = useAdminData(load, { refreshMilliseconds: 20_000 });

  const items = list.data?.items ?? [];
  const assessments = new Map(items.map((item) => [item.id, assess(item)] as const));
  const count = (predicate: (item: AdminSessionSummary) => boolean) =>
    items.filter(predicate).length;

  const recovery = count((item) => item.state === "RECOVERY_REQUIRED");
  const failed = count((item) => item.state === "FAILED");
  const endedEarly = count((item) => ENDED_EARLY.has(item.state));
  const completed = count((item) => item.state === "COMPLETED");
  const charged = count(
    (item) => assessments.get(item.id)?.flags.includes("Charged, not printed") ?? false
  );
  const attention = items.filter((item) => assessments.get(item.id)?.level === "critical").length;

  const filtered = state !== "";

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p
            className={`page-head__summary page-head__summary--${
              list.data === null ? "calm" : attention === 0 ? "calm" : "critical"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {list.data === null
              ? "Loading recent sessions…"
              : items.length === 0
                ? filtered
                  ? `No sessions in ${humanizeState(state)}`
                  : "No sessions recorded yet"
                : attention === 0
                  ? "Recent sessions are operating normally"
                  : `${attention} of these ${items.length} sessions need attention`}
          </p>
          <p className="page-head__meta">
            {items.length > 0 ? `Showing ${items.length} most recent` : "Nothing to show"}
            {filtered ? ` in ${humanizeState(state)}` : ""}
            {list.data?.scoped ? " · your assigned kiosks" : ""}
            {cursors.length > 1 ? ` · page ${cursors.length}` : ""}
          </p>
        </div>

        <div className="page-head__actions">
          {list.loading && list.data ? (
            <span className="page-head__refreshing" role="status">
              Refreshing…
            </span>
          ) : null}
          <label className="inline-field">
            State
            <select
              value={state}
              onChange={(event) => {
                setState(event.target.value);
                setCursors([undefined]);
              }}
            >
              <option value="">Any</option>
              {SESSION_STATES.map((value) => (
                <option key={value} value={value}>
                  {humanizeState(value)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button-primary"
            onClick={list.reload}
            disabled={list.loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* A refresh that fails keeps the rows that did load and labels them,
          rather than replacing a working table with an error. */}
      {list.error ? (
        <div className="panel__error" role="alert">
          <span className="panel__error-text">
            {list.error}
            {list.data ? " Showing the last rows that loaded." : ""}
          </span>
          <button type="button" onClick={list.reload}>
            Try again
          </button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <KpiRow>
          <Kpi
            label="Recovery required"
            value={recovery}
            foot={recovery === 0 ? "None on this page" : "Waiting for a person"}
            tone={recovery > 0 ? "critical" : undefined}
            elevated={recovery > 0}
          />
          <Kpi
            label="Failed"
            value={failed}
            foot={failed === 0 ? "None on this page" : "Ended in failure"}
            tone={failed > 0 ? "critical" : undefined}
            elevated={recovery === 0 && failed > 0}
          />
          <Kpi
            label="Charged, not printed"
            value={charged}
            foot={charged === 0 ? "No money at risk here" : "Paid and the print did not land"}
            tone={charged > 0 ? "critical" : undefined}
            elevated={recovery === 0 && failed === 0 && charged > 0}
          />
          <Kpi label="Completed" value={completed} foot={`${endedEarly} canceled or expired`} />
        </KpiRow>
      ) : null}

      <Panel
        title="Recent sessions"
        state={list}
        emptyMessage="No sessions to show."
        hint={
          items.length > 0
            ? "Select a row to open the session in full. Counts above are for these rows only."
            : undefined
        }
      >
        {list.data && items.length === 0 ? (
          <Empty>
            {filtered ? (
              <>
                No sessions are in {humanizeState(state)}.{" "}
                <button
                  type="button"
                  className="button-link"
                  onClick={() => {
                    setState("");
                    setCursors([undefined]);
                  }}
                >
                  Clear the filter
                </button>
              </>
            ) : (
              "No sessions have been recorded yet."
            )}
          </Empty>
        ) : null}

        {items.length > 0 ? (
          <>
            <Table
              className="sessions-table"
              columns={[
                "Session",
                "Kiosk",
                "State",
                "Files",
                "Payment",
                "Print",
                "Deletion",
                "Started"
              ]}
            >
              {items.map((item) => {
                const verdict = assessments.get(item.id) ?? { level: "none" as Level, flags: [] };
                const classes = [
                  selected === item.id ? "is-selected" : "",
                  verdict.level === "critical" ? "is-alarming-row" : "",
                  verdict.level === "warn" ? "is-quiet-row" : ""
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <tr
                    key={item.id}
                    className={classes || undefined}
                    onClick={() => setSelected(selected === item.id ? null : item.id)}
                  >
                    <td data-label="Session">
                      <button type="button" className="button-link">
                        <Identifier value={item.id} />
                      </button>
                      {verdict.flags.length > 0 ? (
                        <span className="session-flags">
                          {verdict.flags.map((flag) => (
                            <StatusPill key={flag} tone="critical">
                              {flag}
                            </StatusPill>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Kiosk">{item.kioskId}</td>
                    <td data-label="State">
                      <StateBadge
                        value={item.state}
                        humanize
                        quiet={!NEEDS_SOMEBODY.has(item.state) && !ENDED_EARLY.has(item.state)}
                      />
                    </td>
                    <td data-label="Files">{item.documentCount}</td>
                    <td data-label="Payment">
                      <StateBadge
                        value={item.paymentStatus}
                        humanize
                        quiet={item.paymentStatus !== null && PAID.has(item.paymentStatus)}
                      />
                    </td>
                    <td data-label="Print">
                      <StateBadge
                        value={item.printJobStatus}
                        humanize
                        quiet={
                          item.printJobStatus === "DONE" || item.printJobStatus === "COMPLETED"
                        }
                      />
                    </td>
                    <td data-label="Deletion">
                      <StateBadge
                        value={item.cleanupStatus}
                        humanize
                        quiet={!BAD_WORKFLOW.has(item.cleanupStatus)}
                      />
                    </td>
                    <td data-label="Started">
                      <When value={item.createdAt} />
                    </td>
                  </tr>
                );
              })}
            </Table>

            <div className="panel__actions">
              <button
                type="button"
                disabled={cursors.length === 1}
                onClick={() => setCursors((current) => current.slice(0, -1))}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!list.data?.nextCursor}
                onClick={() =>
                  setCursors((current) => [...current, list.data?.nextCursor ?? undefined])
                }
              >
                Next
              </button>
            </div>
          </>
        ) : null}
      </Panel>

      {selected ? (
        <SessionDetail
          sessionId={selected}
          canSeeTimeline={session.can("session.timeline.read")}
          canSeeDocuments={session.can("document.metadata.read")}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function SessionDetail({
  sessionId,
  canSeeTimeline,
  canSeeDocuments,
  onClose
}: {
  sessionId: string;
  canSeeTimeline: boolean;
  canSeeDocuments: boolean;
  onClose: () => void;
}) {
  const load = useCallback(() => observabilityApi.session(sessionId), [sessionId]);
  const detail = useAdminData(load);

  const loadTimeline = useCallback(() => observabilityApi.timeline(sessionId), [sessionId]);
  const timeline = useAdminData(loadTimeline, { enabled: canSeeTimeline });

  const loadDocuments = useCallback(() => observabilityApi.documents(sessionId), [sessionId]);
  const documents = useAdminData(loadDocuments, { enabled: canSeeDocuments });

  return (
    <Panel
      title="Session detail"
      state={detail}
      actions={
        <button type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      {detail.data ? (
        <>
          <dl className="detail-grid">
            <div>
              <dt>Session</dt>
              <dd>
                <code>{detail.data.session.id}</code>
              </dd>
            </div>
            <div>
              <dt>Kiosk</dt>
              <dd>{detail.data.session.kioskId}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                <StateBadge value={detail.data.session.state} />
              </dd>
            </div>
            <div>
              <dt>Ended because</dt>
              <dd>
                <StateBadge value={detail.data.session.terminalReason} />
              </dd>
            </div>
            <div>
              <dt>Documents deleted</dt>
              <dd>
                <When value={detail.data.session.filesDeletedAt} />
              </dd>
            </div>
            <div>
              <dt>Deletion due</dt>
              <dd>
                <When value={detail.data.session.cleanupDueAt} />
              </dd>
            </div>
          </dl>

          {detail.data.settings ? (
            <>
              <h3>What was configured</h3>
              <p className="panel__status">
                {detail.data.settings.paperSize}, {detail.data.settings.colorMode.toLowerCase()} —{" "}
                {detail.data.settings.selectedPages} pages selected across{" "}
                {detail.data.documents.total} documents, {detail.data.settings.physicalSheets}{" "}
                sheets.
                {detail.data.settings.selectionsRedactedAt
                  ? " Per-document digests have been destroyed by retention."
                  : ""}
              </p>
            </>
          ) : null}

          {detail.data.money ? (
            <>
              <h3>Money</h3>
              <p className="panel__status">
                <Money
                  minor={detail.data.money.totalMinor}
                  currency={detail.data.money.currency}
                  exponent={detail.data.money.currencyExponent}
                />{" "}
                — quote <StateBadge value={detail.data.money.quoteStatus} />, payment{" "}
                <StateBadge value={detail.data.money.paymentStatus} />
                {detail.data.money.refundStatus ? (
                  <>
                    , refund <StateBadge value={detail.data.money.refundStatus} />
                  </>
                ) : null}
                .
              </p>
            </>
          ) : null}

          <h3>Documents</h3>
          <p className="panel__hint">
            Metadata only. The control plane holds no storage credential and no route that returns a
            document, a page image or a filename.
          </p>
          {canSeeDocuments && documents.data ? (
            documents.data.items.length === 0 ? (
              <Empty>Nothing was uploaded.</Empty>
            ) : (
              <Table columns={["#", "Type", "Size", "Pages", "Scan", "State", "Deleted"]}>
                {documents.data.items.map((file) => (
                  <tr key={file.id}>
                    <td>{file.ordinal + 1}</td>
                    <td>{file.detectedMime ?? file.declaredMime ?? "—"}</td>
                    <td>
                      {file.sizeBytes === null ? "—" : `${Math.ceil(file.sizeBytes / 1024)} KB`}
                    </td>
                    <td>{file.pageCount ?? "—"}</td>
                    <td>
                      <StateBadge value={file.malwareScanStatus} />
                    </td>
                    <td>
                      <StateBadge
                        value={file.rejectionCode ?? file.processingErrorCode ?? file.status}
                      />
                    </td>
                    <td>
                      <When value={file.deletedAt} />
                    </td>
                  </tr>
                ))}
              </Table>
            )
          ) : (
            <Empty>
              {canSeeDocuments ? "Loading…" : "Your role cannot see document metadata."}
            </Empty>
          )}

          <h3>Timeline</h3>
          {canSeeTimeline && timeline.data ? (
            <ol className="timeline">
              {timeline.data.items.map((entry) => (
                <li key={entry.sequence}>
                  <code>{entry.type}</code>
                  <span className="key-list__meta">
                    <When value={entry.occurredAt} />
                    {entry.sincePreviousMilliseconds !== null ? (
                      <>
                        {" · +"}
                        <Duration milliseconds={entry.sincePreviousMilliseconds} />
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>{canSeeTimeline ? "Loading…" : "Your role cannot see the timeline."}</Empty>
          )}
        </>
      ) : null}
    </Panel>
  );
}
