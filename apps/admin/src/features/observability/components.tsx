import type { ReactNode } from "react";

import type { AdminDataState } from "./useAdminData.js";

/**
 * The furniture every operational panel shares.
 *
 * Nothing here decides what an operator may see — the server does that, and
 * this file only draws what it was given. Its job is to make "loading",
 * "failed" and "nothing to show" three visibly different things, because on an
 * operations dashboard they mean three very different things.
 */

export function Panel({
  title,
  actions,
  hint,
  state,
  emptyMessage,
  children
}: {
  title: string;
  actions?: ReactNode;
  hint?: ReactNode;
  state: AdminDataState<unknown>;
  emptyMessage?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel__heading">
        <h2>{title}</h2>
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </div>
      {hint ? <p className="panel__hint">{hint}</p> : null}

      {state.error ? (
        <div className="panel__error" role="alert">
          <span className="panel__error-text">
            {state.error}
            {state.data ? " Showing the last information that loaded." : ""}
          </span>
          <button type="button" onClick={state.reload}>
            Try again
          </button>
        </div>
      ) : null}

      {state.loading && !state.data ? (
        <p className="panel__status" role="status">
          Loading…
        </p>
      ) : null}

      {!state.loading && !state.data && !state.error ? (
        <p className="panel__status">{emptyMessage ?? "Nothing to show."}</p>
      ) : null}

      {state.data ? children : null}
    </section>
  );
}

export function Table({
  columns,
  children,
  caption,
  className,
  pane = false,
  paneClassName
}: {
  columns: readonly string[];
  children: ReactNode;
  caption?: string;
  /** An extra class on the table, for a panel that restyles or stacks its own. */
  className?: string;
  /**
   * Give the table its own vertical scroll and stick the header to the top of
   * it.
   *
   * Opt-in rather than the default because it is only an improvement for a long
   * list. A four-row table in a scrolling box is a box with a scrollbar it never
   * uses and a header pinned to rows nobody lost sight of; the cost — a second
   * scrolling region on the page — is only worth paying where the rows actually
   * outrun the screen.
   */
  pane?: boolean;
  /** An extra class on the scrolling wrapper, for a panel that sizes its own. */
  paneClassName?: string;
}) {
  const wrapper = ["table-scroll", pane ? "table-scroll--pane" : "", paneClassName ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapper}>
      <table className={className ? `table ${className}` : "table"}>
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="panel__status">{children}</p>;
}

export interface CounterItem {
  label: string;
  value: number;
  alarming?: boolean;
  /**
   * Where the rows behind this number live. Omitted when there is no view that
   * says more than the number already does — an unreachable count is better
   * than a link that lands somewhere unrelated and teaches people not to click.
   */
  onOpen?: (() => void) | undefined;
  /** Completes "…: 3." for a screen reader, e.g. "Show failed print jobs." */
  openLabel?: string;
}

export function Counters({ items }: { items: readonly CounterItem[] }) {
  return (
    <dl className="counters">
      {items.map((item) => (
        <Counter key={item.label} item={item} />
      ))}
    </dl>
  );
}

function Counter({ item }: { item: CounterItem }) {
  const className = item.alarming && item.value > 0 ? "counter is-alarming" : "counter";
  const body = (
    <>
      <dt>{item.label}</dt>
      <dd>{item.value}</dd>
    </>
  );

  if (!item.onOpen) return <div className={className}>{body}</div>;

  // A real button, not a click handler on the tile. It has to be reachable by
  // keyboard and announce itself as something that goes somewhere, and the
  // definition list stays intact because the button sits inside the group
  // rather than replacing it.
  return (
    <div className={`${className} is-navigable`}>
      <button
        type="button"
        className="counter__open"
        onClick={item.onOpen}
        aria-label={`${item.label}: ${item.value}. ${item.openLabel ?? "View details."}`}
      >
        {body}
      </button>
    </div>
  );
}

