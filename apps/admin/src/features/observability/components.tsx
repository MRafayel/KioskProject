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
          <span className="panel__error-text">{state.error}</span>
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
  caption
}: {
  columns: readonly string[];
  children: ReactNode;
  caption?: string;
}) {
  return (
    <div className="table-scroll">
      <table className="table">
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

/** A state or code, drawn so an unusual one is visible at a glance. */
export function StateBadge({ value, tone }: { value: string | null; tone?: Tone }) {
  if (!value) return <span className="muted">—</span>;
  return <span className={`badge badge--${tone ?? toneFor(value)}`}>{value}</span>;
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
