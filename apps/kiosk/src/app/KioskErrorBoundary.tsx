import { Component, type ErrorInfo, type ReactNode } from "react";

import { useLanguage } from "../features/i18n/LanguageProvider.js";

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

    return <LocalizedErrorFallback />;
  }
}

function LocalizedErrorFallback() {
  const { messages } = useLanguage();

  return (
    <main className="terminal-state terminal-state--error">
      <div className="status-mark" aria-hidden="true">
        !
      </div>
      <p className="eyebrow">{messages.error.eyebrow}</p>
      <h1>{messages.error.title}</h1>
      <p>{messages.error.description}</p>
      <button
        className="button button--primary"
        type="button"
        onClick={() => window.location.reload()}
      >
        {messages.error.restart}
      </button>
    </main>
  );
}
