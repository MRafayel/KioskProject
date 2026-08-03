/**
 * One idempotency key per distinct request, remembered for as long as the
 * session lasts.
 *
 * Retrying the same request after a network interruption reuses its key, so
 * the control plane replays the stored result instead of creating a second
 * settings revision, a second price, or a second charge.
 *
 * The fingerprint is stored beside the key rather than only hashed into the
 * storage slot. The hash is 32 bits, so two unrelated requests can land on one
 * slot; handing the second one the first one's key would spend it on a
 * different request and earn a refusal that no retry could clear.
 */
export function stableKey(namespace: string, fingerprint: string): string {
  const storageKey = storageSlot(namespace, fingerprint);
  const stored = readStoredKey(storageKey);
  if (stored && stored.fingerprint === fingerprint) return stored.key;
  return writeStoredKey(storageKey, fingerprint);
}

/** Abandon a key the control plane has already spent and mint its successor. */
export function rotateStableKey(namespace: string, fingerprint: string): string {
  return writeStoredKey(storageSlot(namespace, fingerprint), fingerprint);
}

/**
 * A kiosk browser stays open for months. Every finished session must take its
 * replay keys with it rather than accumulating them indefinitely.
 */
export function clearStoredKeys(prefixes: readonly string[]): void {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) sessionStorage.removeItem(key);
  }
}

function storageSlot(namespace: string, fingerprint: string): string {
  return `${namespace}.${hashFingerprint(fingerprint)}`;
}

function readStoredKey(storageKey: string): { fingerprint: string; key: string } | null {
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fingerprint?: unknown; key?: unknown };
    return typeof parsed?.fingerprint === "string" && typeof parsed.key === "string"
      ? { fingerprint: parsed.fingerprint, key: parsed.key }
      : null;
  } catch {
    // A value written before this format existed carries no fingerprint to
    // check, so it is replaced rather than trusted.
    return null;
  }
}

function writeStoredKey(storageKey: string, fingerprint: string): string {
  const key = `kiosk-${crypto.randomUUID()}`;
  sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
  return key;
}

function hashFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
