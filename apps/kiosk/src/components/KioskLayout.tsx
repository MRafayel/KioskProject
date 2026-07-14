import { useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";

import { PRODUCT_SCOPE } from "@printing-kiosk/contracts";

import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";

const steps = [
  { path: "/upload", label: "Upload" },
  { path: "/configure", label: "Settings" },
  { path: "/checkout", label: "Pay" },
  { path: "/printing", label: "Print" }
] as const;

export function KioskLayout() {
  const { state, dispatch } = usePrototypeSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [cancelOpen, setCancelOpen] = useState(false);

  if (!state.session) return <Navigate to="/" replace />;

  const currentStep = stepIndex(location.pathname);
  const canCancel = ["/upload", "/configure", "/checkout"].includes(location.pathname);

  const cancelSession = () => {
    dispatch({ type: "RESET" });
    setCancelOpen(false);
    void navigate("/", { replace: true });
  };

  return (
    <div className="kiosk-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>Print kiosk</strong>
            <small>{PRODUCT_SCOPE.outputMode.toLowerCase()} documents</small>
          </span>
        </div>

        <ol className="stepper" aria-label="Print progress">
          {steps.map((step, index) => (
            <li
              key={step.path}
              className={
                index <= currentStep ? "stepper__item stepper__item--active" : "stepper__item"
              }
              aria-current={index === currentStep ? "step" : undefined}
            >
              <span>{index + 1}</span>
              {step.label}
            </li>
          ))}
        </ol>

        {canCancel ? (
          <button
            className="button button--quiet topbar__cancel"
            type="button"
            onClick={() => setCancelOpen(true)}
          >
            Cancel
          </button>
        ) : (
          <span className="topbar__placeholder" aria-hidden="true" />
        )}
      </header>

      <main className="screen" id="main-content">
        <Outlet />
      </main>

      <footer className="privacy-strip">
        <span aria-hidden="true">●</span> Private files are removed automatically after this
        session.
      </footer>

      {cancelOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
            <div className="status-mark status-mark--small" aria-hidden="true">
              ?
            </div>
            <h2 id="cancel-title">Cancel this print session?</h2>
            <p>No payment will be made. Uploaded files will be removed.</p>
            <div className="button-row">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setCancelOpen(false)}
                autoFocus
              >
                Keep session
              </button>
              <button className="button button--danger" type="button" onClick={cancelSession}>
                Cancel session
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function stepIndex(pathname: string): number {
  if (pathname.startsWith("/configure")) return 1;
  if (pathname.startsWith("/checkout") || pathname.startsWith("/payment")) return 2;
  if (
    pathname.startsWith("/printing") ||
    pathname.startsWith("/complete") ||
    pathname.startsWith("/failure")
  )
    return 3;
  return 0;
}
