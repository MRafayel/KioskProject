import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useMemo,
  useReducer
} from "react";

import {
  initialPrototypeState,
  prototypeReducer,
  type PrototypeAction,
  type PrototypeState
} from "./model.js";

interface PrototypeSessionContextValue {
  state: PrototypeState;
  dispatch: Dispatch<PrototypeAction>;
}

const PrototypeSessionContext = createContext<PrototypeSessionContextValue | null>(null);

export function PrototypeSessionProvider({
  children,
  initialState = initialPrototypeState
}: {
  children: ReactNode;
  initialState?: PrototypeState;
}) {
  const [state, dispatch] = useReducer(prototypeReducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return (
    <PrototypeSessionContext.Provider value={value}>{children}</PrototypeSessionContext.Provider>
  );
}

export function usePrototypeSession(): PrototypeSessionContextValue {
  const context = useContext(PrototypeSessionContext);
  if (!context) throw new Error("PROTOTYPE_SESSION_CONTEXT_MISSING");
  return context;
}
