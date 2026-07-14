import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class KioskErrorBoundary extends Component<Props, State> {
  public override state: State = { failed: false };

  public static getDerivedStateFromError(): State {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("KIOSK_UI_ERROR", { error: error.message, componentStack: info.componentStack });
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="terminal-state terminal-state--error">
        <div className="status-mark" aria-hidden="true">
          !
        </div>
        <p className="eyebrow">Kiosk recovery</p>
        <h1>Something went wrong</h1>
        <p>Your documents have not been printed or charged.</p>
        <button
          className="button button--primary"
          type="button"
          onClick={() => window.location.reload()}
        >
          Restart kiosk
        </button>
      </main>
    );
  }
}
