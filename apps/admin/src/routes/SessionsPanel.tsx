import { useCallback, useEffect, useRef, useState } from "react";

import { adminSessionStateSchema, type AdminSessionSummary } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Duration,
  Empty,
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

  if (NEEDS_SOMEBODY.has(item.state)) {
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
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * Whatever opened the sheet, so closing it can hand focus back.
   *
   * Without this, closing drops focus to the document and the next `Tab` starts
   * again from the top of the page — which for somebody working the table by
   * keyboard means losing their row every time they read one.
   */
  const openerRef = useRef<HTMLButtonElement | null>(null);

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
    setCursors([undefined]);
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
    setCursors([undefined]);
    if (card === "CHARGED") {
      setState("");
      setChargedOnly((current) => !current);
      return;
    }
    setChargedOnly(false);
    setState((current) => (current === card ? "" : card));
  }, []);

  const openSession = useCallback((id: string, opener: HTMLButtonElement | null) => {
    openerRef.current = opener;
    setSelected(id);
  }, []);

  const closeSession = useCallback(() => {
    setSelected(null);
    openerRef.current?.focus();
    openerRef.current = null;
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
              ? "Loading recent sessions…"
              : visible.length === 0
                ? filtered
                  ? `No sessions ${describeFilter().toLowerCase()}`
                  : "No sessions recorded yet"
                : attention === 0
                  ? "Recent sessions are operating normally"
                  : `${attention} of these ${visible.length} sessions need attention`}
          </p>
          <p className="page-head__meta">
            {visible.length > 0 ? `Showing ${visible.length} most recent` : "Nothing to show"}
            {filtered ? ` · ${describeFilter()}` : ""}
            {list.data?.scoped ? " · your assigned kiosks" : ""}
            {cursors.length > 1 ? ` · page ${cursors.length}` : ""}
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
          <FilterKpi
            card="RECOVERY_REQUIRED"
            label="Recovery required"
            value={recovery}
            resting={recovery === 0 ? "None on this page" : "Waiting for a person"}
            tone={recovery > 0 ? "critical" : undefined}
            elevated={recovery > 0 && active === null}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
            card="FAILED"
            label="Failed"
            value={failed}
            resting={failed === 0 ? "None on this page" : "Ended in failure"}
            tone={failed > 0 ? "critical" : undefined}
            elevated={recovery === 0 && failed > 0 && active === null}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
          <FilterKpi
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
            card="COMPLETED"
            label="Completed"
            value={completed}
            resting={`${endedEarly} canceled or expired`}
            active={active}
            narrowed={narrowed}
            onChoose={chooseCard}
          />
        </KpiRow>
      ) : null}

      <Panel
        title="Recent sessions"
        state={list}
        emptyMessage="No sessions to show."
        hint={
          items.length > 0
            ? "Select any row to open the session beside the table. Counts above filter these rows."
            : undefined
        }
      >
        {list.data && visible.length === 0 ? (
          <Empty>
            {filtered ? (
              <>
                {chargedOnly
                  ? "No session on this page was charged without printing."
                  : `No sessions are in ${humanizeState(state)}.`}{" "}
                <button type="button" className="button-link" onClick={clearFilter}>
                  Clear the filter
                </button>
              </>
            ) : (
              "No sessions have been recorded yet."
            )}
          </Empty>
        ) : null}

        {visible.length > 0 ? (
          <>
            <Table
              className="sessions-table"
              pane
              paneClassName="sessions-pane"
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
                  <tr
                    key={item.id}
                    className={classes || undefined}
                    // The pointer gets the whole row. The keyboard gets the
                    // button inside it, which is where the accessible name and
                    // the open state live; clicking anywhere else routes to the
                    // same place and hands focus restoration the same element.
                    onClick={(event) =>
                      openSession(
                        item.id,
                        event.currentTarget.querySelector<HTMLButtonElement>(".session-open")
                      )
                    }
                  >
                    <td data-label="Started">
                      <button
                        type="button"
                        className="session-open"
                        aria-haspopup="dialog"
                        aria-expanded={selected === item.id}
                        aria-label={`Session on ${item.kioskId}, ${humanizeState(
                          item.state
                        )}, started ${new Date(item.createdAt).toLocaleString()}`}
                        onClick={(event) => {
                          // The row handler would otherwise run a second time
                          // and toggle this straight back shut.
                          event.stopPropagation();
                          openSession(item.id, event.currentTarget);
                        }}
                      >
                        <SessionWhen value={item.createdAt} />
                      </button>
                    </td>
                    <td data-label="Kiosk">{item.kioskId}</td>
                    <td data-label="State">
                      <StateBadge
                        value={item.state}
                        humanize
                        quiet={!NEEDS_SOMEBODY.has(item.state) && !ENDED_EARLY.has(item.state)}
                      />
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
                      <span className="session-chevron" aria-hidden="true">
                        {" ›"}
                      </span>
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
        <SessionSheet
          sessionId={selected}
          canSeeTimeline={session.can("session.timeline.read")}
          canSeeDocuments={session.can("document.metadata.read")}
          onClose={closeSession}
        />
      ) : null}
    </>
  );
}

