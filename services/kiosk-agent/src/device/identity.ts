import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const IDENTITY_FILE = "agent-id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * The installation's own identity.
 *
 * A restarted agent has to be recognisable as the same agent, or a fleet's
 * liveness view fills with machines that appear once and go quiet. Generating
 * it per process would do exactly that, and deriving it from a hostname or a
 * MAC address would make two rebuilt kiosks collide. So it is a random value
 * written once, next to the agent's other local state, and read back on every
 * start.
 *
 * A file that cannot be read is replaced rather than fatal: a kiosk that
 * refused to start because of its own identity file would be a printer nobody
 * can use, and a new identity costs one duplicated row in a fleet view.
 */
export async function loadAgentIdentity(directory: string): Promise<string> {
  const path = resolve(directory, IDENTITY_FILE);

  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (UUID_PATTERN.test(existing)) return existing.toLowerCase();
  } catch {
    // No identity yet, or one this machine can no longer read.
  }

  const agentId = randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, agentId, { encoding: "utf8", mode: 0o600 });
  return agentId;
}
