import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./app/App.js";
import { KioskErrorBoundary } from "./app/KioskErrorBoundary.js";
import { LanguageProvider } from "./features/i18n/LanguageProvider.js";
import { PrototypeSessionProvider } from "./features/session/PrototypeSessionProvider.js";

import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
    queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }
  }
});

const root = document.getElementById("root");
if (!root) throw new Error("ROOT_ELEMENT_MISSING");

createRoot(root).render(
  <StrictMode>
    <LanguageProvider>
      <KioskErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <PrototypeSessionProvider>
            <App />
          </PrototypeSessionProvider>
        </QueryClientProvider>
      </KioskErrorBoundary>
    </LanguageProvider>
  </StrictMode>
);
