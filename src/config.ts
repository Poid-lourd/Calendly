import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  BASE_URL: optionalString,
  DATA_DIR: z.string().default("./data"),
  CALENDAR_PROVIDER: z.enum(["google", "mock"]).default("google"),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  ADMIN_EMAILS: optionalString,
  ENCRYPTION_KEY: optionalString,
  TRUST_PROXY: bool,
  DEMO_SEED: bool,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  port: number;
  host: string;
  baseUrl: URL;
  secureCookies: boolean;
  dataDir: string;
  databasePath: string;
  provider: "google" | "mock";
  google: { clientId: string; clientSecret: string } | null;
  adminEmails: string[];
  encryptionKey: Buffer;
  trustProxy: boolean;
  demoSeed: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  warnings: string[];
}

export class ConfigError extends Error {}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new ConfigError("ENCRYPTION_KEY doit contenir 32 octets, en base64 ou en hexadécimal (openssl rand -base64 32).");
  }
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Configuration invalide. ${details}`);
  }
  const e = parsed.data;
  const warnings: string[] = [];
  const mock = e.CALENDAR_PROVIDER === "mock";

  let baseUrl: URL;
  try {
    baseUrl = new URL(e.BASE_URL ?? `http://localhost:${e.PORT}`);
  } catch {
    throw new ConfigError("BASE_URL doit être une URL absolue, par exemple https://rdv.exemple.fr.");
  }
  if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new ConfigError("BASE_URL ne doit contenir ni chemin ni paramètres.");
  }

  const adminEmails = (e.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) {
    throw new ConfigError("ADMIN_EMAILS doit contenir au moins une adresse.");
  }

  let google: Config["google"] = null;
  if (!mock) {
    if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
      throw new ConfigError("GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET sont requis avec CALENDAR_PROVIDER=google.");
    }
    google = { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET };
  }

  let encryptionKey: Buffer;
  if (e.ENCRYPTION_KEY) {
    encryptionKey = parseKey(e.ENCRYPTION_KEY);
  } else if (mock) {
    encryptionKey = createHash("sha256").update("rendez-vous-mode-simule").digest();
    warnings.push("ENCRYPTION_KEY absente. Clé de développement utilisée, acceptable uniquement en mode simulé.");
  } else {
    throw new ConfigError("ENCRYPTION_KEY est requise avec CALENDAR_PROVIDER=google.");
  }

  if (e.DEMO_SEED && !mock) {
    warnings.push("DEMO_SEED ignoré : les données de démonstration ne concernent que le mode simulé.");
  }

  const dataDir = path.resolve(e.DATA_DIR);
  return {
    port: e.PORT,
    host: e.HOST,
    baseUrl,
    secureCookies: baseUrl.protocol === "https:",
    dataDir,
    databasePath: path.join(dataDir, "app.db"),
    provider: e.CALENDAR_PROVIDER,
    google,
    adminEmails,
    encryptionKey,
    trustProxy: e.TRUST_PROXY,
    demoSeed: e.DEMO_SEED && mock,
    logLevel: e.LOG_LEVEL,
    warnings,
  };
}
