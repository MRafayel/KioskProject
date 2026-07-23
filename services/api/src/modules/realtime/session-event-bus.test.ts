import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@printing-kiosk/contracts";

import { LocalSessionEventBus } from "./session-event-bus.js";

const sessionId = "01900000-0000-7000-8000-000000000061";
const otherSessionId = "01900000-0000-7000-8000-000000000062";

describe("LocalSessionEventBus", () => {
  it("delivers only to the owning session and stops after unsubscribe", () => {
    const bus = new LocalSessionEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(sessionId, listener);

    bus.publish(sessionEvent(otherSessionId, 1));
    bus.publish(sessionEvent(sessionId, 2));
    unsubscribe();
    bus.publish(sessionEvent(sessionId, 3));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(sessionEvent(sessionId, 2));
  });

  it("isolates a disconnected listener from other subscribers", () => {
    const bus = new LocalSessionEventBus();
    const healthy = vi.fn();
    bus.subscribe(sessionId, () => {
      throw new Error("DISCONNECTED_CLIENT");
    });
    bus.subscribe(sessionId, healthy);

    expect(() => bus.publish(sessionEvent(sessionId, 1))).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });
});

function sessionEvent(id: string, sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: id,
    sequence,
    type: "session.canceled",
    payload: { sessionId: id, state: "CANCELED", version: sequence },
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
}
