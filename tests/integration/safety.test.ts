import { describe, expect, it } from "vitest";

import { assertSafeIntegrationEnvironment } from "./safety.js";

const localEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:secret@127.0.0.1:5432/printing_kiosk",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  DOCUMENT_PROCESSOR_URL: "http://localhost:3200"
};

describe("integration target guard", () => {
  it("allows test-mode loopback dependencies", () => {
    expect(() => assertSafeIntegrationEnvironment(localEnvironment)).not.toThrow();
  });

  it("rejects a non-test environment", () => {
    expect(() =>
      assertSafeIntegrationEnvironment({ ...localEnvironment, NODE_ENV: "production" })
    ).toThrow("INTEGRATION_TEST_MODE_REQUIRED");
  });

  it.each([
    ["DATABASE_URL", "postgresql://test:secret@database.example.test:5432/printing_kiosk"],
    ["REDIS_URL", "redis://redis.example.test:6379"],
    ["S3_ENDPOINT", "https://objects.example.test"],
    ["DOCUMENT_PROCESSOR_URL", "https://processor.example.test"]
  ] as const)("rejects remote %s", (name, value) => {
    expect(() => assertSafeIntegrationEnvironment({ ...localEnvironment, [name]: value })).toThrow(
      `${name}_MUST_BE_LOOPBACK`
    );
  });
});
