import { useCallback, useState } from "react";

import { adminSessionStateSchema, type AdminSessionSummary } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Duration,
  Empty,
  Money,
  Pagination,
  Panel,
  RowWhen,
  StateBadge,
  Table,
  When,
  humanizeState
} from "../features/observability/components.js";
import {
  FilterKpi,
  KpiRow,
  RowOpen,
  Sheet,
  StatusPill
} from "../features/observability/surfaces.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { usePageTrail } from "../features/observability/usePageTrail.js";
import { useDetailSheet } from "../features/observability/useDetailSheet.js";

const SESSION_STATES = adminSessionStateSchema.options;

/**
 * The states that mean a person has to look, and the ones that merely ended.
 *
 * `RECOVERY_REQUIRED` and `FAILED` are somebody's job. `CANCELED` and `EXPIRED`
 * are ordinary endings that happen every day — a customer walked away, a
 * session timed out — so they stay visible and stay quiet. Ranking them the
 * same would bury the two that matter under the two that do not.
 */
const NEEDS_REVIEW = new Set(["RECOVERY_REQUIRED", "FAILED"]);
const ENDED_EARLY = new Set(["CANCELED", "EXPIRED"]);

/** Workflow statuses that are a problem wherever they appear on a row. */
const BAD_WORKFLOW = new Set(["FAILED", "RECOVERY_REQUIRED", "DEAD_LETTER", "ERROR", "REJECTED"]);

/** A payment that took the customer's money. */
const PAID = new Set(["CAPTURED", "SUCCEEDED", "PAID"]);

/** The verdict the "Charged, not printed" tile filters on. */
const CHARGED_NOT_PRINTED = "Charged, not printed";

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
 * four columns apart, and the combination — the customer was charged and got
 * nothing — is the single most expensive thing this table can show. Nobody
 * finds it by comparing columns, so the row says it in words.
 */
function assess(item: AdminSessionSummary): Assessment {
  const flags: string[] = [];
  const printBad = item.printJobStatus !== null && BAD_WORKFLOW.has(item.printJobStatus);
  const cleanupBad = BAD_WORKFLOW.has(item.cleanupStatus);
  const paid = item.paymentStatus !== null && PAID.has(item.paymentStatus);

  if (paid && printBad) flags.push(CHARGED_NOT_PRINTED);
  else if (printBad) flags.push("Print problem");

  // An undeleted document past its deadline is a privacy failure, and outranks
  // everything else this table can show. Same ordering as the overview.
  if (cleanupBad) flags.push("Deletion problem");

  if (NEEDS_REVIEW.has(item.state)) {
    return { level: "critical", flags };
  }
  if (flags.length > 0) return { level: "critical", flags };
  if (ENDED_EARLY.has(item.state)) return { level: "warn", flags };
  return { level: "none", flags };
}

function isChargedNotPrinted(item: AdminSessionSummary): boolean {
  return assess(item).flags.includes(CHARGED_NOT_PRINTED);
}

/**
 * The four tiles above the table, and what each one filters to.
 *
 * Three of them are session states and go to the server, which is what makes
 * them worth clicking: filtering to `FAILED` pages through every failed session
 * there is, not the failed ones that happened to land on this page. The fourth
 * is a verdict this file computes from two columns, no endpoint knows about it,
 * and it can only ever narrow the rows already loaded — so it is marked as the
 * different kind of thing it is rather than dressed up as the same one.
 */
type CardId = "RECOVERY_REQUIRED" | "FAILED" | "CHARGED" | "COMPLETED";

/** The three tiles whose filter is a session state the server understands. */
const STATE_CARDS = new Set<string>(["RECOVERY_REQUIRED", "FAILED", "COMPLETED"]);

/**
 * Which tile, if any, the current filter belongs to.
 *
 * The dropdown reaches states no tile stands for — `AWAITING_PAYMENT` is a
 * perfectly good filter and has no card — so this returns null for those. The
 * page is still filtered; it is just not filtered by anything up there, and
 * pressing a tile that does not correspond to the filter would say otherwise.
 */
