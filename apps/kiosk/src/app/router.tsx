import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";

interface NavigateOptions {
  replace?: boolean;
}

interface RouterContextValue {
  pathname: string;
  navigate: (path: string, options?: NavigateOptions) => void;
}

const RouterContext = createContext<RouterContextValue | null>(null);

export function KioskRouterProvider({
  children,
  initialPath
}: {
  children: ReactNode;
  initialPath?: string;
}) {
  const browserBacked = initialPath === undefined;
  const [pathname, setPathname] = useState(() =>
    browserBacked ? readHashPath() : normalizeInternalPath(initialPath)
  );

  useEffect(() => {
    if (!browserBacked) return;
    const synchronize = () => setPathname(readHashPath());
    window.addEventListener("hashchange", synchronize);
    return () => window.removeEventListener("hashchange", synchronize);
  }, [browserBacked]);

  const navigate = useCallback(
    (path: string, options: NavigateOptions = {}) => {
      const nextPath = normalizeInternalPath(path);
      if (browserBacked) {
        const nextUrl = `${window.location.pathname}${window.location.search}#${nextPath}`;
        if (options.replace) {
          window.history.replaceState(null, "", nextUrl);
        } else {
          window.history.pushState(null, "", nextUrl);
        }
      }
      setPathname(nextPath);
    },
    [browserBacked]
  );

  const value = useMemo(() => ({ pathname, navigate }), [navigate, pathname]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useKioskLocation(): { pathname: string } {
  const context = useRouterContext();
  return { pathname: context.pathname };
}

export function useKioskNavigate(): RouterContextValue["navigate"] {
  return useRouterContext().navigate;
}

export function KioskRedirect({ to, replace = true }: { to: string; replace?: boolean }) {
  const navigate = useKioskNavigate();
  useEffect(() => navigate(to, { replace }), [navigate, replace, to]);
  return null;
}

function useRouterContext(): RouterContextValue {
  const context = useContext(RouterContext);
  if (!context) throw new Error("KIOSK_ROUTER_CONTEXT_MISSING");
  return context;
}

function readHashPath(): string {
  const hashPath = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return normalizeInternalPath(hashPath || "/");
}

function normalizeInternalPath(path: string): string {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return "/";
  }
  const withoutQuery = path.split(/[?#]/u, 1)[0] || "/";
  return withoutQuery.length <= 200 ? withoutQuery : "/";
}
