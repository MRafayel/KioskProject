import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface Clock {
  now(): Date;
}

export interface RandomSource {
  uuid(now: Date): string;
  token(byteLength: number): string;
  integer(maxExclusive: number): number;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class CryptoRandomSource implements RandomSource {
  public uuid(now: Date): string {
    return uuidV7(now, randomBytes(10));
  }

  public token(byteLength: number): string {
    return randomBytes(byteLength).toString("base64url");
  }

  public integer(maxExclusive: number): number {
    return randomInt(0, maxExclusive);
  }
}

export function digestUploadValue(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

export function deriveUploadSecrets(
  sessionId: string,
  idempotencyKey: string,
  pepper: string
): { uploadToken: string; shortCode: string } {
  const tokenBytes = deriveSecret("upload-token", sessionId, idempotencyKey, pepper);
  const codeBytes = deriveSecret("short-code", sessionId, idempotencyKey, pepper);
  const code = codeBytes.readBigUInt64BE(0) % 100_000_000n;

  return {
    uploadToken: `u_${tokenBytes.toString("base64url")}`,
    shortCode: code.toString().padStart(8, "0")
  };
}

export function digestIdempotencyKey(
  actorId: string,
  action: string,
  value: string,
  pepper: string
): string {
  return createHmac("sha256", pepper)
    .update("printing-kiosk/idempotency-key/v1", "utf8")
    .update("\0", "utf8")
    .update(actorId, "utf8")
    .update("\0", "utf8")
    .update(action, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function safelyEqualHexDigests(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function digestKioskCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashRequest(value: Readonly<Record<string, string | number>>): string {
  const canonical = Object.keys(value)
    .sort()
    .map((key) => `${key}:${String(value[key])}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function deriveSecret(
  purpose: "upload-token" | "short-code",
  sessionId: string,
  idempotencyKey: string,
  pepper: string
): Buffer {
  return createHmac("sha256", pepper)
    .update(`printing-kiosk/${purpose}/v1`, "utf8")
    .update("\0", "utf8")
    .update(sessionId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest();
}

function uuidV7(now: Date, randomness: Buffer): string {
  const bytes = Buffer.alloc(16);
  let timestamp = BigInt(now.getTime());

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = 0x70 | (randomness[0]! & 0x0f);
  bytes[7] = randomness[1]!;
  bytes[8] = 0x80 | (randomness[2]! & 0x3f);
  randomness.copy(bytes, 9, 3, 10);

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
