import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The control plane's headers.
 *
 * Stricter than the customer-facing apps in one respect: `publickey-credentials
 * -get=(self)` in the permissions policy, so a WebAuthn assertion can only ever
 * be requested by this page and never by an embedded frame. Framing is already
 * refused outright, and the two together mean a compromised page elsewhere
 * cannot borrow an operator's security key.
 */
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
} as const;

export default defineConfig(({ isPreview, mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const keyPath = environment.DEV_HTTPS_KEY_PATH;
  const certificatePath = environment.DEV_HTTPS_CERT_PATH;
  if (Boolean(keyPath) !== Boolean(certificatePath)) {
    throw new Error("DEV_HTTPS_CERT_PATH and DEV_HTTPS_KEY_PATH must be configured together.");
  }
  const https =
    !isPreview && keyPath && certificatePath
      ? {
          key: readFileSync(resolve(repositoryRoot, keyPath)),
          cert: readFileSync(resolve(repositoryRoot, certificatePath))
        }
      : undefined;

  return {
    plugins: [react()],
    server: {
      // Loopback only. The control plane is not a public surface, and in
      // development it should not be reachable from the local network.
      host: "127.0.0.1",
      port: 5175,
      strictPort: true,
      // Fast Refresh injects an inline bootstrap script; keeping HMR off lets
      // development exercise the same strict script policy as production.
      hmr: false,
      ...(https ? { https } : {}),
      headers: securityHeaders,
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
      headers: securityHeaders
    }
  };
});
