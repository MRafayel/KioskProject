import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadEnvironment,
  loadNonAdminEnvironment,
  loadWorkspaceEnvironmentFile,
  redisConnectionOptions
} from "./index.js";

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
    expect(environment.MAX_FILE_BYTES).toBe(52_428_800);
    expect(environment.MAX_DOCUMENT_PAGES).toBe(200);
    expect(environment.MAX_IMAGE_PIXELS).toBe(40_000_000);
    expect(environment.DOCUMENT_PROCESSOR_ADAPTER).toBe("container");
    expect(environment.DOCUMENT_PROCESSOR_URL).toBe("http://127.0.0.1:3200");
    expect(environment.DOCUMENT_PROCESSOR_TIMEOUT_SECONDS).toBe(120);
    expect(environment.DOCUMENT_PROCESSOR_LEASE_SECONDS).toBe(180);
    expect(environment.DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES).toBe(536_870_912);
    expect(environment.DOCUMENT_PROCESSOR_MEMORY_MIB).toBe(3_072);
    expect(environment.DOCUMENT_PROCESSOR_SCRATCH_BYTES).toBe(2_147_483_648);
    expect(environment.CLAMAV_UPDATE_CHECKS_PER_DAY).toBe(12);
    expect(environment.MALWARE_SCANNER_ADAPTER).toBe("clamav");
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

  it("requires the control plane to have its own database role in production", () => {
    // Sharing the application role would give the panel every grant the print
    // path holds, including the columns that name and locate a customer's
    // documents. The least-privilege role only protects anything if the panel
    // actually connects as it.
    expect(() =>
      loadEnvironment({ ...secureProductionEnvironment, ADMIN_READ_DATABASE_URL: undefined })
    ).toThrow(/ADMIN_READ_DATABASE_URL/u);

    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        DATABASE_URL: "postgresql://app:secret@localhost:5432/kiosk",
        ADMIN_READ_DATABASE_URL: "postgresql://app:secret@localhost:5432/kiosk"
      })
    ).toThrow(/must not equal DATABASE_URL/u);
  });

  it("holds the control plane's connection to the same transport rule as the application's", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        ADMIN_READ_DATABASE_URL: "postgresql://reader:secret@db.example.test:5432/kiosk"
      })
    ).toThrow(/sslmode=verify-full/u);

    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        DATABASE_URL: "postgresql://app:secret@db.example.test:5432/kiosk?sslmode=verify-full",
        ADMIN_READ_DATABASE_URL:
          "postgresql://reader:secret@db.example.test:5432/kiosk?sslmode=verify-full"
      }).ADMIN_READ_DATABASE_URL
    ).toContain("reader");
  });

  it("keeps the control plane's database password out of worker and kiosk processes", () => {
    const environment = loadNonAdminEnvironment({
      ...process.env,
      ADMIN_READ_DATABASE_URL: "postgresql://reader:secret@localhost:5432/kiosk"
    });
    expect(environment).not.toHaveProperty("ADMIN_READ_DATABASE_URL");
    expect(JSON.stringify(environment)).not.toContain("secret@localhost");
  });

  it("requires isolated, digest-pinned processing and malware scanning in production", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        DOCUMENT_PROCESSOR_ADAPTER: "mock"
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        DOCUMENT_PROCESSOR_IMAGE: "registry.example.test/processor:latest"
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        MALWARE_SCANNER_ADAPTER: "mock"
      })
    ).toThrow();
  });

  it("rejects processor and scanner adapters that have no runtime implementation", () => {
    expect(() => loadEnvironment({ DOCUMENT_PROCESSOR_ADAPTER: "mock" })).toThrow();
    expect(() => loadEnvironment({ MALWARE_SCANNER_ADAPTER: "mock" })).toThrow();
  });

  it("uses the processor's conservative maximum source-pixel bound", () => {
    expect(loadEnvironment({ MAX_IMAGE_PIXELS: "200000000" }).MAX_IMAGE_PIXELS).toBe(200_000_000);
    expect(() => loadEnvironment({ MAX_IMAGE_PIXELS: "200000001" })).toThrow();
  });

  it("allows production processor HTTP only for a loopback sidecar", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        DOCUMENT_PROCESSOR_URL: "http://processor.example.test:3200"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        DOCUMENT_PROCESSOR_URL: "http://127.0.0.1:3200"
      }).DOCUMENT_PROCESSOR_URL
    ).toBe("http://127.0.0.1:3200");
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        DOCUMENT_PROCESSOR_URL: "http://192.168.10.20:3200"
      })
    ).toThrow();
  });

  it("requires independent API and worker object-storage credentials in production", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        S3_WORKER_ACCESS_KEY_ID: secureProductionEnvironment.S3_ACCESS_KEY_ID
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        S3_WORKER_SECRET_ACCESS_KEY: secureProductionEnvironment.S3_SECRET_ACCESS_KEY
      })
    ).toThrow();
  });

  it("refuses a print command lease that could outlive the job it belongs to", () => {
    // A lease that survives its job could hand work to a device after the
    // control plane has already settled the job without it.
    expect(() =>
      loadEnvironment({
        PRINT_JOB_TIMEOUT_SECONDS: "120",
        PRINT_COMMAND_LEASE_SECONDS: "120"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        PRINT_JOB_TIMEOUT_SECONDS: "120",
        PRINT_COMMAND_LEASE_SECONDS: "119"
      }).PRINT_COMMAND_LEASE_SECONDS
    ).toBe(119);
  });

  it("refuses a print job that could outlive its own session", () => {
    expect(() =>
      loadEnvironment({
        SESSION_IDLE_TTL_MINUTES: "5",
        SESSION_ABSOLUTE_TTL_MINUTES: "5",
        QUOTE_TTL_SECONDS: "300",
        PRINT_JOB_TIMEOUT_SECONDS: "600",
        PRINT_COMMAND_LEASE_SECONDS: "60"
      })
    ).toThrow();
  });

  it("refuses device output pruned before its own job could be redelivered", () => {
    // The mock printer's output is the evidence a redelivered operation is
    // resolved against. Discarding it while the job can still come back would
    // turn a duplicate command into a duplicate print.
    expect(() =>
      loadEnvironment({
        PRINT_JOB_TIMEOUT_SECONDS: "300",
        PRINTER_OUTPUT_RETENTION_SECONDS: "299"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        PRINT_JOB_TIMEOUT_SECONDS: "300",
        PRINTER_OUTPUT_RETENTION_SECONDS: "300"
      }).PRINTER_OUTPUT_RETENTION_SECONDS
    ).toBe(300);
  });

  it("refuses an orphan sweep that could reach a live session's documents", () => {
    // The reconciler deletes by age alone. Its cutoff has to be older than
    // anything a session could still own, including an object written at the
    // very end of the longest retention grace.
    expect(() =>
      loadEnvironment({
        SESSION_ABSOLUTE_TTL_MINUTES: "30",
        RETENTION_RECOVERY_GRACE_SECONDS: "900",
        RETENTION_ORPHAN_GRACE_SECONDS: "2700"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        SESSION_ABSOLUTE_TTL_MINUTES: "30",
        RETENTION_RECOVERY_GRACE_SECONDS: "900",
        RETENTION_ORPHAN_GRACE_SECONDS: "2701"
      }).RETENTION_ORPHAN_GRACE_SECONDS
    ).toBe(2701);
  });

  it("deletes an abandoned session's documents without a grace by default", () => {
    const environment = loadEnvironment({});
    expect(environment.RETENTION_SETTLED_GRACE_SECONDS).toBe(300);
    expect(environment.RETENTION_RECOVERY_GRACE_SECONDS).toBe(900);
    expect(environment.RETENTION_MAX_ATTEMPTS).toBe(8);
  });

  it("refuses the deterministic device scenarios in production", () => {
    // A route that dictates print outcomes is a way to fail a paid job on
    // request. A production configuration cannot express one that offers it.
    expect(() =>
      loadEnvironment({ ...secureProductionEnvironment, PRINT_TEST_OUTCOMES_ENABLED: "true" })
    ).toThrow();
    expect(
      loadEnvironment({ ...secureProductionEnvironment, PRINT_TEST_OUTCOMES_ENABLED: "false" })
        .PRINT_TEST_OUTCOMES_ENABLED
    ).toBe(false);
  });

  it("requires the processing lease to outlive the processor timeout", () => {
    expect(() =>
      loadEnvironment({
        DOCUMENT_PROCESSOR_TIMEOUT_SECONDS: "120",
        DOCUMENT_PROCESSOR_LEASE_SECONDS: "120"
      })
    ).toThrow();
  });

  it("requires the processor response bound to cover all configured derivatives", () => {
    expect(() =>
      loadEnvironment({
        MAX_DOCUMENT_PAGES: "200",
        MAX_NORMALIZED_FILE_BYTES: "104857600",
        MAX_PREVIEW_FILE_BYTES: "2097152",
        DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES: "322122547"
      })
    ).toThrow();
  });

  it("requires scratch for source, previews, canonical output, response and one-page workspace", () => {
    expect(() =>
      loadEnvironment({
        DOCUMENT_PROCESSOR_SCRATCH_BYTES: "536870912"
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        MAX_DOCUMENT_PAGES: "200",
        MAX_PREVIEW_FILE_BYTES: "2097152",
        DOCUMENT_PROCESSOR_SCRATCH_BYTES: "1073741824"
      })
    ).toThrow();
  });

  it("reserves runtime memory in addition to the tmpfs scratch limit", () => {
    expect(() =>
      loadEnvironment({
        DOCUMENT_PROCESSOR_MEMORY_MIB: "2048",
        DOCUMENT_PROCESSOR_SCRATCH_BYTES: "2147483648"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        DOCUMENT_PROCESSOR_MEMORY_MIB: "3072",
        DOCUMENT_PROCESSOR_SCRATCH_BYTES: "2147483648"
      }).DOCUMENT_PROCESSOR_MEMORY_MIB
    ).toBe(3_072);
  });

  it("rejects worker concurrency above the processor's single-flight capacity", () => {
    expect(() =>
      loadEnvironment({
        DOCUMENT_PROCESSING_CONCURRENCY: "2"
      })
    ).toThrow();
  });

  it("bounds the FreshClam update schedule", () => {
    expect(
      loadEnvironment({ CLAMAV_UPDATE_CHECKS_PER_DAY: "50" }).CLAMAV_UPDATE_CHECKS_PER_DAY
    ).toBe(50);
    expect(() => loadEnvironment({ CLAMAV_UPDATE_CHECKS_PER_DAY: "0" })).toThrow();
    expect(() => loadEnvironment({ CLAMAV_UPDATE_CHECKS_PER_DAY: "51" })).toThrow();
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

  it("requires full certificate and hostname verification for a remote production database", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        DATABASE_URL: "postgresql://app:secret@database.example.test:5432/printing_kiosk"
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        DATABASE_URL:
          "postgresql://app:secret@database.example.test:5432/printing_kiosk?sslmode=require"
      })
    ).toThrow();

    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        DATABASE_URL:
          "postgresql://app:secret@database.example.test:5432/printing_kiosk?sslmode=verify-full"
      }).DATABASE_URL
    ).toContain("sslmode=verify-full");
    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        DATABASE_URL: "postgresql://app:secret@127.0.0.1:5432/printing_kiosk"
      }).DATABASE_URL
    ).toContain("127.0.0.1");
  });

  it("refuses a payment window that would outlive the price it is paying", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "test",
        QUOTE_TTL_SECONDS: "120",
        PAYMENT_TIMEOUT_SECONDS: "180"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        NODE_ENV: "test",
        QUOTE_TTL_SECONDS: "300",
        PAYMENT_TIMEOUT_SECONDS: "180"
      })
    ).toMatchObject({ PAYMENT_TIMEOUT_SECONDS: 180 });
  });

  it("refuses the payment outcome control in production", () => {
    // A route that dictates payment outcomes is a way to print money, so a
    // production configuration cannot express one that offers it.
    expect(() =>
      loadEnvironment({ ...secureProductionEnvironment, PAYMENT_TEST_OUTCOMES_ENABLED: "true" })
    ).toThrow();
    expect(
      loadEnvironment({ ...secureProductionEnvironment, PAYMENT_TEST_OUTCOMES_ENABLED: "false" })
    ).toMatchObject({ PAYMENT_TEST_OUTCOMES_ENABLED: false });
    expect(loadEnvironment({ NODE_ENV: "test" })).toMatchObject({
      PAYMENT_TEST_OUTCOMES_ENABLED: false
    });
  });

  it("requires the payment webhook secret to be its own production value", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        PAYMENT_WEBHOOK_SECRET: secureProductionEnvironment.UPLOAD_TOKEN_PEPPER
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        PAYMENT_WEBHOOK_SECRET: secureProductionEnvironment.DEV_KIOSK_API_KEY
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        PAYMENT_WEBHOOK_SECRET: secureProductionEnvironment.DOCUMENT_PROCESSOR_AUTH_TOKEN
      })
    ).toThrow();
  });

  it("requires HTTPS for the admin origin with no loopback exception", () => {
    // WebAuthn needs a secure context and the session cookie uses the __Host-
    // prefix, so unlike the API and kiosk origins this one has no HTTP escape.
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        ADMIN_ORIGIN: "http://127.0.0.1:5175",
        ADMIN_WEBAUTHN_RP_ID: "127.0.0.1"
      })
    ).toThrow();
  });

  it("requires the admin peppers to be independent production values", () => {
    for (const collision of [
      secureProductionEnvironment.COOKIE_SIGNING_KEY,
      secureProductionEnvironment.UPLOAD_TOKEN_PEPPER,
      secureProductionEnvironment.PAYMENT_WEBHOOK_SECRET
    ]) {
      expect(() =>
        loadEnvironment({ ...secureProductionEnvironment, ADMIN_SESSION_PEPPER: collision })
      ).toThrow();
    }
    // The break-glass pepper must also differ from the session pepper, so
    // leaking one cannot be used to forge the other.
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        ADMIN_BREAK_GLASS_PEPPER: secureProductionEnvironment.ADMIN_SESSION_PEPPER
      })
    ).toThrow();
  });

  it("refuses default admin peppers in production", () => {
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        ADMIN_SESSION_PEPPER: "development-only-admin-session-pepper-change-me"
      })
    ).toThrow();
  });
});

