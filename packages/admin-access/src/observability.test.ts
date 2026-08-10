import { describe, expect, it } from "vitest";

import {
  ADMIN_ATTENTION_CODES,
  KIOSK_DEGRADED_WINDOW_MILLISECONDS,
  KIOSK_ONLINE_WINDOW_MILLISECONDS,
  adminAuditEntrySchema,
  adminDocumentSchema,
  adminPrintJobSchema,
  adminTimelineEntrySchema,
  classifyKioskLiveness,
  decodeAdminCursor,
  deriveAttention,
  encodeAdminCursor,
  severityOfAttention
} from "./observability.js";

const now = new Date("2026-08-10T12:00:00.000Z");

describe("kiosk liveness", () => {
  it("treats a kiosk that has never checked in as distinct from one that stopped", () => {
    // "Never seen" is a provisioning problem; "offline" is an operational one.
    // Collapsing them sends somebody to look at the wrong thing.
    expect(classifyKioskLiveness(null, now)).toBe("NEVER_SEEN");
    expect(classifyKioskLiveness(new Date(now.getTime() - 86_400_000), now)).toBe("OFFLINE");
  });

  it("tolerates one missed heartbeat before reporting anything", () => {
    // The kiosk writes at most once a minute, so a single skipped write must
    // not light up the dashboard.
    expect(classifyKioskLiveness(new Date(now.getTime() - 70_000), now)).toBe("ONLINE");
    expect(
      classifyKioskLiveness(new Date(now.getTime() - KIOSK_ONLINE_WINDOW_MILLISECONDS), now)
    ).toBe("ONLINE");
    expect(
      classifyKioskLiveness(new Date(now.getTime() - KIOSK_ONLINE_WINDOW_MILLISECONDS - 1), now)
    ).toBe("DEGRADED");
  });

  it("escalates to offline at the degraded boundary", () => {
    expect(
      classifyKioskLiveness(new Date(now.getTime() - KIOSK_DEGRADED_WINDOW_MILLISECONDS), now)
    ).toBe("DEGRADED");
    expect(
      classifyKioskLiveness(new Date(now.getTime() - KIOSK_DEGRADED_WINDOW_MILLISECONDS - 1), now)
    ).toBe("OFFLINE");
  });

  it("does not report a clock-skewed future heartbeat as offline", () => {
    expect(classifyKioskLiveness(new Date(now.getTime() + 30_000), now)).toBe("ONLINE");
  });
});

