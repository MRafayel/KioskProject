import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@printing-kiosk/contracts";

import { subscribeToMobileSessionEvents } from "./sessionEvents.js";

const publicSessionId = "ps_1234567890abcdef";
const sessionId = "01900000-0000-7000-8000-000000000081";
const otherSessionId = "01900000-0000-7000-8000-000000000082";

describe("subscribeToMobileSessionEvents", () => {
  it("uses the credentialed private stream and treats safe file events as refresh wakeups", () => {
    const source = new FakeEventSource();
    const terminal = vi.fn();
    const filesChanged = vi.fn();
    const factory = vi.fn(() => source as unknown as EventSource);
    const close = subscribeToMobileSessionEvents(
      publicSessionId,
      sessionId,
      {
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onFilesChanged: filesChanged,
        onTerminal: terminal,
        onDesynchronized: vi.fn()
      },
      factory
    );

    source.message(event("mobile.connected", 1));
    source.message(fileReadyEvent(2));
    source.message(fileRejectedEvent(3));
    source.message(fileDeletedEvent(4));
    source.message(event("session.canceled", 5));

    expect(factory).toHaveBeenCalledWith(`/v1/mobile-auth/${publicSessionId}/events/stream`, {
      withCredentials: true
    });
    expect(filesChanged).toHaveBeenCalledTimes(3);
    expect(filesChanged).toHaveBeenNthCalledWith(1, fileReadyEvent(2));
    expect(filesChanged).toHaveBeenNthCalledWith(2, fileRejectedEvent(3));
    expect(filesChanged).toHaveBeenNthCalledWith(3, fileDeletedEvent(4));
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(event("session.canceled", 5));
    close();
    expect(source.closed).toBe(true);
  });

  it("rejects malformed or cross-session messages and reports connection loss", () => {
    const source = new FakeEventSource();
    const disconnected = vi.fn();
    const desynchronized = vi.fn();
    subscribeToMobileSessionEvents(
      publicSessionId,
      sessionId,
      {
        onConnected: vi.fn(),
        onDisconnected: disconnected,
        onFilesChanged: vi.fn(),
        onTerminal: vi.fn(),
        onDesynchronized: desynchronized
      },
      () => source as unknown as EventSource
    );

    source.rawMessage("not-json");
    source.message({ ...event("session.expired", 2), sessionId: otherSessionId });
    source.fail();

    expect(desynchronized).toHaveBeenCalledTimes(2);
    expect(disconnected).toHaveBeenCalledOnce();
  });
});

class FakeEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public closed = false;

  public message(input: unknown): void {
    this.rawMessage(JSON.stringify(input));
  }

  public rawMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  public fail(): void {
    this.onerror?.({} as Event);
  }

  public close(): void {
    this.closed = true;
  }
}

function fileReadyEvent(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    type: "file.ready",
    payload: {
      sessionId,
      file: {
        id: "01900000-0000-7000-8000-000000000083",
        ordinal: 0,
        status: "READY",
        kind: "PDF",
        sizeBytes: 2_048,
        pageCount: 2,
        processingRevision: 1,
        rejectionCode: null,
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    },
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
}

function fileRejectedEvent(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    type: "file.rejected",
    payload: {
      sessionId,
      file: {
        id: "01900000-0000-7000-8000-000000000083",
        ordinal: 0,
        status: "REJECTED",
        kind: "PDF",
        sizeBytes: 2_048,
        pageCount: null,
        processingRevision: 1,
        rejectionCode: "DOCUMENT_MALFORMED",
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    },
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
}

function fileDeletedEvent(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    type: "file.deleted",
    payload: {
      sessionId,
      fileId: "01900000-0000-7000-8000-000000000083"
    },
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
}

function event(
  type: "mobile.connected" | "session.canceled" | "session.expired",
  sequence: number
): SessionEvent {
  const base = {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
  if (type === "mobile.connected") {
    return { ...base, type, payload: { sessionId } };
  }
  return {
    ...base,
    type,
    payload: {
      sessionId,
      state: type === "session.canceled" ? "CANCELED" : "EXPIRED",
      version: sequence
    }
  };
}
