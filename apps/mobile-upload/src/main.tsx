import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PRODUCT_SCOPE } from "@printing-kiosk/contracts";

import "./styles.css";

function App() {
  return (
    <main>
      <p className="eyebrow">Phase 0</p>
      <h1>Secure mobile upload foundation</h1>
      <p>
        This service will accept PDF, JPEG, and PNG files for{" "}
        {PRODUCT_SCOPE.outputMode.toLowerCase()} printing in Phase 3.
      </p>
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