/**
 * One summary tile, wired as one position of a four-way filter.
 *
 * The wording changes with what is on, because the ring around a pressed tile
 * is a colour and a shape and this screen is read by people who may get neither:
 * the footnote says "showing only these" in words, and says why a count is a
 * dash when somebody else's filter has made it unknowable.
 */
function FilterKpi({
  card,
  label,
  value,
  resting,
  tone,
  elevated,
  active,
  narrowed,
  onChoose
}: {
  card: CardId;
  label: string;
  value: number;
  /** The footnote when nothing is filtered — the tile's ordinary caption. */
  resting: string;
  tone?: "critical" | undefined;
  elevated?: boolean;
  active: CardId | null;
  narrowed: boolean;
  onChoose: (card: CardId) => void;
}) {
  const pressed = active === card;
  // A count taken from a page the server filtered to something else is not this
  // tile's count. Saying "0" there would be a claim nothing checked.
  const unknown = narrowed && !pressed;

  const foot = pressed
    ? "Showing only these — select again to clear"
    : unknown
      ? "Not counted while filtered"
      : resting;

  return (
    <Kpi
      label={label}
      value={unknown ? "—" : value}
      foot={foot}
      tone={unknown ? undefined : tone}
      elevated={elevated ?? false}
      pressed={pressed}
      onOpen={() => onChoose(card)}
      openLabel={
        pressed
          ? "Showing only these. Select to clear the filter."
          : `Show only ${label.toLowerCase()} sessions.`
      }
    />
  );
}

/**
 * When a session started, clock first.
 *
 * Nearly every row on a page is from the same day or two, so the date is the
 * part that repeats and the time is the part that distinguishes. Putting the
 * clock on the readable line and dropping the date to metadata is what lets
 * somebody find "the one just after four" by running down the column. The exact
 * value, timezone and all, is on `title` and in the sheet.
 */
function SessionWhen({ value }: { value: string }) {
  const parsed = new Date(value);
  return (
    <time className="session-when" dateTime={value} title={parsed.toLocaleString()}>
      {parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      <span className="session-when__date">
        {parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
      </span>
    </time>
  );
}

/** What a focus trap considers a stop. */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * One session, opened over the table instead of appended below it.
 *
 * The previous detail rendered as another panel at the foot of the page, which
 * made choosing a row an act with no visible result: the answer appeared a
 * screenful further down, reading it meant leaving the table, and coming back
 * cost the scroll position and whichever row was being compared against. On a
 * fifty-row page that is the difference between an investigation and a scroll.
 *
 * The sheet leaves the table mounted and untouched underneath, so closing it
 * returns to exactly the same rows at exactly the same offset, with the row
 * that was opened still marked. Escape closes it, focus goes in on open and
 * comes back out to the row on close, and `Tab` stays inside while it is there —
 * because it claims `aria-modal`, and a dialog that says that while letting
 * focus wander into the page behind it has lied to the only people relying on
 * the claim.
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

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    // The page behind a modal should not scroll under it. Restored rather than
    // cleared, so a future caller that had its own reason to lock is not undone.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const stops = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const summary = detail.data?.session ?? null;
  const verdict = summary ? assess(summary) : null;

  return (
    <>
      {/* The scrim is the click-away target and the thing that stops the page
          behind responding to a pointer. It is not a control, so it carries no
          role and no name — Escape and the close button are the ways out that
          announce themselves. */}
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />

      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-sheet-title"
        ref={sheetRef}
        onKeyDown={onKeyDown}
      >
        <div className="sheet__head">
          <div>
            <h2 className="sheet__title" id="session-sheet-title">
              Session detail
            </h2>
            <p className="sheet__subtitle">
              {summary ? (
                <>
                  <StateBadge value={summary.state} humanize />
                  <span>{summary.kioskId}</span>
                  <span aria-hidden="true">·</span>
                  <When value={summary.createdAt} />
                </>
              ) : (
                <span>Loading…</span>
              )}
            </p>
          </div>
          <button type="button" className="sheet__close" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>

        <div className="sheet__body">
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
                  <dt>Session ID</dt>
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
                    {detail.data.settings.paperSize}, {detail.data.settings.colorMode.toLowerCase()}{" "}
                    — {detail.data.settings.selectedPages} pages selected across{" "}
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
                Metadata only. The control plane holds no storage credential and no route that
                returns a document, a page image or a filename.
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
        </div>
      </div>
    </>
  );
}
