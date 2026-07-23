import { describe, expect, it, vi } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";
import type { SessionEvent } from "@printing-kiosk/contracts";

import { SessionEventRelay } from "./events.js";

const sessionId = "01900000-0000-7000-8000-000000000010";

describe("SessionEventRelay", () => {
  it("replays ordered pages with the private credential and no duplicate delivery", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const event1 = event(1, "session.created");
    const event2 = event(2, "mobile.connected");
    const upstreamFetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization")
      });
      const after = new URL(url).searchParams.get("after");
      return Promise.resolve(
        Response.json(
          after === "0"
            ? { events: [event1], latestSequence: 2, hasMore: true }
            : { events: [event2], latestSequence: 2, hasMore: false }
        )
      );
    });
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
    });
    const relay = new SessionEventRelay(environment, upstreamFetch);
    const received: SessionEvent[] = [];

    const unsubscribe = relay.subscribe(sessionId, 0, (receivedEvent) =>
      received.push(receivedEvent)
    );
    await vi.waitFor(() => expect(received.map(({ sequence }) => sequence)).toEqual([1, 2]));

    relay.accept(event2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(requests.map(({ url }) => new URL(url).searchParams.get("after"))).toEqual(["0", "1"]);
    expect(
      requests.every(({ authorization }) => authorization === "Bearer test-kiosk-api-key-000000")
    ).toBe(true);
    unsubscribe();
  });

  it("uses replay instead of trusting an out-of-order socket event", async () => {
    const event1 = event(1, "session.created");
    const event2 = event(2, "mobile.connected");
    let latestSequence = 1;
    const upstreamFetch = vi.fn((input: string | URL) => {
      const after = Number(new URL(String(input)).searchParams.get("after"));
      const events = after === 0 ? [event1] : latestSequence === 2 ? [event2] : [];
      return Promise.resolve(Response.json({ events, latestSequence, hasMore: false }));
    });
    const relay = new SessionEventRelay(
      loadEnvironment({ NODE_ENV: "test", API_ORIGIN: "https://api.example.test" }),
      upstreamFetch
    );
    const received: SessionEvent[] = [];
    const unsubscribe = relay.subscribe(sessionId, 0, (receivedEvent) =>
      received.push(receivedEvent)
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    latestSequence = 2;
    relay.accept({
      ...event2,
      sequence: 3
    });
    await vi.waitFor(() => expect(received.map(({ sequence }) => sequence)).toEqual([1, 2]));
    expect(received.some(({ sequence }) => sequence === 3)).toBe(false);
    unsubscribe();
  });

  it("does not lose a socket wake-up that arrives during an active replay", async () => {
    const event1 = event(1, "session.created");
    const event2 = event(2, "mobile.connected");
    let releaseFirstPage: (() => void) | undefined;
    let requestCount = 0;
    const upstreamFetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstPage = resolve;
        });
        return Response.json({ events: [event1], latestSequence: 1, hasMore: false });
      }
      return Response.json({ events: [event2], latestSequence: 2, hasMore: false });
    });
    const relay = new SessionEventRelay(
      loadEnvironment({ NODE_ENV: "test", API_ORIGIN: "https://api.example.test" }),
      upstreamFetch
    );
    const received: SessionEvent[] = [];
    const unsubscribe = relay.subscribe(sessionId, 0, (receivedEvent) =>
      received.push(receivedEvent)
    );
    await vi.waitFor(() => expect(releaseFirstPage).toBeTypeOf("function"));

    relay.accept(event2);
    releaseFirstPage?.();

    await vi.waitFor(() => expect(received.map(({ sequence }) => sequence)).toEqual([1, 2]));
    expect(requestCount).toBe(2);
    unsubscribe();
  });
});

function event(sequence: number, type: "session.created" | "mobile.connected"): SessionEvent {
  const base = {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
  return type === "session.created"
    ? {
        ...base,
        type,
        payload: { sessionId, state: "WAITING_FOR_UPLOAD", version: 1 }
      }
    : { ...base, type, payload: { sessionId } };
}
