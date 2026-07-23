import { io, type Socket } from "socket.io-client";

import type { Environment } from "@printing-kiosk/config";
import {
  SESSION_EVENT_SOCKET_NAME,
  sessionEventReplayResponseSchema,
  sessionEventSchema,
  type SessionEvent
} from "@printing-kiosk/contracts";

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type EventListener = (event: SessionEvent) => void;

interface Subscription {
  cursor: number;
  closed: boolean;
  syncing: boolean;
  resyncRequested: boolean;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  listener: EventListener;
}

export interface SessionEventSource {
  subscribe(sessionId: string, after: number, listener: EventListener): () => void;
}

/**
 * Keeps one ordered cursor per local browser subscription. PostgreSQL replay is
 * the source of truth; Socket.IO only prompts the relay to fetch missing data.
 */
export class SessionEventRelay implements SessionEventSource {
  private readonly subscriptions = new Map<string, Set<Subscription>>();

  public constructor(
    private readonly environment: Environment,
    private readonly upstreamFetch: UpstreamFetch = globalThis.fetch
  ) {}

  public subscribe(sessionId: string, after: number, listener: EventListener): () => void {
    const subscription: Subscription = {
      cursor: after,
      closed: false,
      syncing: false,
      resyncRequested: false,
      retryTimer: undefined,
      listener
    };
    const sessionSubscriptions = this.subscriptions.get(sessionId) ?? new Set<Subscription>();
    sessionSubscriptions.add(subscription);
    this.subscriptions.set(sessionId, sessionSubscriptions);
    void this.synchronize(sessionId, subscription);

    return () => {
      subscription.closed = true;
      if (subscription.retryTimer) clearTimeout(subscription.retryTimer);
      sessionSubscriptions.delete(subscription);
      if (sessionSubscriptions.size === 0) this.subscriptions.delete(sessionId);
    };
  }

  public accept(input: unknown): void {
    const parsed = sessionEventSchema.safeParse(input);
    if (!parsed.success) return;

    for (const subscription of this.subscriptions.get(parsed.data.sessionId) ?? []) {
      if (parsed.data.sequence <= subscription.cursor) continue;
      // Do not trust a best-effort socket event to fill a sequence gap. Replay
      // returns the durable, ordered stream and deduplicates reconnects.
      void this.synchronize(parsed.data.sessionId, subscription);
    }
  }

  public synchronizeAll(): void {
    for (const [sessionId, subscriptions] of this.subscriptions) {
      for (const subscription of subscriptions) void this.synchronize(sessionId, subscription);
    }
  }

  private async synchronize(sessionId: string, subscription: Subscription): Promise<void> {
    if (subscription.closed) return;
    if (subscription.syncing) {
      subscription.resyncRequested = true;
      return;
    }
    subscription.syncing = true;
    subscription.resyncRequested = false;
    if (subscription.retryTimer) clearTimeout(subscription.retryTimer);
    subscription.retryTimer = undefined;

    try {
      let hasMore = true;
      while (hasMore && !subscription.closed) {
        const cursorBeforePage = subscription.cursor;
        const replay = await this.fetchReplay(sessionId, subscription.cursor);
        for (const event of replay.events) {
          if (event.sequence <= subscription.cursor) continue;
          if (event.sequence !== subscription.cursor + 1) {
            throw new Error("SESSION_EVENT_SEQUENCE_GAP");
          }
          subscription.listener(event);
          subscription.cursor = event.sequence;
        }
        hasMore = replay.hasMore;
        if (hasMore && subscription.cursor === cursorBeforePage) {
          throw new Error("SESSION_EVENT_REPLAY_STALLED");
        }

        // eventSequence advances in the same transaction as the outbox row.
        // Materialization follows shortly afterwards, so retry if the durable
        // event table has not caught up yet.
        if (!hasMore && subscription.cursor < replay.latestSequence) {
          this.scheduleRetry(sessionId, subscription);
        }
      }
    } catch {
      this.scheduleRetry(sessionId, subscription);
    } finally {
      subscription.syncing = false;
      if (subscription.resyncRequested && !subscription.closed) {
        void this.synchronize(sessionId, subscription);
      }
    }
  }

  private async fetchReplay(sessionId: string, after: number) {
    const url = new URL(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      this.environment.API_ORIGIN
    );
    url.searchParams.set("after", String(after));
    const response = await this.upstreamFetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.environment.DEV_KIOSK_API_KEY}`
      }
    });
    if (!response.ok) throw new Error("SESSION_EVENT_REPLAY_FAILED");
    return sessionEventReplayResponseSchema.parse(await response.json());
  }

  private scheduleRetry(sessionId: string, subscription: Subscription): void {
    if (subscription.closed || subscription.retryTimer) return;
    subscription.retryTimer = setTimeout(() => {
      subscription.retryTimer = undefined;
      void this.synchronize(sessionId, subscription);
    }, 1_000);
    subscription.retryTimer.unref?.();
  }
}

export class CloudRealtimeConnection {
  private readonly socket: Socket;

  public constructor(environment: Environment, relay: SessionEventRelay) {
    this.socket = io(environment.API_ORIGIN, {
      path: "/socket.io",
      transports: ["websocket"],
      upgrade: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
      auth: {
        kioskId: environment.DEV_KIOSK_ID,
        credential: environment.DEV_KIOSK_API_KEY
      }
    });
    this.socket.on(SESSION_EVENT_SOCKET_NAME, (event: unknown) => relay.accept(event));
    this.socket.on("connect", () => relay.synchronizeAll());
  }

  public close(): void {
    this.socket.close();
  }
}
