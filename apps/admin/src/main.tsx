import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("ADMIN_ROOT_MISSING");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
