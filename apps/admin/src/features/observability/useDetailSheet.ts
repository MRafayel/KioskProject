import { useCallback, useRef, useState } from "react";

/**
 * A list and the sheet that opens over it.
 *
 * Three panels show a table of records and one record in full, and getting the
 * interaction right involves more state than it looks: which row is open, what
 * opened it, and where focus goes when it closes. Keeping that in one place is
 * what stops Sessions and Printing drifting into two subtly different answers to
 * the same question.
 *
 * The focus return is the part worth naming. Without it, closing the sheet drops
 * focus to the document body and the next `Tab` restarts at the top of the page
 * — which for somebody working a table by keyboard means losing their row every
 * single time they read one. The opener element is captured on the way in and
 * focused on the way out, so a keyboard user lands back exactly where they were.
 */
export interface DetailSheet {
  /** The record currently open, or null. */
  selected: string | null;
  /** Open a record, remembering the control to hand focus back to. */
  open: (id: string, opener: HTMLButtonElement | null) => void;
  close: () => void;
  /**
   * What to spread onto a `<tr>` to make the whole row the pointer target.
   *
   * The row is not itself focusable and takes no role: it stays a table row for
   * anything reading the structure, and the keyboard path is the `RowOpen`
   * button inside its leading cell. Two affordances, one target.
   */
  rowProps: (id: string) => {
    className: string | undefined;
    onClick: (event: { currentTarget: HTMLTableRowElement }) => void;
  };
}

export function useDetailSheet(rowClassName?: (id: string) => string | undefined): DetailSheet {
  const [selected, setSelected] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const open = useCallback((id: string, opener: HTMLButtonElement | null) => {
    openerRef.current = opener;
    setSelected(id);
  }, []);

  const close = useCallback(() => {
    setSelected(null);
    // The table never unmounted, so the button is still there to receive this.
    openerRef.current?.focus();
    openerRef.current = null;
  }, []);

  const rowProps = useCallback(
    (id: string) => {
      const extra = rowClassName?.(id);
      const classes = [selected === id ? "is-selected" : "", extra ?? ""].filter(Boolean).join(" ");
      return {
        className: classes || undefined,
        onClick: (event: { currentTarget: HTMLTableRowElement }) =>
          open(id, event.currentTarget.querySelector<HTMLButtonElement>(".row-open"))
      };
    },
    [open, rowClassName, selected]
  );

  return { selected, open, close, rowProps };
}
