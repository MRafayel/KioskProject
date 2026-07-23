import type { SessionEvent } from "@printing-kiosk/contracts";

export type SessionEventListener = (event: SessionEvent) => void;

export interface SessionEventSource {
  subscribe(sessionId: string, listener: SessionEventListener): () => void;
}

export interface SessionEventSink {
  publish(event: SessionEvent): void;
}

/**
 * Fans a validated durable event out to long-lived HTTP clients attached to
 * this API instance. PostgreSQL remains authoritative; this bus only removes
 * notification latency.
 */
export class LocalSessionEventBus implements SessionEventSource, SessionEventSink {
  private readonly listeners = new Map<string, Set<SessionEventListener>>();

  public subscribe(sessionId: string, listener: SessionEventListener): () => void {
    const sessionListeners = this.listeners.get(sessionId) ?? new Set<SessionEventListener>();
    sessionListeners.add(listener);
    this.listeners.set(sessionId, sessionListeners);

    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  public publish(event: SessionEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A disconnected HTTP client must not fail durable queue delivery.
      }
    }
  }
}
