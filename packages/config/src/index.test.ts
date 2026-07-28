import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile, redisConnectionOptions } from "./index.js";

describe("loadEnvironment", () => {
  it("converts Redis URLs into BullMQ-safe connection settings", () => {
    expect(redisConnectionOptions("redis://worker:secret@localhost:6381/2")).toEqual({
      host: "localhost",
      port: 6381,
      db: 2,
      username: "worker",
      password: "secret",
      maxRetriesPerRequest: null
    });
    expect(redisConnectionOptions("rediss://cache.example.test")).toMatchObject({
      host: "cache.example.test",
      port: 6380,
      db: 0,
      tls: {}
    });
  });

  it("loads safe development defaults", () => {
    const environment = loadEnvironment({});

    expect(environment.API_PORT).toBe(3000);
    expect(environment.PRINTER_ADAPTER).toBe("mock");
    expect(environment.S3_FORCE_PATH_STYLE).toBe(true);
    expect(environment.MAX_FILES_PER_SESSION).toBe(1);
  });

  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false]
  ] as const)("parses S3_FORCE_PATH_STYLE=%s as %s", (input, expected) => {
    expect(loadEnvironment({ S3_FORCE_PATH_STYLE: input }).S3_FORCE_PATH_STYLE).toBe(expected);
  });

  it("rejects development secrets in production", () => {
    expect(() => loadEnvironment({ NODE_ENV: "production" })).toThrow();
  });

  it.each(["API_ORIGIN", "KIOSK_ORIGIN", "UPLOAD_ORIGIN", "PUBLIC_UPLOAD_ORIGIN"] as const)(
    "rejects an insecure remote %s in production",
    (name) => {
      expect(() =>
        loadEnvironment({
          ...secureProductionEnvironment,
          [name]: "http://remote.example.test"
        })
      ).toThrow();
    }
  );

  it("allows HTTP only for loopback API and kiosk origins in production", () => {
    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        API_ORIGIN: "http://127.0.0.1:3000",
        KIOSK_ORIGIN: "http://localhost:5173"
      })
    ).toMatchObject({
      API_ORIGIN: "http://127.0.0.1:3000",
      KIOSK_ORIGIN: "http://localhost:5173"
    });
  });

  it("requires the public upload URL and mobile API cookie origin to match", () => {
    expect(() =>
      loadEnvironment({
        UPLOAD_ORIGIN: "https://upload.example.test",
        PUBLIC_UPLOAD_ORIGIN: "https://different.example.test"
      })
    ).toThrow();
  });

  it("rejects a DATABASE_URL that is not a PostgreSQL URL", () => {
    expect(() => loadEnvironment({ DATABASE_URL: "not a url at all" })).toThrow();
    expect(() =>
      loadEnvironment({ DATABASE_URL: "mysql://localhost:3306/printing_kiosk" })
    ).toThrow();
    expect(
      loadEnvironment({ DATABASE_URL: "postgres://printing_kiosk@localhost:5432/printing_kiosk" })
        .DATABASE_URL
    ).toBe("postgres://printing_kiosk@localhost:5432/printing_kiosk");
  });

  it("does not allow the mobile credential to expire before the displayed idle deadline", () => {
    expect(() =>
      loadEnvironment({ SESSION_IDLE_TTL_MINUTES: "10", MOBILE_CLIENT_TTL_MINUTES: "9" })
    ).toThrow();
  });

  it("rejects known placeholders and reused cryptographic keys in production", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        COOKIE_SIGNING_KEY: "replace-with-at-least-32-random-bytes"
      })
    ).toThrow();

    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        MOBILE_TOKEN_PEPPER: secureProductionEnvironment.UPLOAD_TOKEN_PEPPER
      })
    ).toThrow();
  });

  it("requires encrypted object storage writes in production", () => {
    const withoutEncryption = {
      ...secureProductionEnvironment,
      S3_SERVER_SIDE_ENCRYPTION: undefined
    };
    expect(() => loadEnvironment(withoutEncryption)).toThrow();
  });

  it("requires TLS for remote Redis while allowing a loopback production sidecar", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        REDIS_URL: "redis://cache.example.test:6379"
      })
    ).toThrow();

    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        REDIS_URL: "redis://127.0.0.1:6379"
      }).REDIS_URL
    ).toBe("redis://127.0.0.1:6379");

    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        REDIS_URL: "rediss://cache.example.test:6380"
      }).REDIS_URL
    ).toBe("rediss://cache.example.test:6380");
  });

  it("loads the documented root environment file from a package working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "printing-kiosk-config-"));
    const nested = join(root, "services", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeFileSync(join(root, ".env"), "PRINTING_KIOSK_TEST_ROOT_ENV=loaded\n", "utf8");
    delete process.env.PRINTING_KIOSK_TEST_ROOT_ENV;

    try {
      loadWorkspaceEnvironmentFile(nested);
      expect(process.env.PRINTING_KIOSK_TEST_ROOT_ENV).toBe("loaded");
    } finally {
      delete process.env.PRINTING_KIOSK_TEST_ROOT_ENV;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const secureProductionEnvironment = {
  NODE_ENV: "production",
  API_ORIGIN: "https://api.example.test",
  KIOSK_ORIGIN: "https://kiosk.example.test",
  UPLOAD_ORIGIN: "https://upload.example.test",
  PUBLIC_UPLOAD_ORIGIN: "https://upload.example.test",
  COOKIE_SIGNING_KEY: "production-cookie-signing-key-at-least-32-characters",
  UPLOAD_TOKEN_PEPPER: "production-upload-token-pepper-at-least-32-characters",
  MOBILE_TOKEN_PEPPER: "production-mobile-token-pepper-at-least-32-characters",
  DEV_KIOSK_API_KEY: "production-kiosk-api-key-at-least-24-characters",
  S3_SECRET_ACCESS_KEY: "production-object-storage-secret",
  S3_SERVER_SIDE_ENCRYPTION: "AES256"
} as const;
