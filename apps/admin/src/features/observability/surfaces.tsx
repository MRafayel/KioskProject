import type { ReactNode } from "react";

/**
 * The shared surfaces the control plane is drawn on.
 *
 * These are presentational and deliberately empty of judgement: none of them
 * decides what an operator may see, none fetches anything, and none knows what
 * a number means. The screen above them decides that a count is a problem and
 * says so; these only render the decision consistently, so that "this needs
 * somebody" looks the same in Kiosks as it does on the overview.
 *
 * Two rules hold across all of them, and both exist because this interface is
 * read under bad lighting by people who may be colourblind, tired, or both:
 *
 *  - **A tone is never the only signal.** Every tone below is accompanied by a
 *    word, a marker glyph, or both. Delete the colour and the screen still
 *    says the same thing.
 *  - **Anything that goes somewhere is a real button.** Not a click handler on
 *    a card. It has to be reachable by keyboard in one stop and announce itself
 *    as something that navigates.
 */

/** How much a thing wants somebody's attention. Not a colour — a meaning. */
export type Tone = "neutral" | "good" | "warn" | "critical";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: "",
  good: " status-pill--good",
  warn: " status-pill--warn",
  critical: " status-pill--critical"
};

/**
 * A word describing a state, tinted to match.
 *
 * The word is mandatory and the tint is decoration, which is the whole point:
 * `OFFLINE` reads as offline in greyscale.
 */
export function StatusPill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`status-pill${TONE_CLASS[tone]}`}>{children}</span>;
}

/**
 * A titled band of the page.
 *
 * The heading is a real `h2` so the page has an outline a screen reader can
 * navigate, and `aria-labelledby` ties the region to it rather than repeating
 * the text in an `aria-label` that can drift out of step.
 */
