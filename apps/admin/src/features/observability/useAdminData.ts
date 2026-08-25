import { useCallback, useEffect, useState } from "react";

import { useSession } from "../auth/SessionProvider.js";
import { AdminApiError } from "../auth/api.js";

/**
 * Load one read, and keep it fresh by asking again.
 *
 * Polling rather than a live socket, deliberately. A socket subscription for
 * the dashboard would mean giving admin connections a path into per-session
 * event streams, which widens the surface for no operational gain at five
 * people — and a number that is ten seconds old has never been the reason an
 * incident went unnoticed.
 *
 * A poll never overlaps its predecessor and never fires while the tab is
 * hidden, so a forgotten dashboard costs nothing.
 *
 * The loader's identity is also the query key: callers memoize it with
 * `useCallback`, and changing one of its dependencies starts a fresh read.
 * This is what keeps controls such as state filters and pagination cursors in
 * sync with the rows returned by the server.
 */

export interface AdminDataState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useAdminData<T>(
  load: () => Promise<T>,
  options: { refreshMilliseconds?: number; enabled?: boolean } = {}
): AdminDataState<T> {
  const session = useSession();
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const run = async () => {
      try {
        const next = await load();
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        // A dead session is the whole page's problem, not this panel's: the
        // provider takes the operator back to sign-in.
        if (session.handleAuthenticationError(caught)) return;
        setError(describe(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const schedule = () => {
      const interval = options.refreshMilliseconds;
      if (!interval) return;
      timer = window.setTimeout(() => {
        void (async () => {
          // Nothing to refresh for a tab nobody is looking at.
          if (document.visibilityState === "visible") await run();
          if (!cancelled) schedule();
        })();
      }, interval);
    };

    setLoading(true);
    void run().then(() => {
      if (!cancelled) schedule();
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, load, nonce, options.refreshMilliseconds, session.handleAuthenticationError]);

  return { data, error, loading, reload };
}

function describe(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  return "Could not reach the control plane.";
}
