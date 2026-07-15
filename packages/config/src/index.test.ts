import { describe, expect, it } from "vitest";

import { loadEnvironment } from "./index.js";

describe("loadEnvironment", () => {
  it("loads safe development defaults", () => {
    const environment = loadEnvironment({});

    expect(environment.API_PORT).toBe(3000);
    expect(environment.PRINTER_ADAPTER).toBe("mock");
  });

  it("rejects development secrets in production", () => {
    expect(() => loadEnvironment({ NODE_ENV: "production" })).toThrow();
  });

  it.each(["API_ORIGIN", "KIOSK_ORIGIN", "UPLOAD_ORIGIN", "PUBLIC_UPLOAD_ORIGIN"] as const)(
    "rejects an insecure remote %s in production",
    (name) => {
      expect(() =>
        loadEnvironment({
          ...secureProductionEnvironment,
          [name]: "http://remote.example.test"
        })
      ).toThrow();
    }
  );

  it("allows HTTP only for loopback API and kiosk origins in production", () => {
    expect(
      loadEnvironment({
        ...secureProductionEnvironment,
        API_ORIGIN: "http://127.0.0.1:3000",
        KIOSK_ORIGIN: "http://localhost:5173"
      })
    ).toMatchObject({
      API_ORIGIN: "http://127.0.0.1:3000",
      KIOSK_ORIGIN: "http://localhost:5173"
    });
  });
});

const secureProductionEnvironment = {
  NODE_ENV: "production",
  API_ORIGIN: "https://api.example.test",
  KIOSK_ORIGIN: "https://kiosk.example.test",
  UPLOAD_ORIGIN: "https://upload.example.test",
  PUBLIC_UPLOAD_ORIGIN: "https://upload.example.test",
  COOKIE_SIGNING_KEY: "production-cookie-signing-key-at-least-32-characters",
  UPLOAD_TOKEN_PEPPER: "production-upload-token-pepper-at-least-32-characters",
  DEV_KIOSK_API_KEY: "production-kiosk-api-key-at-least-24-characters"
} as const;