export function Section({
  id,
  title,
  note,
  children
}: {
  id: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section__head">
        <h2 id={id} className="section__title">
          {title}
        </h2>
        {note ? <p className="section__note">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

export interface KpiProps {
  label: string;
  /** The number itself, already formatted. Dominates the tile. */
  value: ReactNode;
  /** A denominator, drawn small beside the value — the "of 3" in "2 of 3". */
  of?: string;
  /** One quiet line under the value. */
  foot?: ReactNode;
  /** Colours the value and promotes the footnote. Pairs with wording in `foot`. */
  tone?: Extract<Tone, "warn" | "critical"> | undefined;
  /**
   * Lifts this tile above its neighbours. Reserved for whatever currently needs
   * a person: emphasis that is always on is emphasis nobody sees.
   */
  elevated?: boolean;
  onOpen?: (() => void) | undefined;
  /** Completes "Kiosk health: 2 of 3." for a screen reader. */
  openLabel?: string;
  /**
   * Turns the tile into a toggle that is currently on — a filter it is applying
   * to whatever sits below it.
   *
   * Only meaningful with `onOpen`, and deliberately separate from `elevated`:
   * one says this number needs a person, the other says you are looking at only
   * these rows, and a tile is routinely both at once. Passing it switches the
   * button's accessible role from "opens something" to `aria-pressed`, because
   * that is what it has become.
   */
  pressed?: boolean | undefined;
}

/**
 * One headline number.
 *
 * The label sits above the value small, the value is the largest thing in the
 * tile, and the supporting line beneath it is the quietest. That ordering is
 * the entire hierarchy — a person reading only the middle line of each tile
 * should still know what the system is doing.
 */
export function Kpi({
  label,
  value,
  of,
  foot,
  tone,
  elevated = false,
  onOpen,
  openLabel,
  pressed
}: KpiProps) {
  const classes = [
    "kpi",
    elevated ? "kpi--elevated" : "",
    onOpen ? "is-navigable" : "",
    pressed ? "is-pressed" : "",
    tone === "critical" ? "kpi--critical" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const valueClass =
    tone === "critical"
      ? "kpi__value kpi__value--critical"
      : tone
        ? "kpi__value kpi__value--warn"
        : "kpi__value";

  const body = (
    <>
      <p className="kpi__label">{label}</p>
      <p className={valueClass}>
        {value}
        {of ? <span className="kpi__of"> {of}</span> : null}
      </p>
      {foot ? <p className={footClass(tone, pressed)}>{foot}</p> : null}
    </>
  );

  if (!onOpen) return <article className={classes}>{body}</article>;

  return (
    <article className={classes}>
      <button
        type="button"
        className="kpi__open"
        onClick={onOpen}
        // A toggle announces whether it is on; a link announces where it goes.
        // Sending `aria-pressed` only when the caller has an answer keeps the
        // navigating tiles on the overview reading as navigation.
        aria-pressed={pressed === undefined ? undefined : pressed}
        aria-label={`${label}: ${textOf(value)}${of ? ` ${of}` : ""}. ${openLabel ?? "View details."}`}
      >
        {body}
      </button>
    </article>
  );
}

/** The footnote is the tile's quietest line and the one that says what is on. */
function footClass(tone: KpiProps["tone"], pressed: boolean | undefined): string {
  if (pressed) return "kpi__foot kpi__foot--pressed";
  return tone ? "kpi__foot kpi__foot--problem" : "kpi__foot";
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="kpi-row">{children}</div>;
}

/**
 * A group of related numbers under one heading, led by a sentence.
 *
 * The summary is the part that gets read. Somebody who takes in "2 of 3 kiosks
 * online" and nothing else has understood the module, and the rows below exist
 * for the follow-up question rather than the first one.
 */
export function Module({
  title,
  pill,
  summary,
  summaryTone,
  children
}: {
  title: string;
  pill?: ReactNode;
  summary?: ReactNode;
  summaryTone?: Tone | undefined;
  children?: ReactNode;
}) {
  const summaryClass =
    summaryTone === "critical"
      ? "module__summary module__summary--critical"
      : summaryTone === "warn"
        ? "module__summary module__summary--problem"
        : "module__summary";

  return (
    <section className="module">
      <div className="module__head">
        <h3 className="module__title">{title}</h3>
        {pill}
      </div>
      {summary ? <p className={summaryClass}>{summary}</p> : null}
      {children}
    </section>
  );
}

export function ModuleGrid({ children }: { children: ReactNode }) {
  return <div className="module-grid">{children}</div>;
}

/**
 * The healthy state of a module, stated rather than implied by an empty card.
 *
 * An operations dashboard cannot leave a blank where "everything is fine"
 * belongs: blank is indistinguishable from a request that failed, and the two
 * mean opposite things.
 */
export function HealthyNote({ children }: { children: ReactNode }) {
  return (
    <p className="module__healthy">
      <span aria-hidden="true">✓</span>
      {children}
    </p>
  );
}

export interface StatProps {
  label: string;
  value: number;
  /**
   * True when this row is the abnormal one. Drives the marker glyph as well as
   * the colour, so the emphasis survives greyscale.
   */
  problem?: boolean;
  /** Escalates an already-problematic row from amber to red. */
  critical?: boolean;
  /** A healthy zero: kept on screen, kept out of the way. */
  quiet?: boolean;
  onOpen?: (() => void) | undefined;
  openLabel?: string;
}

export function StatList({ children }: { children: ReactNode }) {
  return <dl className="stat-list">{children}</dl>;
}

export function Stat({ label, value, problem, critical, quiet, onOpen, openLabel }: StatProps) {
  const classes = [
    "stat",
    critical ? "is-critical" : problem ? "is-problem" : "",
    quiet ? "is-quiet" : "",
    onOpen ? "is-navigable" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );

  // The definition list stays intact because the button sits inside the row
  // rather than replacing it: `dt` and `dd` keep their `dl` parent, so the
  // pairing survives for anything reading the structure rather than the pixels.
  if (!onOpen) return <div className={classes}>{body}</div>;

  return (
    <div className={classes}>
      <button
        type="button"
        className="stat__open"
        onClick={onOpen}
        aria-label={`${label}: ${value}. ${openLabel ?? "View details."}`}
      >
        {body}
      </button>
    </div>
  );
}

/** Best-effort text of a node, for the accessible name of a navigable tile. */
function textOf(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}
