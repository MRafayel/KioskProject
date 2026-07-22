const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function assertSafeDevelopmentSeedTarget(input: {
  nodeEnvironment: string | undefined;
  databaseUrl: string;
  usesBuiltInDefault?: boolean;
}): void {
  const effectiveEnvironment =
    input.nodeEnvironment ?? (input.usesBuiltInDefault ? "development" : undefined);
  if (effectiveEnvironment !== "development" && effectiveEnvironment !== "test") {
    throw new Error(
      "The development seed is disabled unless NODE_ENV is explicitly development or test."
    );
  }

  let target: URL;
  try {
    target = new URL(input.databaseUrl);
  } catch {
    throw new Error("The development seed requires a valid PostgreSQL DATABASE_URL.");
  }

  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !LOOPBACK_HOSTNAMES.has(target.hostname)
  ) {
    throw new Error("The development seed may connect only to PostgreSQL on loopback.");
  }
}