describe("loadNonAdminEnvironment", () => {
  it("does not require or retain admin control-plane settings in production processes", () => {
    const source = Object.fromEntries(
      Object.entries(secureProductionEnvironment).filter(([name]) => !name.startsWith("ADMIN_"))
    );
    const environment = loadNonAdminEnvironment({
      ...source,
      // Even accidental injection is discarded rather than copied into the
      // worker or kiosk-agent configuration object.
      ADMIN_SESSION_PEPPER: "an-admin-session-secret-that-must-not-be-retained"
    });

    expect(environment.NODE_ENV).toBe("production");
    expect("ADMIN_ORIGIN" in environment).toBe(false);
    expect("ADMIN_SESSION_PEPPER" in environment).toBe(false);
    expect("ADMIN_BREAK_GLASS_PEPPER" in environment).toBe(false);
  });
});

describe("admin WebAuthn relying party", () => {
  it.each([
    "https://admin.example.test/",
    "https://admin.example.test/path",
    "https://admin.example.test?mode=recovery",
    "https://admin.example.test#security",
    "https://operator@admin.example.test"
  ])("refuses non-canonical ADMIN_ORIGIN=%s", (adminOrigin) => {
    expect(() =>
      loadEnvironment({
        ADMIN_ORIGIN: adminOrigin,
        ADMIN_WEBAUTHN_RP_ID: "admin.example.test"
      })
    ).toThrow();
  });

  it("refuses insecure non-loopback admin origins outside production too", () => {
    expect(() =>
      loadEnvironment({
        ADMIN_ORIGIN: "http://192.168.10.20:5175",
        ADMIN_WEBAUTHN_RP_ID: "192.168.10.20"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        ADMIN_ORIGIN: "http://127.0.0.2:5175",
        ADMIN_WEBAUTHN_RP_ID: "127.0.0.2"
      }).ADMIN_ORIGIN
    ).toBe("http://127.0.0.2:5175");
  });

  it("accepts an RP ID equal to the admin host", () => {
    expect(
      loadEnvironment({
        ADMIN_ORIGIN: "https://admin.example.test",
        ADMIN_WEBAUTHN_RP_ID: "admin.example.test"
      })
    ).toMatchObject({ ADMIN_WEBAUTHN_RP_ID: "admin.example.test" });
  });

  it("accepts an RP ID that is a parent domain of the admin host", () => {
    expect(
      loadEnvironment({
        ADMIN_ORIGIN: "https://admin.example.test",
        ADMIN_WEBAUTHN_RP_ID: "example.test"
      })
    ).toMatchObject({ ADMIN_WEBAUTHN_RP_ID: "example.test" });
  });

  it("refuses an RP ID the browser would reject", () => {
    // A credential enrolled against an unrelated RP ID can never be asserted
    // from this origin, so every login would fail at the browser.
    expect(() =>
      loadEnvironment({
        ADMIN_ORIGIN: "https://admin.example.test",
        ADMIN_WEBAUTHN_RP_ID: "attacker.test"
      })
    ).toThrow();
    // A suffix that is not a domain boundary must not pass either.
    expect(() =>
      loadEnvironment({
        ADMIN_ORIGIN: "https://admin.example.test",
        ADMIN_WEBAUTHN_RP_ID: "ample.test"
      })
    ).toThrow();
  });

  it.each([
    "https://admin.example.test",
    "admin.example.test:443",
    "admin.example.test.",
    "admin..example.test",
    "_admin.example.test",
    "-admin.example.test"
  ])("refuses non-hostname RP ID %s", (relyingPartyId) => {
    expect(() =>
      loadEnvironment({
        ADMIN_ORIGIN: "https://admin.example.test",
        ADMIN_WEBAUTHN_RP_ID: relyingPartyId
      })
    ).toThrow();
  });

  it("requires an IP RP ID to match an IP origin exactly", () => {
    expect(() =>
      loadEnvironment({
        ADMIN_ORIGIN: "https://127.0.0.1",
        ADMIN_WEBAUTHN_RP_ID: "0.0.1"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        ADMIN_ORIGIN: "https://127.0.0.1",
        ADMIN_WEBAUTHN_RP_ID: "127.0.0.1"
      }).ADMIN_WEBAUTHN_RP_ID
    ).toBe("127.0.0.1");
  });

  it("keeps the step-up window inside the idle session window", () => {
    expect(() =>
      loadEnvironment({
        ADMIN_SESSION_IDLE_MINUTES: "5",
        ADMIN_STEP_UP_TTL_SECONDS: "600"
      })
    ).toThrow();
  });

  it("keeps the idle window inside the absolute window", () => {
    expect(() =>
      loadEnvironment({
        ADMIN_SESSION_IDLE_MINUTES: "120",
        ADMIN_SESSION_ABSOLUTE_MINUTES: "60"
      })
    ).toThrow();
  });
});