function activeCard(state: string, chargedOnly: boolean): CardId | null {
  if (chargedOnly) return "CHARGED";
  return STATE_CARDS.has(state) ? (state as CardId) : null;
}

/**
 * Sessions, and one session in full.
 *
 * The table is the investigation surface. What sits above it is the same four
 * counts as before, promoted from readouts into the filter controls for the
 * rows beneath them — a number worth printing is a number worth clicking, and
 * an operator who has just read "4 need recovery" wants those four, not a
 * dropdown two controls away that would have got them there.
 *
 * Every number above the table is counted from the page below it and says so.
 * There is no endpoint that aggregates sessions, and inventing one in the
 * browser by implying these counts cover more than the rows they were counted
 * from would be worse than not having them. That is also why a tile whose count
 * has been narrowed by somebody else's filter shows a dash instead of a number:
 * "0 failed" and "we did not ask about failures" are different statements, and
 * only one of them is true while the page is filtered to something else.
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
  /** The client-side verdict filter. Never on at the same time as `state`. */
  const [chargedOnly, setChargedOnly] = useState(false);

  const sheet = useDetailSheet();
  const selected = sheet.selected;
  const rowClick = (id: string) => (event: { currentTarget: HTMLTableRowElement }) =>
    sheet.rowProps(id).onClick(event);

  const pages = usePageTrail();
  const cursor = pages.cursor;
  const load = useCallback(
    () => observabilityApi.sessions({ state: state || undefined, cursor }),
    [state, cursor]
  );
  const list = useAdminData(load, { refreshMilliseconds: 20_000 });
  const nextCursor = list.data?.nextCursor ?? null;

  const items = list.data?.items ?? [];
  const assessments = new Map(items.map((item) => [item.id, assess(item)] as const));
  const count = (predicate: (item: AdminSessionSummary) => boolean) =>
    items.filter(predicate).length;

  const recovery = count((item) => item.state === "RECOVERY_REQUIRED");
  const failed = count((item) => item.state === "FAILED");
  const endedEarly = count((item) => ENDED_EARLY.has(item.state));
  const completed = count((item) => item.state === "COMPLETED");
  const charged = count(
    (item) => assessments.get(item.id)?.flags.includes(CHARGED_NOT_PRINTED) ?? false
  );

  // The rows actually drawn. Only the verdict filter narrows them here; a state
  // filter was applied by the server and these rows are already the answer.
  const visible = chargedOnly ? items.filter(isChargedNotPrinted) : items;
  const attention = visible.filter((item) => assessments.get(item.id)?.level === "critical").length;

  const active = activeCard(state, chargedOnly);
  const filtered = chargedOnly || state !== "";
  /** The server narrowed the page, so any count of something else is unknown. */
  const narrowed = state !== "";

  const describeFilter = () => (chargedOnly ? "charged but not printed" : humanizeState(state));

  const clearFilter = useCallback(() => {
    setState("");
    setChargedOnly(false);
    pages.reset();
  }, []);

  /**
   * The tiles behave as one segmented control: choosing a filter replaces the
   * filter that was on, and choosing the one already on turns it off. Two of
   * them at once would need the browser to reconcile a server filter with a
   * client one, and the honest reading of "Failed" and "Charged, not printed"
   * together — failed sessions, of which the charged ones, out of one page —
   * is not something four cards can say.
   */
  const chooseCard = useCallback((card: CardId) => {
    pages.reset();
    if (card === "CHARGED") {
      setState("");
      setChargedOnly((current) => !current);
      return;
    }
    setChargedOnly(false);
    setState((current) => (current === card ? "" : card));
  }, []);

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
              ? "Loading recent print sessions…"
              : visible.length === 0
                ? filtered
                  ? `No print sessions ${describeFilter().toLowerCase()}`
                  : "No print sessions recorded yet"
                : attention === 0
                  ? "Recent print sessions are operating normally"
                  : `${attention} of these ${visible.length} print sessions need review`}
          </p>
          <p className="page-head__meta">
            {visible.length > 0 ? `Showing ${visible.length} most recent` : "Nothing to show"}
            {filtered ? ` · ${describeFilter()}` : ""}
            {list.data?.scoped ? " · your assigned kiosks" : ""}
            {pages.page > 1 ? ` · page ${pages.page}` : ""}
            {filtered ? (
              <button type="button" className="button-link page-head__clear" onClick={clearFilter}>
                Show all
              </button>
            ) : null}
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
                // The dropdown and the tiles are the same filter reached two
                // ways, so choosing here turns off whatever a tile had on.
                setState(event.target.value);
                setChargedOnly(false);
                pages.reset();
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

      {items.length > 0 ? (
        <KpiRow>
          <FilterKpi
            noun="print sessions"
            card="RECOVERY_REQUIRED"
            label="Ended in recovery"
            value={recovery}
            resting={
              recovery === 0 ? "None on this page" : "Ended without a confirmed print result"
            }
            tone={recovery > 0 ? "critical" : undefined}
            elevated={recovery > 0 && active === null}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
            noun="print sessions"
            card="FAILED"
            label="Failed print sessions"
            value={failed}
            resting={failed === 0 ? "None on this page" : "Ended in failure"}
            tone={failed > 0 ? "critical" : undefined}
            elevated={recovery === 0 && failed > 0 && active === null}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
            noun="print sessions"
            card="CHARGED"
            label="Charged, not printed"
            value={charged}
            resting={charged === 0 ? "No money at risk here" : "Paid and the print did not land"}
            tone={charged > 0 ? "critical" : undefined}
            elevated={recovery === 0 && failed === 0 && charged > 0 && active === null}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
            noun="print sessions"
            card="COMPLETED"
            label="Completed print sessions"
            value={completed}
            resting={`${endedEarly} canceled or expired`}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
        </KpiRow>
      ) : null}

      <Panel title="Recent print sessions" state={list} emptyMessage="No print sessions to show.">
        {list.data && visible.length === 0 ? (
          <Empty>
            {filtered ? (
              <>
                {chargedOnly
                  ? "No print session on this page was charged without printing."
                  : `No print sessions are in ${humanizeState(state)}.`}{" "}
                <button type="button" className="button-link" onClick={clearFilter}>
                  Clear the filter
                </button>
              </>
            ) : (
              "No print sessions have been recorded yet."
            )}
          </Empty>
        ) : null}

        {visible.length > 0 ? (
          <>
            <Table
              className="data-table data-table--interactive"
              pane
              paneClassName="data-pane"
              columns={["Started", "Kiosk", "State", "Files", "Payment", "Print", "Deletion"]}
            >
              {visible.map((item) => {
                const verdict = assessments.get(item.id) ?? { level: "none" as Level, flags: [] };
                const classes = [
                  selected === item.id ? "is-selected" : "",
                  verdict.level === "critical" ? "is-alarming-row" : "",
                  verdict.level === "warn" ? "is-quiet-row" : ""
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <tr key={item.id} className={classes || undefined} onClick={rowClick(item.id)}>
                    <td data-label="Started">
                      <RowOpen
                        open={selected === item.id}
                        onOpen={(opener) => sheet.open(item.id, opener)}
                        label={`Print session on ${item.kioskId}, ${humanizeState(
                          item.state
                        )}, started ${new Date(item.createdAt).toLocaleString()}`}
                      >
                        <RowWhen value={item.createdAt} />
                      </RowOpen>
                    </td>
                    <td data-label="Kiosk">{item.kioskId}</td>
                    <td data-label="State">
                      <StateBadge
                        value={item.state}
                        humanize
                        quiet={!NEEDS_REVIEW.has(item.state) && !ENDED_EARLY.has(item.state)}
                      />
                      {verdict.flags.length > 0 ? (
                        <span className="row-flags">
                          {verdict.flags.map((flag) => (
                            <StatusPill key={flag} tone="critical">
                              {flag}
                            </StatusPill>
                          ))}
                        </span>
                      ) : null}
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
                      <span className="row-chevron" aria-hidden="true">
                        {" ›"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </Table>

            <Pagination
              label="Session pages"
              page={pages.page}
              pageCount={pages.pageCount}
              hasNext={pages.hasNext(nextCursor)}
              onGo={(target) => pages.go(target, nextCursor)}
            />
          </>
        ) : null}
      </Panel>

      {selected ? (
        <SessionSheet
          sessionId={selected}
          canSeeTimeline={session.can("session.timeline.read")}
          canSeeDocuments={session.can("document.metadata.read")}
          onClose={sheet.close}
        />
      ) : null}
    </>
  );
}

/**
 * One session, opened over the table instead of appended below it.
 *
 * The scaffolding — scrim, focus trap, Escape, scroll lock — is `Sheet`, shared
 * with Printing so the two behave identically. What lives here is only what a
 * session has to say.
 */
function SessionSheet({
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

  const summary = detail.data?.session ?? null;
  const verdict = summary ? assess(summary) : null;

  return (
    <Sheet
      title="Print session detail"
      onClose={onClose}
      subtitle={
        summary ? (
          <>
            <StateBadge value={summary.state} humanize />
            <span>{summary.kioskId}</span>
            <span aria-hidden="true">·</span>
            <When value={summary.createdAt} />
          </>
        ) : (
          <span>Loading…</span>
        )
      }
    >
      <>
        {detail.error ? (
          <div className="panel__error" role="alert">
            <span className="panel__error-text">{detail.error}</span>
            <button type="button" onClick={detail.reload}>
              Try again
            </button>
          </div>
        ) : null}

        {detail.loading && !detail.data ? (
          <p className="panel__status" role="status">
            Loading…
          </p>
        ) : null}

        {detail.data ? (
          <>
            {verdict && verdict.flags.length > 0 ? (
              <div className="sheet__flags">
                {verdict.flags.map((flag) => (
                  <StatusPill key={flag} tone="critical">
                    {flag}
                  </StatusPill>
                ))}
              </div>
            ) : null}

            {/* The identifiers, which used to occupy the table's leading
                  column and be truncated to eight characters there. They belong
                  here: they are what an operator quotes into a ticket or matches
                  against a customer's phone screen, and neither use is served by
                  an ellipsis. */}
            <dl className="sheet__ids">
              <div className="sheet__id">
                <dt>Print session ID</dt>
                <dd>{detail.data.session.id}</dd>
              </div>
              <div className="sheet__id">
                <dt>Handoff code</dt>
                <dd>{detail.data.session.publicId}</dd>
              </div>
            </dl>

            <h3>State</h3>
            <dl className="detail-grid">
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
                <dt>Started</dt>
                <dd>
                  <When value={detail.data.session.createdAt} />
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

            {/* The table has a Print column and the old detail had nothing to
                  say about it, so the failure code behind a red cell was the one
                  thing this view could not answer. It is in the payload already. */}
            {detail.data.printJob ? (
              <>
                <h3>Print</h3>
                <p className="panel__status">
                  <StateBadge value={detail.data.printJob.status} humanize /> — confidence{" "}
                  <StateBadge value={detail.data.printJob.resultConfidence} humanize />
                  {detail.data.printJob.failureCode ? (
                    <>
                      , failure <StateBadge value={detail.data.printJob.failureCode} />
                    </>
                  ) : null}
                  {detail.data.printJob.warningCode ? (
                    <>
                      , warning <StateBadge value={detail.data.printJob.warningCode} />
                    </>
                  ) : null}
                  .
                </p>
              </>
            ) : null}

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
              Metadata only. The control plane holds no storage credential and no route that returns
              a document, a page image or a filename.
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
      </>
    </Sheet>
  );
}
