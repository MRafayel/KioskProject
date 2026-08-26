import { useCallback, useMemo, useState } from "react";

import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Identifier,
  Pagination,
  Panel,
  RowWhen,
  StateBadge,
  Table,
  humanizeState
} from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { usePageTrail } from "../features/observability/usePageTrail.js";

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
 *
 * The filters are deliberately client-side and deliberately few. There is no
 * audit search endpoint, and building one in the browser over a single page of
 * entries would look like search while only ever covering what happened to
 * load — so these narrow the page and the page says how many it holds.
 */
export function AuditPanel() {
  const pages = usePageTrail();
  const cursor = pages.cursor;
  const load = useCallback(() => observabilityApi.audit({ cursor }), [cursor]);
  const state = useAdminData(load, { refreshMilliseconds: 30_000 });
  const nextCursor = state.data?.nextCursor ?? null;

  const [outcome, setOutcome] = useState("");
  const [actor, setActor] = useState("");

  const items = useMemo(() => state.data?.items ?? [], [state.data]);

  /** The outcomes and actors actually present, so no filter offers an empty set. */
  const outcomes = useMemo(() => [...new Set(items.map((entry) => entry.outcome))].sort(), [items]);
  const actors = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of items) {
      byId.set(
        entry.actorId,
        entry.actorDisplayName
          ? `${entry.actorDisplayName} · ${shortActorId(entry.actorId)}`
          : entry.actorId
      );
    }
    return [...byId]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  const refused = items.filter((entry) => entry.outcome !== "SUCCESS").length;

  const visible = items
    .filter((entry) => (outcome ? entry.outcome === outcome : true))
    .filter((entry) => (actor ? entry.actorId === actor : true));

  const selectedActor = actors.find((entry) => entry.id === actor)?.label;

  const filtered = outcome !== "" || actor !== "";
  const clearFilter = useCallback(() => {
    setOutcome("");
    setActor("");
  }, []);

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p
            className={`page-head__summary page-head__summary--${
              state.data === null ? "calm" : refused === 0 ? "calm" : "busy"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {state.data === null
              ? "Reading the log…"
              : items.length === 0
                ? "Nothing has been recorded yet"
                : refused === 0
                  ? `${items.length} recent actions, all of them successful`
                  : `${refused} of these ${items.length} actions were refused or failed`}
          </p>
          <p className="page-head__meta">
            {visible.length > 0 ? `Showing ${visible.length}` : "Nothing to show"}
            {outcome ? ` · ${humanizeState(outcome)}` : ""}
            {selectedActor ? ` · ${selectedActor}` : ""}
            {state.data?.scope === "SELF"
              ? " · your own actions"
              : " · append-only, and no role can edit an entry"}
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
          {actors.length > 1 ? (
            <label className="inline-field">
              Actor
              <select value={actor} onChange={(event) => setActor(event.target.value)}>
                <option value="">Anyone</option>
                {actors.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="inline-field">
            Outcome
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
              <option value="">Any</option>
              {outcomes.map((value) => (
                <option key={value} value={value}>
                  {humanizeState(value)}
                </option>
              ))}
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

      <Panel
        title="Recent activity"
        state={state}
        emptyMessage="No entries."
        hint={
          state.data?.scope === "SELF"
            ? "Showing your own actions. The full log is a separate capability."
            : undefined
        }
      >
        {state.data && visible.length === 0 ? (
          <Empty>
            {filtered ? (
              <>
                No entries match that filter.{" "}
                <button type="button" className="button-link" onClick={clearFilter}>
                  Clear the filter
                </button>
              </>
            ) : (
              "No entries."
            )}
          </Empty>
        ) : null}

        {visible.length > 0 ? (
          <Table
            className="data-table"
            pane
            paneClassName="data-pane"
            columns={["When", "Actor", "Action", "Outcome", "Print session", "Detail"]}
          >
            {visible.map((entry) => (
              <tr
                key={entry.id}
                className={entry.outcome === "SUCCESS" ? undefined : "is-quiet-row"}
              >
                <td data-label="When">
                  <RowWhen value={entry.occurredAt} />
                </td>
                <td data-label="Actor">
                  {entry.actorDisplayName ?? entry.actorId}
                  <span className="key-list__meta">
                    {humanizeState(entry.actorType)}
                    {entry.actorDisplayName ? ` · ${shortActorId(entry.actorId)}` : ""}
                  </span>
                </td>
                <td data-label="Action">
                  <code>{entry.action}</code>
                </td>
                <td data-label="Outcome">
                  <StateBadge value={entry.outcome} humanize quiet={entry.outcome === "SUCCESS"} />
                </td>
                <td data-label="Print session">
                  {entry.sessionId ? (
                    <Identifier value={entry.sessionId} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label="Detail">
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

        <Pagination
          label="Activity pages"
          page={pages.page}
          pageCount={pages.pageCount}
          hasNext={pages.hasNext(nextCursor)}
          onGo={(target) => pages.go(target, nextCursor)}
        />
      </Panel>
    </>
  );
}

function shortActorId(actorId: string): string {
  return actorId.length > 12 ? `…${actorId.slice(-8)}` : actorId;
}