describe("workspace environment file", () => {
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
  S3_ACCESS_KEY_ID: "printing-kiosk-api-production",
  S3_SECRET_ACCESS_KEY: "production-object-storage-secret",
  S3_WORKER_ACCESS_KEY_ID: "printing-kiosk-worker-production",
  S3_WORKER_SECRET_ACCESS_KEY: "production-worker-object-storage-secret",
  DOCUMENT_PROCESSOR_ADAPTER: "container",
  DOCUMENT_PROCESSOR_IMAGE:
    "registry.example.test/printing-kiosk-processor@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  DOCUMENT_PROCESSOR_AUTH_TOKEN: "production-processor-auth-token-at-least-32-characters",
  PAYMENT_WEBHOOK_SECRET: "production-payment-webhook-secret-at-least-32-characters",
  ADMIN_ORIGIN: "https://admin.example.test",
  ADMIN_WEBAUTHN_RP_ID: "admin.example.test",
  ADMIN_SESSION_PEPPER: "production-admin-session-pepper-at-least-32-characters",
  ADMIN_BREAK_GLASS_PEPPER: "production-admin-break-glass-pepper-at-least-32-chars",
  // The control plane connects as its own least-privilege role, never as the
  // application's. Loopback here so the transport rule is exercised separately.
  ADMIN_READ_DATABASE_URL: "postgresql://printing_kiosk_admin_reader:secret@localhost:5432/kiosk",
  MALWARE_SCANNER_ADAPTER: "clamav",
  S3_SERVER_SIDE_ENCRYPTION: "AES256"
} as const;
