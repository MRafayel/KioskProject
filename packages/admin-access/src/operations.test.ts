import { describe, expect, it } from "vitest";

import { RECOVERY_OUTCOMES } from "./observability.js";
import {
  acknowledgeIncidentBodySchema,
  incidentKey,
  resolveRecoveryBodySchema,
  resolveRecoveryResponseSchema,
  suggestsRefund
} from "./operations.js";

describe("recovery outcomes", () => {
  it("suggests a refund for exactly the outcomes that mean pages are missing", () => {
    expect(suggestsRefund("NOT_DELIVERED")).toBe(true);
    expect(suggestsRefund("PARTIALLY_DELIVERED")).toBe(true);
    expect(suggestsRefund("DELIVERED")).toBe(false);
    // The one that is easy to get wrong. "I could not tell" is not a claim that
    // money is owed; it is a claim that nobody knows, and inventing an
    // obligation from it would make uncertainty expensive.
    expect(suggestsRefund("UNRESOLVABLE")).toBe(false);
  });

  it("keeps the outcome vocabulary closed", () => {
    expect([...RECOVERY_OUTCOMES]).toEqual([
      "DELIVERED",
      "PARTIALLY_DELIVERED",
      "NOT_DELIVERED",
      "UNRESOLVABLE"
    ]);
    // Nothing an operator submits may claim the print succeeded outright: that
    // is the device's word, not a person's.
    expect(RECOVERY_OUTCOMES).not.toContain("COMPLETED");
  });
});

describe("resolve recovery body", () => {
  const valid = { outcome: "DELIVERED" as const, reason: "Pages were in the tray." };

  it("accepts a complete observation", () => {
    expect(resolveRecoveryBodySchema.parse({ ...valid, observedSheets: 4 })).toEqual({
      outcome: "DELIVERED",
      reason: "Pages were in the tray.",
      observedSheets: 4
    });
  });

  it("refuses a reason that explains nothing", () => {
    expect(resolveRecoveryBodySchema.safeParse({ ...valid, reason: "ok" }).success).toBe(false);
    expect(resolveRecoveryBodySchema.safeParse({ ...valid, reason: "   " }).success).toBe(false);
    expect(resolveRecoveryBodySchema.safeParse({ ...valid, reason: "x".repeat(281) }).success).toBe(
      false
    );
  });

  it("refuses a sheet count that contradicts the outcome", () => {
    expect(
      resolveRecoveryBodySchema.safeParse({
        outcome: "NOT_DELIVERED",
        reason: "Tray was empty and the printer was dark.",
        observedSheets: 3
      }).success
    ).toBe(false);

    expect(resolveRecoveryBodySchema.safeParse({ ...valid, observedSheets: 0 }).success).toBe(
      false
    );

    expect(
      resolveRecoveryBodySchema.safeParse({
        outcome: "UNRESOLVABLE",
        reason: "Customer had gone and the kiosk was already cleared.",
        observedSheets: 2
      }).success
    ).toBe(false);
  });

  it("accepts an unresolvable outcome with no count at all", () => {
    expect(
      resolveRecoveryBodySchema.safeParse({
        outcome: "UNRESOLVABLE",
        reason: "Customer had gone and the kiosk was already cleared."
      }).success
    ).toBe(true);
  });

  it("refuses anything the caller made up", () => {
    // A body that could carry extra fields is a body that could eventually
    // carry `refundSuggested: true` from a client.
    expect(resolveRecoveryBodySchema.safeParse({ ...valid, refundSuggested: true }).success).toBe(
      false
    );
    expect(
      resolveRecoveryBodySchema.safeParse({ ...valid, printJobStatus: "COMPLETED" }).success
    ).toBe(false);
    expect(resolveRecoveryBodySchema.safeParse({ ...valid, outcome: "COMPLETED" }).success).toBe(
      false
    );
  });
});

describe("resolve recovery response", () => {
  it("states in the response itself that no money moved", () => {
    const response = {
      resolution: {
        id: "3f4a2d16-6f0f-4f4a-9c94-4a06c8f1b000",
        printJobId: "3f4a2d16-6f0f-4f4a-9c94-4a06c8f1b111",
        outcome: "NOT_DELIVERED" as const,
        reason: "Tray was empty.",
        refundSuggested: true,
        observedSheets: 0,
        resolvedByAdminUserId: "3f4a2d16-6f0f-4f4a-9c94-4a06c8f1b222",
        resolvedByDisplayName: "Operator",
        resolvedByRole: "OPERATOR",
        resolvedAt: "2026-08-11T09:00:00.000Z"
      },
      replayed: false,
      refundAuthorized: false as const
    };
    expect(resolveRecoveryResponseSchema.parse(response).refundAuthorized).toBe(false);

    // The literal is the point: no code path can produce a response claiming an
    // operator authorized a payout.
    expect(
      resolveRecoveryResponseSchema.safeParse({ ...response, refundAuthorized: true }).success
    ).toBe(false);
  });
});

describe("incident acknowledgement", () => {
  const valid = {
    subsystem: "PRINTING" as const,
    code: "DEVICE_ERROR",
    kioskId: "kiosk-1",
    reason: "Walking over to check the paper path."
  };

  it("accepts a group with and without a kiosk", () => {
    expect(acknowledgeIncidentBodySchema.parse(valid).kioskId).toBe("kiosk-1");
    expect(acknowledgeIncidentBodySchema.parse({ ...valid, kioskId: null }).kioskId).toBeNull();
  });

  it("refuses a code that is not this system's own vocabulary", () => {
    // The audit log is permanent. A free-text code would be a way to write
    // attacker-chosen strings into it and have an operator read them back.
    for (const code of ["<script>", "device error", "../../etc", "a".repeat(65), ""]) {
      expect(acknowledgeIncidentBodySchema.safeParse({ ...valid, code }).success).toBe(false);
    }
  });

  it("refuses an unknown subsystem", () => {
    expect(
      acknowledgeIncidentBodySchema.safeParse({ ...valid, subsystem: "DATABASE" }).success
    ).toBe(false);
  });
});

describe("incident key", () => {
  it("cannot collide a system-wide group with a per-kiosk one", () => {
    // Whatever a kiosk is called — including anything that might plausibly have
    // been chosen as a separator or a placeholder — it must not be able to
    // impersonate the group that has no kiosk at all.
    for (const kioskId of ["*", "", "null", "|", "|||"]) {
      expect(incidentKey({ subsystem: "PAYMENT", code: "DECLINED", kioskId: null })).not.toBe(
        incidentKey({ subsystem: "PAYMENT", code: "DECLINED", kioskId })
      );
    }
  });

  it("cannot collide two groups by running their fields together", () => {
    expect(incidentKey({ subsystem: "PAYMENT", code: "A_B", kioskId: "c" })).not.toBe(
      incidentKey({ subsystem: "PAYMENT", code: "A", kioskId: "B_c" })
    );
  });

  it("is stable for the same group", () => {
    const group = { subsystem: "PRINTING", code: "DEVICE_ERROR", kioskId: "kiosk-1" };
    expect(incidentKey(group)).toBe(incidentKey({ ...group }));
  });
});
