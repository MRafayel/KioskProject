import { createHmac, timingSafeEqual } from "node:crypto";

const MOBILE_COOKIE_PREFIX = "m_";
const CSRF_PREFIX = "c_";

export function deriveMobileCookie(
  sessionId: string,
  uploadToken: string,
  clientNonce: string,
  signingKey: string
): string {
  return `${MOBILE_COOKIE_PREFIX}${hmacBytes(
    signingKey,
    "printing-kiosk/mobile-cookie/v1",
    sessionId,
    uploadToken,
    clientNonce
  ).toString("base64url")}`;
}

export function digestMobileCookie(cookie: string, pepper: string): string {
  return hmacBytes(pepper, "printing-kiosk/mobile-cookie-digest/v1", cookie).toString("hex");
}

export function digestClientNonce(clientNonce: string, pepper: string): string {
  return hmacBytes(pepper, "printing-kiosk/mobile-client-nonce/v1", clientNonce).toString("hex");
}

export function deriveCsrfToken(
  cookie: string,
  mobileClientId: string,
  signingKey: string
): string {
  return `${CSRF_PREFIX}${hmacBytes(
    signingKey,
    "printing-kiosk/mobile-csrf/v1",
    cookie,
    mobileClientId
  ).toString("base64url")}`;
}

export function safelyEqualSecrets(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function hmacBytes(key: string, domain: string, ...values: string[]): Buffer {
  const hmac = createHmac("sha256", key).update(domain, "utf8");
  for (const value of values) hmac.update("\0", "utf8").update(value, "utf8");
  return hmac.digest();
}
