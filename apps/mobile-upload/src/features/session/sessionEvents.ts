import { sessionEventSchema, type SessionEvent } from "@printing-kiosk/contracts";

export interface MobileSessionEventHandlers {
  onConnected(): void;
  onDisconnected(): void;
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
