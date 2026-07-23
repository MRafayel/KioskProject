import { sessionEventSchema, type SessionEvent } from "@printing-kiosk/contracts";

export interface SessionEventHandlers {
  onConnected(): void;
  onDisconnected(): void;
  onEvent(event: SessionEvent): void;
  onDesynchronized(): void;
}

type EventSourceFactory = (url: string) => EventSource;

export function subscribeToSessionEvents(
  sessionId: string,
  handlers: SessionEventHandlers,
  factory: EventSourceFactory | undefined = defaultEventSourceFactory()
): () => void {
  if (!factory) {
    handlers.onDisconnected();
    return () => undefined;
  }

  let cursor = 0;
  const source = factory(
    `/agent/v1/sessions/${encodeURIComponent(sessionId)}/events/stream?after=${cursor}`
  );
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
    if (parsed.data.sequence <= cursor) return;
    if (parsed.data.sequence !== cursor + 1) {
      handlers.onDesynchronized();
      return;
    }
    cursor = parsed.data.sequence;
    handlers.onEvent(parsed.data);
  };

  return () => source.close();
}

function defaultEventSourceFactory(): EventSourceFactory | undefined {
  if (typeof globalThis.EventSource !== "function") return undefined;
  return (url) => new globalThis.EventSource(url);
}
