import { sessionEventSchema, type SessionEvent } from "@printing-kiosk/contracts";

export interface MobileSessionEventHandlers {
  onConnected(): void;
  onDisconnected(): void;
  onFilesChanged(
    event: Extract<SessionEvent, { type: "file.ready" | "file.rejected" | "file.deleted" }>
  ): void;
  onTerminal(event: Extract<SessionEvent, { type: "session.canceled" | "session.expired" }>): void;
  onDesynchronized(): void;
}

type EventSourceFactory = (url: string, options: EventSourceInit) => EventSource;

export function subscribeToMobileSessionEvents(
  publicSessionId: string,
  sessionId: string,
  handlers: MobileSessionEventHandlers,
  factory: EventSourceFactory | undefined = defaultEventSourceFactory()
): () => void {
  if (!factory) {
    handlers.onDisconnected();
    return () => undefined;
  }

  const source = factory(`/v1/mobile-auth/${encodeURIComponent(publicSessionId)}/events/stream`, {
    withCredentials: true
  });
  source.onopen = () => handlers.onConnected();
  source.onerror = () => handlers.onDisconnected();
  source.onmessage = (message) => {
    let input: unknown;
    try {
      input = JSON.parse(message.data as string);
    } catch {
      handlers.onDesynchronized();
      return;
    }

    const parsed = sessionEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.sessionId !== sessionId) {
      handlers.onDesynchronized();
      return;
    }
    if (
      parsed.data.type === "file.ready" ||
      parsed.data.type === "file.rejected" ||
      parsed.data.type === "file.deleted"
    ) {
      // Durable events are wakeups only. The phone never trusts event payloads
      // as current file state; it refreshes the authorized session snapshot.
      handlers.onFilesChanged(parsed.data);
      return;
    }
    if (parsed.data.type === "session.canceled" || parsed.data.type === "session.expired") {
      handlers.onTerminal(parsed.data);
    }
  };

  return () => source.close();
}

function defaultEventSourceFactory(): EventSourceFactory | undefined {
  if (typeof globalThis.EventSource !== "function") return undefined;
  return (url, options) => new globalThis.EventSource(url, options);
}
