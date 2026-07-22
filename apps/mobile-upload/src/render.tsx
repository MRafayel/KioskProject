import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./app/App.js";
import {
  createMobileBootstrap,
  getPublicSessionIdFromPath,
  type CapturedQrGrant
} from "./features/join/bootstrap.js";

export function mountMobileUpload(capturedGrant: CapturedQrGrant): void {
  const publicSessionId = getPublicSessionIdFromPath(window.location.pathname);
  const bootstrap = publicSessionId ? createMobileBootstrap(publicSessionId, capturedGrant) : null;

  const root = document.getElementById("root");
  if (!root) throw new Error("ROOT_ELEMENT_MISSING");

  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App bootstrap={bootstrap} />
      </BrowserRouter>
    </StrictMode>
  );
}
