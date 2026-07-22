type SecureCrypto = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

/**
 * Returns a cryptographically random UUID without depending on randomUUID,
 * which is unavailable on some otherwise-capable mobile browsers and plain
 * HTTP development origins. It deliberately has no Math.random fallback.
 */
export function secureRandomUuid(
  source: SecureCrypto | null | undefined = globalThis.crypto
): string {
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error("SECURE_RANDOM_UNAVAILABLE");
  }

  if (typeof source.randomUUID === "function") {
    try {
      return source.randomUUID.call(source);
    } catch {
      // getRandomValues is still available in browsers where randomUUID is
      // restricted to a secure context.
    }
  }

  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));

  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
