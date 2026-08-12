import { describe, expect, it } from "vitest";

import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLES,
  capabilitiesForRole,
  hasCapability,
  isAdminCapability,
  isAdminRole,
  isPrivilegedRole,
  requiresStepUp,
  riskOfCapability,
  type AdminCapability
} from "./capabilities.js";

describe("admin role model", () => {
  it("recognises exactly the three operational layers", () => {
    expect(ADMIN_ROLES).toEqual(["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"]);
    expect(isAdminRole("OPERATOR")).toBe(true);
    expect(isAdminRole("SUPERUSER")).toBe(false);
    expect(isAdminRole("operator")).toBe(false);
  });

  it("treats Admin and Technical Admin as privileged", () => {
    expect(isPrivilegedRole("ADMIN")).toBe(true);
    expect(isPrivilegedRole("TECHNICAL_ADMIN")).toBe(true);
    expect(isPrivilegedRole("OPERATOR")).toBe(false);
  });

  it("grants only capabilities that exist", () => {
    for (const role of ADMIN_ROLES) {
      for (const capability of capabilitiesForRole(role)) {
        expect(isAdminCapability(capability)).toBe(true);
      }
    }
  });

  it("never grants a capability twice within a role", () => {
    for (const role of ADMIN_ROLES) {
      const granted = capabilitiesForRole(role);
      expect(new Set(granted).size).toBe(granted.length);
    }
  });
});

describe("no role is a superset of another", () => {
  // This is the property that makes one compromised account survivable. If it
  // ever fails, some role has quietly become a superuser.
  it("Admin cannot do everything Technical Admin can", () => {
    const admin = new Set<string>(capabilitiesForRole("ADMIN"));
    const missing = capabilitiesForRole("TECHNICAL_ADMIN").filter(
      (capability) => !admin.has(capability)
    );
    expect(missing).toContain("change.propose");
    expect(missing).toContain("change.approve.technical");
    expect(missing).toContain("print.diagnostics.read");
  });

  it("Technical Admin cannot do everything Admin can", () => {
    const technical = new Set<string>(capabilitiesForRole("TECHNICAL_ADMIN"));
    const missing = capabilitiesForRole("ADMIN").filter((capability) => !technical.has(capability));
    expect(missing).toContain("operator.manage");
    expect(missing).toContain("change.approve.admin");
  });

  it("Operator holds strictly less than both", () => {
    const operator = capabilitiesForRole("OPERATOR");
    for (const role of ["ADMIN", "TECHNICAL_ADMIN"] as const) {
      const wider = new Set<string>(capabilitiesForRole(role));
      for (const capability of operator) {
        expect(wider.has(capability)).toBe(true);
      }
      expect(capabilitiesForRole(role).length).toBeGreaterThan(operator.length);
    }
  });
});

describe("capabilities that must never be granted", () => {
  it("declares no capability naming a generic power tool", () => {
    const forbidden = [
      "sql",
      "shell",
      "exec",
      "script",
      "secret",
      "credential",
      "env",
      "printer.command",
      "terminal.command",
      "document.content",
      "document.download"
    ];
    for (const capability of ADMIN_CAPABILITIES) {
      for (const term of forbidden) {
        expect(capability.includes(term)).toBe(false);
      }
    }
  });

  it("gives no role any capability over kiosk credentials", () => {
    // Kiosk credential issuance is document access (Phase 0 §12). It is not in
    // the dashboard at any level, so no capability may mention it.
    for (const capability of ADMIN_CAPABILITIES) {
      expect(capability.startsWith("kiosk.credential")).toBe(false);
    }
  });

  it("gives no role the ability to read document contents", () => {
    for (const role of ADMIN_ROLES) {
      const granted = capabilitiesForRole(role);
      expect(granted).not.toContain("document.contents.read" as AdminCapability);
      // The only document capabilities are metadata and retention.
      const documentCapabilities = granted.filter((capability) =>
        capability.startsWith("document.")
      );
      for (const capability of documentCapabilities) {
        expect(
          capability === "document.metadata.read" ||
            capability === "document.retention.read" ||
            capability === "document.retention.retry"
        ).toBe(true);
      }
    }
  });

  it("gives no role the ability to delete or rewrite audit history", () => {
    for (const capability of ADMIN_CAPABILITIES) {
      expect(capability.startsWith("audit.delete")).toBe(false);
      expect(capability.startsWith("audit.write")).toBe(false);
    }
  });
});

