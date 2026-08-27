import { describe, expect, it } from "vitest";

import { resolveProvisionPassword } from "./admin-append-role.mjs";

const policy = {
  role: "printing_kiosk_admin_writer",
  passwordVariable: "ADMIN_WRITE_DATABASE_PASSWORD",
  urlVariable: "ADMIN_WRITE_DATABASE_URL"
};

describe("append-only role provisioning password", () => {
  it("uses an explicitly supplied provisioning password first", () => {
    expect(
      resolveProvisionPassword(policy, {
        ADMIN_WRITE_DATABASE_PASSWORD: "explicit-password-that-is-long-enough",
        ADMIN_WRITE_DATABASE_URL:
          "postgresql://printing_kiosk_admin_writer:different-url-password-that-is-long-enough@localhost/db"
      })
    ).toBe("explicit-password-that-is-long-enough");
  });

  it("reuses the matching configured role URL when no duplicate variable is set", () => {
    expect(
      resolveProvisionPassword(policy, {
        ADMIN_WRITE_DATABASE_URL:
          "postgresql://printing_kiosk_admin_writer:encoded%40password-that-is-long-enough@localhost/db"
      })
    ).toBe("encoded@password-that-is-long-enough");
  });

  it("rejects a URL for a different role without exposing its credential", () => {
    const secret = "secret-password-that-must-not-leak";
    expect(() =>
      resolveProvisionPassword(policy, {
        ADMIN_WRITE_DATABASE_URL: `postgresql://application_role:${secret}@localhost/db`
      })
    ).toThrow("must use PostgreSQL role printing_kiosk_admin_writer");

    try {
      resolveProvisionPassword(policy, {
        ADMIN_WRITE_DATABASE_URL: `postgresql://application_role:${secret}@localhost/db`
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("rejects missing, malformed, and short credentials", () => {
    expect(() => resolveProvisionPassword(policy, {})).toThrow(
      "ADMIN_WRITE_DATABASE_PASSWORD or ADMIN_WRITE_DATABASE_URL"
    );
    expect(() =>
      resolveProvisionPassword(policy, { ADMIN_WRITE_DATABASE_URL: "not a URL" })
    ).toThrow("valid PostgreSQL connection URL");
    expect(() =>
      resolveProvisionPassword(policy, {
        ADMIN_WRITE_DATABASE_URL:
          "postgresql://printing_kiosk_admin_writer:too-short@localhost/db"
      })
    ).toThrow("at least 24 characters");
  });
});
