import { useCallback, useState } from "react";

/**
 * Numbered paging over an API that only knows how to go forward.
 *
 * The reads here are keyset-paged: each response carries the rows and an opaque
 * cursor for the page after it, and never a total. A control offering "jump to
 * page 9" would be offering something the browser has no cursor for and the
 * server has no route to — so what this keeps instead is the trail of pages
 * already reached.
 *
 * The trail only ever grows. Going back to page 2 from page 5 does not discard
 * the cursors for 3, 4 and 5: those pages were real, their cursors are still
 * valid keyset positions, and forgetting them would make paging back a one-way
 * trip costing four clicks to undo. That is the whole difference between this
 * and the Previous/Next pair it replaces.
 *
 * Cursors are positions rather than offsets, so a row inserted while somebody
 * is on page 3 shifts nothing underneath them — the property that makes keeping
 * a trail safe rather than a slow source of drift.
 *
 * The next cursor is passed in at the call rather than held here, and that
 * ordering is forced: the cursor for the current page has to exist before the
 * request that discovers the next one can be made. Taking it as an argument is
 * what keeps the panel's `cursor → load → response` chain a straight line
 * instead of a circle.
 */
export interface PageTrail {
  /** The cursor for the current page. `undefined` on the first. */
  cursor: string | undefined;
  /** The current page, 1-based. */
  page: number;
  /** How many pages have been reached. */
  pageCount: number;
  /** Whether anything exists past the current page, given the latest response. */
  hasNext: (nextCursor: string | null | undefined) => boolean;
  /** Move to a page in the trail, or one step past the end of it. */
  go: (page: number, nextCursor: string | null | undefined) => void;
  /** Back to page one with an empty trail, for when the filter changes. */
  reset: () => void;
}

export function usePageTrail(): PageTrail {
  const [trail, setTrail] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(1);

  const reset = useCallback(() => {
    setTrail([undefined]);
    setPage(1);
  }, []);

  const go = useCallback((target: number, nextCursor: string | null | undefined) => {
    if (target < 1) return;

    setTrail((current) => {
      if (target <= current.length) {
        setPage(target);
        return current;
      }
      // One step past the end is the only forward move that exists, and only
      // when the server has said there is somewhere to go.
      //
      // The last clause is the one that is not obvious. Between clicking
      // forward and the new page arriving, the cursor in hand still belongs to
      // the page being left — so a second click in that window would append the
      // cursor already at the end of the trail and mint a duplicate page
      // showing the rows the reader is already looking at. Refusing a cursor
      // the trail ends with makes the extra click a no-op instead.
      if (
        target === current.length + 1 &&
        nextCursor &&
        nextCursor !== current[current.length - 1]
      ) {
        setPage(target);
        return [...current, nextCursor];
      }
      return current;
    });
  }, []);

  const hasNext = useCallback(
    (nextCursor: string | null | undefined) => page < trail.length || Boolean(nextCursor),
    [page, trail.length]
  );

  return { cursor: trail[page - 1], page, pageCount: trail.length, hasNext, go, reset };
}
