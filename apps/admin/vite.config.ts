import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from "vite";

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

/**
 * Send the headers on every response, including `304 Not Modified`.
 *
 * Vite's own `server.headers` option only reaches responses that carry a body.
 * A conditional request that revalidates to 304 answers without them, and a
 * 304 does not mean "nothing changed" to a cache — it means "reuse what you
 * stored, amended by the headers I just sent" (RFC 9111 §4.3.4). Any header
 * missing from the 304 is therefore taken from the *stored* response.
 *
 * For a security policy that is the wrong outcome, and it fails silently for as
 * long as the cache entry lives. `index.html` is a fixed shell whose body
 * rarely changes, so its ETag rarely changes either: a browser that once
 * fetched this page under an older policy will revalidate to 304 forever and
 * keep enforcing the policy it stored, surviving reloads and browser restarts.
 * Tightening the policy would then apply to new visitors and to nobody else.
 *
 * Registering the headers as the first middleware fixes it at the source.
 * `res.setHeader` before `writeHead` survives onto whatever status is chosen
 * later, so the current policy travels with 200s and 304s alike.
 */
export function alwaysSendSecurityHeaders(headers: Readonly<Record<string, string>>): Plugin {
  const apply = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((_request, response, next) => {
      for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
      next();
    });
  };

  return {
    name: "admin-security-headers",
    configureServer: apply,
    configurePreviewServer: apply
  };
}

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

  // `vite preview` serves the built bundle, so it rehearses the shipped policy;
  // only the dev server needs the inline-style concession.
  const styleSource = isDevelopmentServer ? DEVELOPMENT_STYLE_SOURCE : PRODUCTION_STYLE_SOURCE;

  return {
    plugins: [react(), alwaysSendSecurityHeaders(securityHeaders(styleSource))],
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
      // Headers come from the plugin above rather than `server.headers`, so
      // that a 304 carries them too.
      // Same-origin proxy, so the admin session cookie is first-party and the
      // strict `connect-src 'self'` policy above holds.
      proxy: {
        "/v1": {
          target: "http://127.0.0.1:3000",
          changeOrigin: false
        }
      }
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
