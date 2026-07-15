import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    API_HOST: z.string().default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_ORIGIN: z.string().url().default("http://127.0.0.1:3000"),
    KIOSK_AGENT_HOST: z.string().default("127.0.0.1"),
    KIOSK_AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    KIOSK_ORIGIN: z.string().url().default("http://localhost:5173"),
    UPLOAD_ORIGIN: z.string().url().default("http://localhost:5174"),
    PUBLIC_UPLOAD_ORIGIN: z.string().url().default("http://localhost:5174"),
    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk"),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().min(3).default("printing-kiosk-private"),
    COOKIE_SIGNING_KEY: z.string().min(32).default("development-only-cookie-key-change-me"),
    UPLOAD_TOKEN_PEPPER: z.string().min(32).default("development-only-token-pepper-change-me"),
    DEV_KIOSK_API_KEY: z.string().min(24).default("development-only-kiosk-key"),
    DEV_KIOSK_ID: z.string().min(1).max(64).default("kiosk_dev_001"),
    SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().min(2).max(60).default(10),
    SESSION_ABSOLUTE_TTL_MINUTES: z.coerce.number().int().min(2).max(240).default(30),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PRINTER_ADAPTER: z.literal("mock").default("mock"),
    PAYMENT_PROVIDER: z.literal("mock").default("mock")
  })
  .superRefine((environment, context) => {
    if (environment.SESSION_ABSOLUTE_TTL_MINUTES < environment.SESSION_IDLE_TTL_MINUTES) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_ABSOLUTE_TTL_MINUTES"],
        message: "SESSION_ABSOLUTE_TTL_MINUTES must be at least SESSION_IDLE_TTL_MINUTES"
      });
    }

    if (environment.NODE_ENV !== "production") return;

    const productionSecrets = [
      ["COOKIE_SIGNING_KEY", environment.COOKIE_SIGNING_KEY],
      ["UPLOAD_TOKEN_PEPPER", environment.UPLOAD_TOKEN_PEPPER],
      ["DEV_KIOSK_API_KEY", environment.DEV_KIOSK_API_KEY]
    ] as const;

    for (const [name, value] of productionSecrets) {
      if (value.includes("development-only") || value.includes("change-me")) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: name + " must be replaced in production"
        });
      }
    }

    const productionOrigins = [
      ["API_ORIGIN", environment.API_ORIGIN, true],
      ["KIOSK_ORIGIN", environment.KIOSK_ORIGIN, true],
      ["UPLOAD_ORIGIN", environment.UPLOAD_ORIGIN, false],
      ["PUBLIC_UPLOAD_ORIGIN", environment.PUBLIC_UPLOAD_ORIGIN, false]
    ] as const;

    for (const [name, value, allowHttpLoopback] of productionOrigins) {
      const url = new URL(value);
      const isSecure = url.protocol === "https:";
      const isAllowedLoopback =
        allowHttpLoopback && url.protocol === "http:" && isLoopbackHostname(url.hostname);
      if (!isSecure && !isAllowedLoopback) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: name + " must use HTTPS in production"
        });
      }
    }
  });

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}

export { environmentSchema };
