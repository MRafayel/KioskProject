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
    // A session carries several documents by default, up to the same ceiling
    // the settings contract and the print manifest stop at.
    expect(environment.MAX_FILES_PER_SESSION).toBe(10);
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

  it("requires a real device to be named before it can be driven", () => {
    // A kiosk that started without knowing which printer or which host it uses
    // would only discover that at the first paid print.
    expect(() => loadEnvironment({ NODE_ENV: "test", PRINTER_ADAPTER: "ipp" })).toThrow();
    expect(() =>
      loadEnvironment({
        NODE_ENV: "test",
        PRINTER_ADAPTER: "ipp",
        PRINTER_IPP_URL: "printer.local",
        PRINTER_QUEUE_ALLOWLIST: "Kiosk A4"
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        NODE_ENV: "test",
        PRINTER_ADAPTER: "windows",
        PRINTER_QUEUE_ALLOWLIST: "Kiosk A4"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        NODE_ENV: "test",
        PRINTER_ADAPTER: "ipp",
        PRINTER_IPP_URL: "ipp://printer.local/ipp/print",
        PRINTER_QUEUE_ALLOWLIST: "Kiosk A4"
      })
    ).toMatchObject({ PRINTER_ADAPTER: "ipp" });
  });

  /**
   * Approval is the only thing standing between a paid job and whatever queue
   * a driver installer left on the machine, so a deployment driving hardware
   * has to state which queue it certified — and a preference that is not itself
   * certified is refused rather than quietly ignored.
   */
  it("requires a certified queue for a real device", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "test",
        PRINTER_ADAPTER: "ipp",
        PRINTER_IPP_URL: "ipp://printer.local/ipp/print"
      })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        NODE_ENV: "test",
        PRINTER_QUEUE_ALLOWLIST: "Kiosk A4",
        PRINTER_QUEUE_NAME: "Microsoft Print to PDF"
      })
    ).toThrow();
    expect(
      loadEnvironment({
        NODE_ENV: "test",
        PRINTER_QUEUE_ALLOWLIST: "Kiosk A4, Kiosk A4 Spare",
        PRINTER_QUEUE_NAME: "kiosk a4 spare"
      })
    ).toMatchObject({ PRINTER_QUEUE_NAME: "kiosk a4 spare" });
  });

  it("refuses the simulated printer and unencrypted print traffic in production", () => {
    // The simulated printer takes a customer's money and writes their document
    // to a folder. A production build cannot be configured to be one.
    expect(() =>
      loadEnvironment({ ...secureProductionEnvironment, PRINTER_ADAPTER: "mock" })
    ).toThrow();
    expect(() =>
      loadEnvironment({
        ...secureProductionEnvironment,
        PRINTER_IPP_URL: "ipp://printer.example.test/ipp/print"
      })
    ).toThrow();
    // The customer's document never leaves the kiosk machine on this path.
    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        PRINTER_IPP_URL: "ipp://127.0.0.1/ipp/print"
      })
    ).toMatchObject({ PRINTER_ADAPTER: "ipp" });
  });

  it("keeps the heartbeat inside the print command lease", () => {
    // A heartbeat that outlived a lease would let a kiosk look alive while the
    // control plane was already settling its job without it.
    expect(() =>
      loadEnvironment({
        NODE_ENV: "test",
        AGENT_HEARTBEAT_SECONDS: "120",
        PRINT_COMMAND_LEASE_SECONDS: "120"
      })
    ).toThrow();
    expect(loadEnvironment({ NODE_ENV: "test", AGENT_HEARTBEAT_SECONDS: "60" })).toMatchObject({
      AGENT_HEARTBEAT_SECONDS: 60
    });
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
  MALWARE_SCANNER_ADAPTER: "clamav",
  S3_SERVER_SIDE_ENCRYPTION: "AES256",
  // A production kiosk drives a real device, and the queue it prints to is one
  // an operator certified by name.
  PRINTER_ADAPTER: "ipp",
  PRINTER_IPP_URL: "ipps://printer.example.test/ipp/print",
  PRINTER_QUEUE_ALLOWLIST: "Kiosk A4"
} as const;
