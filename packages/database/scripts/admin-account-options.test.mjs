import { describe, expect, it } from "vitest";

import {
  assertBreakGlassIssuable,
  normalizeAdminUserId,
  normalizeRequiredOption,
  resolveAdminStatusTransition,
  resolveBreakGlassTtl
} from "./admin-account-options.mjs";

describe("admin account CLI options", () => {
  it("uses the configured break-glass lifetime when no CLI override is given", () => {
    expect(resolveBreakGlassTtl({ configuredHours: "49" })).toEqual({
      hours: 49,
      display: "49 hours"
    });
    expect(resolveBreakGlassTtl({})).toEqual({ hours: 2_160, display: "90 days" });
  });

  it("keeps the backward-compatible --expires-days override", () => {
    expect(resolveBreakGlassTtl({ expiresDays: "2", configuredHours: "1" })).toEqual({
      hours: 48,
      display: "2 days"
    });
  });

  it("rejects malformed or excessive recovery lifetimes", () => {
    expect(() => resolveBreakGlassTtl({ expiresDays: "1.5" })).toThrow("--expires-days");
    expect(() => resolveBreakGlassTtl({ configuredHours: "8761" })).toThrow(
      "ADMIN_BREAK_GLASS_TTL_HOURS"
    );
  });

  it("normalizes bounded text and validates admin identifiers before SQL", () => {
    expect(normalizeRequiredOption("  safe A  ", "--label", 80)).toBe("safe A");
    expect(() => normalizeRequiredOption("   ", "--label", 80)).toThrow("--label is required");
    expect(normalizeAdminUserId(" 00000000-0000-4000-8000-000000000001 ")).toBe(
      "00000000-0000-4000-8000-000000000001"
    );
    expect(() => normalizeAdminUserId("not-a-uuid")).toThrow("must be a UUID");
  });

  it("issues recovery codes only for states the recovery API accepts", () => {
    expect(() => assertBreakGlassIssuable("PROVISIONING")).not.toThrow();
    expect(() => assertBreakGlassIssuable("ACTIVE")).not.toThrow();
    expect(() => assertBreakGlassIssuable("SUSPENDED")).toThrow("PROVISIONING or ACTIVE");
    expect(() => assertBreakGlassIssuable("DISABLED")).toThrow("PROVISIONING or ACTIVE");
  });

  it("keeps lifecycle commands idempotent without activating provisioning accounts", () => {
    const activatedAt = new Date();
    expect(resolveAdminStatusTransition("ACTIVE", "ACTIVE", activatedAt)).toEqual({
      shouldUpdate: false
    });
    expect(resolveAdminStatusTransition("SUSPENDED", "ACTIVE", activatedAt)).toEqual({
      shouldUpdate: true
    });
    expect(() => resolveAdminStatusTransition("PROVISIONING", "ACTIVE", null)).toThrow(
      "PROVISIONING to ACTIVE"
    );
    expect(() => resolveAdminStatusTransition("SUSPENDED", "ACTIVE", null)).toThrow(
      "never completed activation"
    );
    expect(() => resolveAdminStatusTransition("DISABLED", "ACTIVE", activatedAt)).toThrow(
      "DISABLED to ACTIVE"
    );
  });
});
