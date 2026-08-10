import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The control plane's headers.
 *
 * Stricter than the customer-facing apps in one respect: WebAuthn create and
 * get are both limited to this origin in the permissions policy, so a ceremony
 * can only ever be requested by this page and never by an embedded frame.
 * Framing is already refused outright, and the two together mean a compromised
 * page elsewhere cannot borrow an operator's security key.
 */
export function securityHeaders(styleSource: string) {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      `style-src ${styleSource}`,
      "img-src 'self' data:",
      "connect-src 'self'"
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  } as const;
}

/**
 * What ships. A built bundle extracts every rule into a real stylesheet loaded
 * with `<link rel="stylesheet">`, so `'self'` covers it and no inline style is
 * needed anywhere. `vite preview` serves that same output, which makes preview
 * the honest rehearsal of the deployed policy.
 */
export const PRODUCTION_STYLE_SOURCE = "'self'";

/**
 * The development server cannot meet that, and fails in a way worth naming.
 *
 * Vite serves each stylesheet as a JavaScript module that injects a `<style>`
 * element at runtime. `style-src 'self'` refuses an inline style block, so
 * under the production policy the dev server delivers the CSS, the browser
 * discards it, and every screen renders as unstyled HTML — no request fails, no
 * error surfaces outside the console, and the dashboard simply looks broken.
 *
 * This is the one place development diverges from production, and it is
 * confined to styles: `script-src` stays `'self'` here, which is why HMR is off
 * above. A stylesheet cannot exfiltrate a session or call the API, and the
 * server is bound to loopback, so the exposure is a local page styling itself.
 */
export const DEVELOPMENT_STYLE_SOURCE = "'self' 'unsafe-inline'";

export default defineConfig(({ command, isPreview, mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const keyPath = environment.DEV_HTTPS_KEY_PATH;
  const certificatePath = environment.DEV_HTTPS_CERT_PATH;
  const isDevelopmentServer = command === "serve" && !isPreview;
  const development = resolveAdminDevelopmentOrigin(
    environment.ADMIN_ORIGIN,
    keyPath,
    certificatePath,
    isDevelopmentServer
  );
  const adminOrigin = development.origin;
  let https: { key: Buffer; cert: Buffer } | undefined;

  if (development.https) {
    https = {
      key: readFileSync(resolve(repositoryRoot, development.keyPath)),
      cert: readFileSync(resolve(repositoryRoot, development.certificatePath))
    };
  }

  return {
    plugins: [react()],
    server: {
      // Loopback only. The control plane is not a public surface, and in
      // development it should not be reachable from the local network.
      host: adminOrigin.hostname,
      port: Number(adminOrigin.port || 5175),
      strictPort: true,
      // Fast Refresh injects an inline bootstrap script; keeping HMR off lets
      // development exercise the same strict script policy as production.
      hmr: false,
      ...(https ? { https } : {}),
      headers: securityHeaders(DEVELOPMENT_STYLE_SOURCE),
      // Same-origin proxy, so the admin session cookie is first-party and the
      // strict `connect-src 'self'` policy above holds.
      proxy: {
        "/v1": {
          target: "http://127.0.0.1:3000",
          changeOrigin: false
        }
      }
    },
    preview: {
      headers: securityHeaders(PRODUCTION_STYLE_SOURCE)
    }
  };
});

export function resolveAdminDevelopmentOrigin(
  configuredOrigin: string | undefined,
  keyPath: string | undefined,
  certificatePath: string | undefined,
  validateForDevelopmentServer: boolean
):
  | { origin: URL; https: false }
  | { origin: URL; https: true; keyPath: string; certificatePath: string } {
  const origin = new URL(configuredOrigin || "http://localhost:5175");
  if (!validateForDevelopmentServer) return { origin, https: false };

  if (!isLoopbackHost(origin.hostname)) {
    throw new Error("Development ADMIN_ORIGIN must use a loopback hostname.");
  }
  if (!origin.port) {
    throw new Error("Development ADMIN_ORIGIN must include its port (normally 5175).");
  }
  if (origin.protocol === "https:") {
    if (!keyPath || !certificatePath) {
      throw new Error("HTTPS ADMIN_ORIGIN requires DEV_HTTPS_CERT_PATH and DEV_HTTPS_KEY_PATH.");
    }
    return { origin, https: true, keyPath, certificatePath };
  }
  if (origin.protocol !== "http:") {
    throw new Error("Development ADMIN_ORIGIN must use http or https.");
  }
  // Shared DEV_HTTPS paths may be present solely for the phone upload app.
  // They must not silently switch an HTTP WebAuthn origin to HTTPS.
  return { origin, https: false };
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(unwrapped) === 6) return unwrapped === "::1";
  return isIP(unwrapped) === 4 && unwrapped.startsWith("127.");
}
