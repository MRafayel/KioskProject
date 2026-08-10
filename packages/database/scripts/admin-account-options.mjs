const DEFAULT_BREAK_GLASS_TTL_HOURS = 2_160;
const MAXIMUM_BREAK_GLASS_TTL_HOURS = 8_760;

/** Resolve the CLI override or the same configured default validated by the API. */
export function resolveBreakGlassTtl({ expiresDays, configuredHours }) {
  if (expiresDays !== undefined) {
    const days = parseBoundedInteger(expiresDays, 1, 365, "--expires-days");
    return { hours: days * 24, display: `${days} day${days === 1 ? "" : "s"}` };
  }

  const hours = parseBoundedInteger(
    configuredHours ?? String(DEFAULT_BREAK_GLASS_TTL_HOURS),
    1,
    MAXIMUM_BREAK_GLASS_TTL_HOURS,
    "ADMIN_BREAK_GLASS_TTL_HOURS"
  );
  const display =
    hours % 24 === 0
      ? `${hours / 24} day${hours === 24 ? "" : "s"}`
      : `${hours} hour${hours === 1 ? "" : "s"}`;
  return { hours, display };
}

export function normalizeRequiredOption(value, optionName, maximumLength) {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${optionName} is required.`);
  if (normalized.length > maximumLength) {
    throw new Error(`${optionName} must be at most ${maximumLength} characters.`);
  }
  return normalized;
}

export function normalizeAdminUserId(value) {
  const normalized = normalizeRequiredOption(value, "--admin-user", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(normalized)) {
    throw new Error("--admin-user must be a UUID.");
  }
  return normalized;
}

export function assertBreakGlassIssuable(status) {
  if (status !== "PROVISIONING" && status !== "ACTIVE") {
    throw new Error(
      `Recovery codes can only be issued for PROVISIONING or ACTIVE accounts, not ${status}.`
    );
  }
}

export function resolveAdminStatusTransition(currentStatus, requestedStatus, activatedAt) {
  if (currentStatus === requestedStatus) return { shouldUpdate: false };

  const permitted =
    (currentStatus === "ACTIVE" &&
      (requestedStatus === "SUSPENDED" || requestedStatus === "DISABLED")) ||
    (currentStatus === "SUSPENDED" &&
      (requestedStatus === "ACTIVE" || requestedStatus === "DISABLED")) ||
    (currentStatus === "PROVISIONING" && requestedStatus === "DISABLED");

  if (!permitted) {
    throw new Error(`Cannot change an admin account from ${currentStatus} to ${requestedStatus}.`);
  }
  if (requestedStatus === "ACTIVE" && !activatedAt) {
    throw new Error("Cannot resume an account that never completed activation.");
  }

  return { shouldUpdate: true };
}

function parseBoundedInteger(value, minimum, maximum, name) {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
