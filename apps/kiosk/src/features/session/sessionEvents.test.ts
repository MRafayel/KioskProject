import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@printing-kiosk/contracts";

import { subscribeToSessionEvents } from "./sessionEvents.js";

const sessionId = "01900000-0000-7000-8000-000000000010";

describe("subscribeToSessionEvents", () => {
  it("delivers only valid consecutive events and deduplicates reconnect data", () => {
    const source = new FakeEventSource();
    const received: SessionEvent[] = [];
    const desynchronized = vi.fn();
    const close = subscribeToSessionEvents(
      sessionId,
      {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onEvent: (event) => received.push(event),
        onDesynchronized: desynchronized
      },
      () => source as unknown as EventSource
    );

    source.message(event(1));
    source.message(event(1));
    source.message(event(3));
    source.message({ ...event(2), sessionId: "01900000-0000-7000-8000-000000000099" });
    source.message(event(2));

    expect(received.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(desynchronized).toHaveBeenCalledTimes(2);
    close();
    expect(source.closed).toBe(true);
  });

  it("falls back cleanly when EventSource is unavailable", () => {
    const disconnected = vi.fn();
    const close = subscribeToSessionEvents(
      sessionId,
      {
        onConnected: vi.fn(),
        onDisconnected: disconnected,
        onEvent: vi.fn(),
        onDesynchronized: vi.fn()
      },
      undefined
    );

    expect(disconnected).toHaveBeenCalledOnce();
    expect(close()).toBeUndefined();
  });

  it("delivers terminal history replayed before the stream open signal", () => {
    const source = new FakeEventSource();
    const connected = vi.fn();
    const received: SessionEvent[] = [];
    const close = subscribeToSessionEvents(
      sessionId,
      {
        onConnected: connected,
        onDisconnected: vi.fn(),
        onEvent: (receivedEvent) => received.push(receivedEvent),
        onDesynchronized: vi.fn()
      },
      () => source as unknown as EventSource
    );

    source.message(event(1));
    source.message(expiredEvent(2));

    expect(connected).not.toHaveBeenCalled();
    expect(received.map(({ type }) => type)).toEqual(["mobile.connected", "session.expired"]);
    close();
  });
});

class FakeEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public closed = false;

  public message(input: unknown): void {
    this.onmessage?.({ data: JSON.stringify(input) } as MessageEvent);
  }

  public close(): void {
    this.closed = true;
  }
}

function event(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    type: "mobile.connected",
    payload: { sessionId },
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
}

function expiredEvent(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    type: "session.expired",
    payload: { sessionId, state: "EXPIRED", version: 2 },
    occurredAt: "2030-01-01T00:00:01.000Z"
  };
}
