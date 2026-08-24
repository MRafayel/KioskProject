import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Argon2id password hashing on the runtime's own implementation.
 *
 * Node 24 ships RFC 9106 Argon2 in `node:crypto` (via OpenSSL), so the control
 * plane's one password dependency is the platform itself. The unit tests pin
 * the implementation to the RFC's own argon2id test vector, so a runtime whose
 * argon2 disagrees with the RFC fails the suite rather than the users.
 *
 * Digests are stored as PHC strings — `$argon2id$v=19$m=...,t=...,p=...$salt$tag`
 * — so every hash carries its own parameters. Verification honours the stored
 * parameters, which means the constants below can be raised at any time and
 * existing passwords keep verifying until their next change re-hashes them.
 * The password itself is unrecoverable from the digest by construction, and no
 * caller ever logs or stores the plaintext.
 */

/**
 * OWASP's first recommended Argon2id configuration (19 MiB, t=2, p=1) is the
 * floor; this is comfortably above it. At ten users a login costs one 64 MiB
 * derivation for well under 100ms — invisible at the door, expensive at brute
 * force.
 */
const ARGON2_MEMORY_KIB = 65_536;
const ARGON2_PASSES = 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_TAG_LENGTH = 32;
const ARGON2_SALT_BYTES = 16;
const ARGON2_VERSION = 19;

interface Argon2Parameters {
  memoryKib: number;
  passes: number;
  parallelism: number;
}

function deriveTag(
  password: string,
  salt: Buffer,
  parameters: Argon2Parameters,
  tagLength: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: parameters.parallelism,
        tagLength,
        memory: parameters.memoryKib,
        passes: parameters.passes
      },
      (error, tag) => {
        if (error) reject(error);
        else resolve(Buffer.from(tag));
      }
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2_SALT_BYTES);
  const tag = await deriveTag(
    password,
    salt,
    {
      memoryKib: ARGON2_MEMORY_KIB,
      passes: ARGON2_PASSES,
      parallelism: ARGON2_PARALLELISM
    },
    ARGON2_TAG_LENGTH
  );
  const encode = (buffer: Buffer) => buffer.toString("base64").replace(/=+$/u, "");
  return (
    `$argon2id$v=${ARGON2_VERSION}` +
    `$m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}` +
    `$${encode(salt)}$${encode(tag)}`
  );
}

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,9}),t=(\d{1,4}),p=(\d{1,3})\$([A-Za-z0-9+/]{16,128})\$([A-Za-z0-9+/]{16,128})$/u;

/**
 * Constant-work verification: the derivation runs whether or not the digest
 * will match, and the comparison is constant-time. A malformed stored digest is
 * a false, never a throw — the caller treats it exactly like a wrong password.
 */
export async function verifyPassword(password: string, storedDigest: string): Promise<boolean> {
  const parsed = PHC_PATTERN.exec(storedDigest);
  if (!parsed) return false;

  const [, memory, passes, parallelism, saltText, tagText] = parsed;
  if (!memory || !passes || !parallelism || !saltText || !tagText) return false;
  const memoryKib = Number(memory);
  const storedPasses = Number(passes);
  const storedParallelism = Number(parallelism);
  // Bound what a stored row can make this process compute. Anything outside
  // these was not written by `hashPassword` and verifies as false.
  if (memoryKib < 8 || memoryKib > 1_048_576) return false;
  if (storedPasses < 1 || storedPasses > 16) return false;
  if (storedParallelism < 1 || storedParallelism > 8) return false;

  const salt = Buffer.from(saltText, "base64");
  const expectedTag = Buffer.from(tagText, "base64");
  if (salt.length < 8 || expectedTag.length < 16) return false;

  const actualTag = await deriveTag(
    password,
    salt,
    { memoryKib, passes: storedPasses, parallelism: storedParallelism },
    expectedTag.length
  );
  return actualTag.length === expectedTag.length && timingSafeEqual(actualTag, expectedTag);
}

/**
 * A decoy digest for accounts that do not exist or hold no password. Verifying
 * against it costs the same derivation as a real check, so "no such username"
 * and "wrong password" are indistinguishable by response time as well as by
 * response body. Computed once per process at first use.
 */
let decoyDigest: Promise<string> | null = null;

export function burnEquivalentWork(password: string): Promise<boolean> {
  decoyDigest ??= hashPassword(randomBytes(32).toString("base64url"));
  return decoyDigest.then(async (digest) => {
    await verifyPassword(password, digest);
    return false;
  });
}
