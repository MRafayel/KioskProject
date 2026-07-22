import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
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
      host: "0.0.0.0",
      port: 5174,
      strictPort: true,
      // React Fast Refresh injects an inline bootstrap script. Keeping HMR off
      // lets the development server exercise the same strict script policy as
      // production instead of weakening CSP with unsafe-inline.
      hmr: false,
      ...(https ? { https } : {}),
      headers: securityHeaders,
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
