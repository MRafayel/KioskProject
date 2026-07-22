import { describe, expect, it } from "vitest";

import { assertSafeDevelopmentSeedTarget } from "./development-seed.js";

describe("assertSafeDevelopmentSeedTarget", () => {
  it.each([undefined, "production", "staging"])("rejects NODE_ENV=%s", (nodeEnvironment) => {
    expect(() =>
      assertSafeDevelopmentSeedTarget({
        nodeEnvironment,
        databaseUrl: "postgresql://user:secret@localhost:5432/printing_kiosk"
      })
    ).toThrow(/disabled/);
  });

  it("rejects a remote database even in development", () => {
    expect(() =>
      assertSafeDevelopmentSeedTarget({
        nodeEnvironment: "development",
        databaseUrl: "postgresql://user:secret@database.example.test:5432/printing_kiosk"
      })
    ).toThrow(/loopback/);
  });

  it("allows the built-in loopback target without an environment file", () => {
    expect(() =>
      assertSafeDevelopmentSeedTarget({
        nodeEnvironment: undefined,
        databaseUrl: "postgresql://user:secret@localhost:5432/printing_kiosk",
        usesBuiltInDefault: true
      })
    ).not.toThrow();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("allows the loopback host %s", (hostname) => {
    expect(() =>
      assertSafeDevelopmentSeedTarget({
        nodeEnvironment: "development",
        databaseUrl: `postgresql://user:secret@${hostname}:5432/printing_kiosk`
      })
    ).not.toThrow();
  });
});