/**
 * A state or code, drawn so an unusual one is visible at a glance.
 *
 * `humanize` is opt-in rather than the default because these are the system's
 * own state names, and on most panels reading them verbatim is the point — an
 * operator quoting `DEAD_LETTER` into a search box wants the string that is
 * actually in the database. Where a screen is built to be scanned rather than
 * quoted, the readable form wins and the raw value survives on hover.
 */
export function StateBadge({
  value,
  tone,
  humanize = false,
  quiet = false
}: {
  value: string | null;
  tone?: Tone;
  humanize?: boolean;
  /** Drops an ordinary state back to a plain label, so unusual ones carry the page. */
  quiet?: boolean;
}) {
  if (!value) return <span className="muted">—</span>;
  const resolved = tone ?? toneFor(value);
  const classes = `badge badge--${resolved}${quiet ? " badge--quiet" : ""}`;
  return (
    <span className={classes} title={humanize ? value : undefined}>
      {humanize ? humanizeState(value) : value}
    </span>
  );
}

/**
 * `RECOVERY_REQUIRED` → `Recovery required`.
 *
 * Presentation only, and reversible by eye: the underlying value is unchanged,
 * is still what gets sent and compared, and is kept on the element's `title` so
 * the exact string is one hover away.
 */
export function humanizeState(value: string): string {
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type Tone = "neutral" | "good" | "warn" | "bad";

const BAD = new Set([
  "RECOVERY_REQUIRED",
  "FAILED",
  "DEAD_LETTER",
  "OFFLINE",
  "REJECTED",
  "ERROR",
  "DECLINED"
]);
const WARN = new Set([
  "UNCONFIRMED",
  "DEGRADED",
  "PENDING",
  "IN_PROGRESS",
  "AWAITING_PAYMENT",
  "TIMED_OUT",
  "NEVER_SEEN",
  "EXPIRED",
  "CANCELED"
]);
const GOOD = new Set([
  "ONLINE",
  "ACTIVE",
  "COMPLETED",
  "CAPTURED",
  "READY",
  "CLEAN",
  "DONE",
  "CONFIRMED"
]);

function toneFor(value: string): Tone {
  if (BAD.has(value)) return "bad";
  if (WARN.has(value)) return "warn";
  if (GOOD.has(value)) return "good";
  return "neutral";
}

/** Absolute time in the operator's own locale, with the raw value on hover. */
export function When({ value }: { value: string | null }) {
  if (!value) return <span className="muted">—</span>;
  const parsed = new Date(value);
  return (
    <time dateTime={value} title={value}>
      {parsed.toLocaleString()}
    </time>
  );
}

export function Duration({ milliseconds }: { milliseconds: number | null }) {
  if (milliseconds === null) return <span className="muted">—</span>;
  if (milliseconds < 1_000) return <span>{milliseconds} ms</span>;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return <span>{seconds}s</span>;
  const minutes = Math.floor(seconds / 60);
  return <span>{`${minutes}m ${seconds % 60}s`}</span>;
}

/**
 * Money, from minor units and an exponent.
 *
 * Never from a float. The system stores integer minor units precisely so that
 * an amount displayed to an operator settling a refund is the amount that
 * moved, and dividing through a float is how a display and a ledger drift.
 */
export function Money({
  minor,
  currency,
  exponent
}: {
  minor: number;
  currency: string;
  exponent: number;
}) {
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return (
    <span className="money">
      {sign}
      {whole}
      {fraction} {currency}
    </span>
  );
}

/** A UUID, shortened for a table but complete on hover and on copy. */
export function Identifier({ value }: { value: string }) {
  return (
    <code className="identifier" title={value}>
      {value.length > 12 ? `${value.slice(0, 8)}…` : value}
    </code>
  );
}

/**
 * When something happened, clock first, for a table's leading column.
 *
 * Nearly every row on a page is from the same day or two, so the date is the
 * part that repeats and the time is the part that distinguishes. Putting the
 * clock on the readable line and dropping the date to metadata is what lets
 * somebody find "the one just after four" by running down the column — which is
 * the entire reason these tables lead with a timestamp rather than with an
 * identifier nobody reads. The exact value stays on `title`, and `When` remains
 * for anywhere a full timestamp in one line is what is wanted.
 */
export function RowWhen({ value }: { value: string }) {
  const parsed = new Date(value);
  return (
    <time className="row-when" dateTime={value} title={parsed.toLocaleString()}>
      {parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      <span className="row-when__date">
        {parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
      </span>
    </time>
  );
}

/**
 * Numbered pagination over a cursor API.
 *
 * These endpoints are keyset-paged: a response carries the rows and an opaque
 * cursor for the next page, and never a total. So this control cannot offer
 * "page 7 of 40" — nothing in the system knows what 40 would be, and inventing
 * it by guessing from a page size would put a number on screen that no query
 * produced.
 *
 * What it can do honestly is number the pages that have been reached. The
 * caller keeps the trail of cursors it has discovered; every page in that trail
 * is one click away in either direction, and the forward arrow stays live while
 * a next cursor exists, which is the system's own answer to "is there more".
 * The result behaves like numbered pagination in the direction people actually
 * use it — back to the page they were on two minutes ago — without claiming
 * knowledge of an end nobody has asked the database for.
 *
 * `hasNext` and the trail length are deliberately separate. Being on page 3 of 5
 * known pages with no further cursor is a different fact from being on page 3 of
 * 3 with more to come, and the arrow has to be right in both.
 */
export function Pagination({
  page,
  pageCount,
  hasNext,
  onGo,
  label = "Pages"
}: {
  /** The current page, 1-based. */
  page: number;
  /** How many pages have been reached so far. Never fewer than `page`. */
  pageCount: number;
  /** Whether a cursor exists beyond the last known page. */
  hasNext: boolean;
  onGo: (page: number) => void;
  /** Names the control for a screen reader: "Session pages". */
  label?: string;
}) {
  // One page and nothing beyond it is not pagination, it is a row of furniture
  // around a number that cannot change.
  if (pageCount <= 1 && !hasNext) return null;

  const canGoBack = page > 1;
  const canGoForward = page < pageCount || hasNext;

  return (
    <nav className="pagination" aria-label={label}>
      <button
        type="button"
        className="pagination__arrow"
        disabled={!canGoBack}
        aria-label="Previous page"
        onClick={() => onGo(page - 1)}
      >
        <span aria-hidden="true">←</span>
      </button>

      <ol className="pagination__pages">
        {pageItems(page, pageCount).map((item, index) =>
          item === "gap" ? (
            // Not a control and not a page: it stands for the pages between two
            // numbers, and announcing "ellipsis" to a screen reader that already
            // has both numbers adds nothing.
            <li key={`gap-${index}`} className="pagination__gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={item}>
              <button
                type="button"
                className={item === page ? "pagination__page is-current" : "pagination__page"}
                aria-current={item === page ? "page" : undefined}
                aria-label={`Page ${item}`}
                onClick={() => onGo(item)}
              >
                {item}
              </button>
            </li>
          )
        )}
      </ol>

      <button
        type="button"
        className="pagination__arrow"
        disabled={!canGoForward}
        aria-label="Next page"
        onClick={() => onGo(page + 1)}
      >
        <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}

/**
 * Which page numbers to draw, and where the gaps go.
 *
 * The first and last known pages are always present so the two ends stay
 * reachable in one click, and a window of one either side of the current page
 * keeps the immediate neighbours available. Everything else collapses.
 *
 * A gap is only drawn where it replaces more than one number: substituting "…"
 * for a single page makes the control no narrower and takes away somewhere to
 * click, which is the one thing an ellipsis must never do.
 */
function pageItems(page: number, pageCount: number, span = 1): (number | "gap")[] {
  const keep = new Set<number>([1, pageCount]);
  for (let offset = -span; offset <= span; offset += 1) {
    const candidate = page + offset;
    if (candidate >= 1 && candidate <= pageCount) keep.add(candidate);
  }

  const items: (number | "gap")[] = [];
  let previous = 0;
  for (const value of [...keep].sort((left, right) => left - right)) {
    if (previous !== 0 && value - previous > 1) {
      if (value - previous === 2) items.push(previous + 1);
      else items.push("gap");
    }
    items.push(value);
    previous = value;
  }
  return items;
}
