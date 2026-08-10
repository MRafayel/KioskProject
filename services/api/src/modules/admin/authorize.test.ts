import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { AdminCapability, AdminRole } from "@printing-kiosk/admin-access";

import { ApiError } from "../sessions/errors.js";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  authorizeAdmin,
  type AdminAuthorizationDependencies
} from "./authorize.js";
import type { AdminService, AuthenticatedAdmin } from "./service.js";

/**
 * The authorization gate on its own.
 *
 * The integration suite proves the gate is wired into every route; this proves
 * the gate itself makes the right decision, including for role/capability pairs
 * that no Phase 1 route exposes yet. Without this, a capability introduced in a
 * later phase would be enforced by code no test had ever exercised.
 */

const STEP_UP_TTL = 300_000;
const now = new Date("2026-08-10T12:00:00.000Z");

function admin(role: AdminRole, lastStepUpAt: Date | null): AuthenticatedAdmin {
  return {
    adminUserId: "00000000-0000-7000-8000-000000000001",
    displayName: "Test",
    role,
    sessionId: "00000000-0000-7000-8000-000000000002",
    idleExpiresAt: new Date(now.getTime() + 600_000),
    hardExpiresAt: new Date(now.getTime() + 3_600_000),
    lastStepUpAt,
    kioskScopes: []
  };
}

function dependencies(resolved: AuthenticatedAdmin | null): AdminAuthorizationDependencies {
  return {
    admin: {
      resolveSession: () => Promise.resolve(resolved),
      verifyCsrf: () => Promise.resolve(true)
    } as unknown as AdminService,
    stepUpTtlMilliseconds: STEP_UP_TTL,
    clock: { now: () => now }
  };
}

function request(method = "GET"): FastifyRequest {
  return {
    method,
    headers: { "x-csrf-token": "token" },
    cookies: { [ADMIN_SESSION_COOKIE]: "session-token", [ADMIN_CSRF_COOKIE]: "token" }
  } as unknown as FastifyRequest;
}

async function attempt(
  role: AdminRole,
  capability: AdminCapability,
  lastStepUpAt: Date | null = now,
  method = "GET"
): Promise<ApiError | null> {
  try {
    await authorizeAdmin(request(method), dependencies(admin(role, lastStepUpAt)), capability);
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}

describe("capability denial", () => {
  it("refuses a capability the role does not hold", async () => {
    const error = await attempt("OPERATOR", "refund.authorize");
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe("ADMIN_FORBIDDEN");
  });

  it("refuses an Operator the full audit log", async () => {
    expect((await attempt("OPERATOR", "audit.read"))?.code).toBe("ADMIN_FORBIDDEN");
    expect(await attempt("OPERATOR", "audit.read.self")).toBeNull();
  });

  it("refuses a Technical Admin the ability to manage people", async () => {
    expect((await attempt("TECHNICAL_ADMIN", "operator.manage"))?.code).toBe("ADMIN_FORBIDDEN");
    expect((await attempt("TECHNICAL_ADMIN", "authenticator.manage.operator"))?.code).toBe(
      "ADMIN_FORBIDDEN"
    );
  });

  it("refuses an Admin deep technical diagnostics", async () => {
    expect((await attempt("ADMIN", "print.diagnostics.read"))?.code).toBe("ADMIN_FORBIDDEN");
  });

  it("allows a capability the role does hold", async () => {
    expect(await attempt("ADMIN", "refund.authorize")).toBeNull();
    expect(await attempt("TECHNICAL_ADMIN", "print.diagnostics.read")).toBeNull();
    expect(await attempt("OPERATOR", "print.read")).toBeNull();
  });
});

describe("R3 is never authorised by a single request", () => {
  it("refuses every R3 capability even for the role that holds it", async () => {
    for (const capability of [
      "change.propose",
      "change.approve.technical",
      "pricing.publish.request"
    ] as const) {
      const error = await attempt("TECHNICAL_ADMIN", capability);
      expect(error?.statusCode, capability).toBe(403);
      expect(error?.code, capability).toBe("ADMIN_APPROVAL_REQUIRED");
    }
    const adminApproval = await attempt("ADMIN", "change.approve.admin");
    expect(adminApproval?.code).toBe("ADMIN_APPROVAL_REQUIRED");
  });

  it("refuses R3 for a role that does not hold it, without leaking that it is R3", async () => {
    // An Operator must be told they lack the capability, not that the change
    // needs approvals — the second answer confirms the capability exists.
    expect((await attempt("OPERATOR", "change.propose"))?.code).toBe("ADMIN_FORBIDDEN");
  });
});

describe("step-up", () => {
  it("is not required for a read", async () => {
    expect(await attempt("ADMIN", "payment.read", null)).toBeNull();
  });

  it("is not required for R1", async () => {
    expect(await attempt("ADMIN", "document.retention.retry", null, "POST")).toBeNull();
  });

  it("is required for R2", async () => {
    const error = await attempt("ADMIN", "refund.authorize", null, "POST");
    expect(error?.statusCode).toBe(401);
    expect(error?.code).toBe("ADMIN_STEP_UP_REQUIRED");
  });

  it("is required again once the window has passed", async () => {
    const stale = new Date(now.getTime() - STEP_UP_TTL - 1);
    expect((await attempt("ADMIN", "refund.authorize", stale, "POST"))?.code).toBe(
      "ADMIN_STEP_UP_REQUIRED"
    );
  });

  it("is satisfied by a recent assertion", async () => {
    const fresh = new Date(now.getTime() - 1_000);
    expect(await attempt("ADMIN", "refund.authorize", fresh, "POST")).toBeNull();
  });
});

describe("check ordering", () => {
  it("refuses a missing capability before asking for a security key", async () => {
    // An Operator without step-up asking for a capability they lack must get
    // FORBIDDEN, not a prompt to touch their key followed by a refusal.
    const error = await attempt("OPERATOR", "refund.authorize", null, "POST");
    expect(error?.code).toBe("ADMIN_FORBIDDEN");
  });

  it("refuses without a session before considering the capability", async () => {
    let thrown: ApiError | null = null;
    try {
      await authorizeAdmin(request(), dependencies(null), "dashboard.read");
    } catch (error) {
      thrown = error as ApiError;
    }
    expect(thrown?.statusCode).toBe(401);
    expect(thrown?.code).toBe("ADMIN_AUTHENTICATION_REQUIRED");
  });
});

describe("CSRF header validation", () => {
  it("rejects duplicate CSRF header values instead of choosing one", async () => {
    const duplicate = request("POST");
    duplicate.headers["x-csrf-token"] = ["token", "second-token"];

    await expect(
      authorizeAdmin(duplicate, dependencies(admin("ADMIN", now)), "authenticator.manage.self")
    ).rejects.toMatchObject({ statusCode: 403, code: "ADMIN_CSRF_FAILED" });
  });
});
