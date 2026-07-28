const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

interface IntegrationEnvironment {
  NODE_ENV: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  S3_ENDPOINT: string;
  DOCUMENT_PROCESSOR_URL: string;
}

/**
 * Integration suites delete database rows and private objects. Refuse to run
 * them against infrastructure that is not explicitly test-mode and loopback.
 */
export function assertSafeIntegrationEnvironment(environment: IntegrationEnvironment): void {
  if (environment.NODE_ENV !== "test") {
    throw new Error("INTEGRATION_TEST_MODE_REQUIRED");
  }

  assertLoopbackUrl(environment.DATABASE_URL, ["postgres:", "postgresql:"], "DATABASE_URL");
  assertLoopbackUrl(environment.REDIS_URL, ["redis:", "rediss:"], "REDIS_URL");
  assertLoopbackUrl(environment.S3_ENDPOINT, ["http:", "https:"], "S3_ENDPOINT");
  assertLoopbackUrl(
    environment.DOCUMENT_PROCESSOR_URL,
    ["http:", "https:"],
    "DOCUMENT_PROCESSOR_URL"
  );
}

function assertLoopbackUrl(value: string, protocols: readonly string[], name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name}_INVALID`);
  }
  if (!protocols.includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${name}_MUST_BE_LOOPBACK`);
  }
}