describe("pagination cursors", () => {
  it("round-trips a position", () => {
    const cursor = { at: now, id: "0195f0d0-0000-7000-8000-000000000001" };
    expect(decodeAdminCursor(encodeAdminCursor(cursor))).toEqual(cursor);
  });

  it("round-trips a non-uuid identifier", () => {
    // Kiosk identifiers are short strings, not UUIDs, and pages are keyed by
    // whatever identifier the list is ordered on.
    const cursor = { at: now, id: "kiosk_dev_001" };
    expect(decodeAdminCursor(encodeAdminCursor(cursor))).toEqual(cursor);
  });

  it("rejects anything malformed instead of throwing", () => {
    // A cursor arrives in a query string. Every one of these is something an
    // attacker can send, and none may reach a query builder.
    for (const value of [
      "",
      "no-separator",
      ".missing-timestamp",
      `${now.getTime()}.`,
      `not-a-number.${"abc"}`,
      `${now.getTime()}.' OR 1=1--`,
      `${now.getTime()}.${"x".repeat(81)}`,
      `${"9".repeat(16)}.abc`,
      `${now.getTime()}.abc\nInjected: header`
    ]) {
      expect(decodeAdminCursor(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("attention ranking", () => {
  it("drops everything that is at zero", () => {
    // A worklist that always has the same eight rows is a worklist nobody reads.
    expect(deriveAttention({})).toEqual([]);
    expect(deriveAttention({ KIOSK_OFFLINE: 0 })).toEqual([]);
  });

  it("puts undeleted documents above everything else", () => {
    const ranked = deriveAttention({
      KIOSK_OFFLINE: 99,
      RETENTION_OVERDUE: 1,
      PAYMENT_EXPIRED_UNRESOLVED: 500
    });
    expect(ranked.map((item) => item.code)).toEqual([
      "RETENTION_OVERDUE",
      "KIOSK_OFFLINE",
      "PAYMENT_EXPIRED_UNRESOLVED"
    ]);
  });

  it("orders equal severities by size", () => {
    const ranked = deriveAttention({ RETENTION_OVERDUE: 2, RETENTION_DEAD_LETTERED: 7 });
    expect(ranked.map((item) => item.count)).toEqual([7, 2]);
  });

  it("assigns a severity to every code", () => {
    // A code with no severity would sort unpredictably and be easy to miss.
    for (const code of ADMIN_ATTENTION_CODES) {
      expect(severityOfAttention(code), code).toMatch(/^(CRITICAL|WARNING|INFO)$/u);
    }
  });
});

describe("response contracts refuse document content", () => {
  it("strips a filename from a document record", () => {
    // The reader role denies `display_name` outright. This is the second layer:
    // even if a query somehow produced one, it does not survive serialisation.
    const parsed = adminDocumentSchema.parse({
      id: "0195f0d0-0000-7000-8000-000000000001",
      ordinal: 0,
      status: "READY",
      kind: "PDF",
      declaredMime: "application/pdf",
      detectedMime: "application/pdf",
      extension: "pdf",
      sizeBytes: 1024,
      pageCount: 3,
      malwareScanStatus: "CLEAN",
      rejectionCode: null,
      processingErrorCode: null,
      processingAttempts: 1,
      createdAt: now.toISOString(),
      readyAt: now.toISOString(),
      deleteRequestedAt: null,
      deletedAt: null,
      cleanupDueAt: null,
      cleanupErrorCode: null,
      displayName: "medical-results.pdf",
      contentSha256: "a".repeat(64),
      quarantineObjectKey: "quarantine/v1/whatever"
    });

    expect(parsed).not.toHaveProperty("displayName");
    expect(parsed).not.toHaveProperty("contentSha256");
    expect(parsed).not.toHaveProperty("quarantineObjectKey");
  });

  it("strips a print manifest from a job record", () => {
    const parsed = adminPrintJobSchema.parse({
      id: "0195f0d0-0000-7000-8000-000000000002",
      sessionId: "0195f0d0-0000-7000-8000-000000000003",
      kioskId: "kiosk_dev_001",
      status: "COMPLETED",
      resultConfidence: "CONFIRMED",
      failureCode: null,
      warningCode: null,
      copies: 1,
      printedSides: 2,
      physicalSheets: 1,
      sheetsProduced: 1,
      dispatchAttempts: 1,
      deadlineAt: now.toISOString(),
      createdAt: now.toISOString(),
      dispatchedAt: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      failedAt: null,
      manifestRedactedAt: null,
      overdue: false,
      jobManifest: { documents: [{ objectKey: "normalized/v1/secret" }] }
    });

    expect(parsed).not.toHaveProperty("jobManifest");
  });

  it("strips a raw payload from a timeline entry", () => {
    const parsed = adminTimelineEntrySchema.parse({
      sequence: 4,
      type: "file.uploaded",
      occurredAt: now.toISOString(),
      sincePreviousMilliseconds: 1_500,
      payload: { file: { displayName: "passport.pdf" } }
    });

    expect(parsed).not.toHaveProperty("payload");
  });

  it("refuses a non-primitive audit metadata value", () => {
    // Nesting is how an object with a filename in it gets carried along by a
    // caller that only meant to add "context".
    expect(() =>
      adminAuditEntrySchema.parse({
        id: "0195f0d0-0000-7000-8000-000000000004",
        occurredAt: now.toISOString(),
        actorType: "KIOSK",
        actorId: "kiosk_dev_001",
        actorDisplayName: null,
        kioskId: "kiosk_dev_001",
        sessionId: null,
        action: "file.uploaded",
        outcome: "SUCCESS",
        requestId: null,
        metadata: { file: { displayName: "passport.pdf" } },
        redactedKeys: []
      })
    ).toThrow();
  });
});
