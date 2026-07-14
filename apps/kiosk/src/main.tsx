import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PRODUCT_SCOPE } from "@printing-kiosk/contracts";

import "./styles.css";

function App() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="phase-title">
        <p className="eyebrow">Phase 0</p>
        <h1 id="phase-title">Printing kiosk foundation is ready</h1>
        <p>
          Product scope: print-only, {PRODUCT_SCOPE.outputMode.toLowerCase()} output. Customer
          workflows begin in Phase 1.
        </p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("ROOT_ELEMENT_MISSING");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