describe("money is separated from observation", () => {
  it("lets an Operator record a recovery outcome", () => {
    expect(hasCapability("OPERATOR", "print.recovery.resolve")).toBe(true);
  });

  it("never lets an Operator authorize a refund", () => {
    expect(hasCapability("OPERATOR", "refund.authorize")).toBe(false);
    expect(hasCapability("ADMIN", "refund.authorize")).toBe(true);
    expect(hasCapability("TECHNICAL_ADMIN", "refund.authorize")).toBe(true);
  });

  it("never lets an Operator read reconciliation or mismatch detail", () => {
    expect(hasCapability("OPERATOR", "payment.reconcile.read")).toBe(false);
    expect(hasCapability("OPERATOR", "payment.mismatch.read")).toBe(false);
    expect(hasCapability("OPERATOR", "refund.obligation.read")).toBe(false);
  });
});

describe("account management boundaries", () => {
  it("lets only an Admin suspend an account or move a kiosk assignment", () => {
    expect(hasCapability("ADMIN", "operator.manage")).toBe(true);
    // A Technical Admin can get an Operator onto a key; it cannot decide
    // whether that Operator may work, or where. See ROLE_CAPABILITIES.
    expect(hasCapability("TECHNICAL_ADMIN", "operator.manage")).toBe(false);
    expect(hasCapability("OPERATOR", "operator.manage")).toBe(false);
  });

  it("lets every role manage its own authenticators, and an Operator's only from above", () => {
    for (const role of ADMIN_ROLES) {
      expect(hasCapability(role, "authenticator.manage.self")).toBe(true);
    }
    expect(hasCapability("ADMIN", "authenticator.manage.operator")).toBe(true);
    expect(hasCapability("TECHNICAL_ADMIN", "authenticator.manage.operator")).toBe(true);
    expect(hasCapability("OPERATOR", "authenticator.manage.operator")).toBe(false);
  });

  it("declares no capability that changes an account's role", () => {
    // Nothing in the control plane promotes anybody. An account holds the role
    // it was created with, and changing that is a CLI operation with database
    // access behind it.
    for (const capability of ADMIN_CAPABILITIES) {
      expect(capability.includes("role")).toBe(false);
      expect(capability.startsWith("admin.manage")).toBe(false);
    }
  });

  it("gives an Operator only its own audit trail", () => {
    expect(hasCapability("OPERATOR", "audit.read")).toBe(false);
    expect(hasCapability("OPERATOR", "audit.read.self")).toBe(true);
  });
});

describe("risk classification", () => {
  it("defaults read capabilities to R0", () => {
    expect(riskOfCapability("dashboard.read")).toBe("R0");
    expect(riskOfCapability("session.read")).toBe("R0");
    expect(riskOfCapability("audit.read")).toBe("R0");
  });

  it("classifies money and people changes as at least R2", () => {
    for (const capability of [
      "refund.authorize",
      "print.recovery.resolve",
      "operator.manage",
      "authenticator.manage.self",
      "authenticator.manage.operator"
    ] as const) {
      expect(["R2", "R3"]).toContain(riskOfCapability(capability));
    }
  });

  it("classifies serious production change as R3", () => {
    for (const capability of [
      "pricing.publish.request",
      "change.propose",
      "change.approve.technical",
      "change.approve.admin"
    ] as const) {
      expect(riskOfCapability(capability)).toBe("R3");
    }
  });

  it("requires step-up for everything above R1", () => {
    expect(requiresStepUp("R0")).toBe(false);
    expect(requiresStepUp("R1")).toBe(false);
    expect(requiresStepUp("R2")).toBe(true);
    expect(requiresStepUp("R3")).toBe(true);
  });
});
