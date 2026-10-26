import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { Availability } from "./domain/availability.js";
import { Bookings } from "./domain/bookings.js";
import { log, setLogLevel } from "./lib/log.js";
import { Accounts } from "./providers/accounts.js";
import { GoogleProvider } from "./providers/google.js";
import { MockProvider } from "./providers/mock.js";
import type { CalendarProvider } from "./providers/types.js";
import { seedDemo } from "./seed.js";
import { createApp } from "./web/app.js";
import type { Assets } from "./web/context.js";
import { RateLimiter } from "./web/ratelimit.js";
import { SignatureRenderer } from "./web/signature.js";

function loadAssets(): Assets {
  const dir = import.meta.dirname;
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("dist/manifest.json introuvable. Lancez npm run build.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
  const pick = (name: string) => {
    const v = manifest[name];
    if (!v) throw new Error(`Ressource ${name} absente du manifeste`);
    return v;
  };
  return { css: pick("app.css"), booking: pick("booking.js"), admin: pick("admin.js"), dir: path.join(dir, "public", "assets") };
}

// Polices WOFF copiées par le build, utilisées pour l'image de la signature.
function fontFiles(): string[] {
  const dir = path.join(import.meta.dirname, "fonts");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".woff"))
    .map((f) => path.join(dir, f));
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  for (const w of config.warnings) log.warn(w);

  const db = openDatabase(config.databasePath);
  const now = () => Date.now();
  const repo = new Repo(db, now);
  const mock = config.provider === "mock" ? new MockProvider(db) : null;
  const provider: CalendarProvider = mock ?? new GoogleProvider({ clientId: config.google!.clientId, clientSecret: config.google!.clientSecret });
  const accounts = new Accounts(repo, provider, config.encryptionKey);
  const availability = new Availability(repo, accounts, now);
  const bookings = new Bookings(repo, accounts, availability, config.baseUrl, now);
  const limiter = new RateLimiter(now);

  if (config.demoSeed && (await seedDemo(repo, accounts))) log.info("données de démonstration créées");
  await bookings.recover();
  repo.purgeExpired();

  const signature = new SignatureRenderer(fontFiles());
  const app = createApp({ config, repo, provider, mock, accounts, availability, bookings, limiter, signature, assets: loadAssets(), now });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info("serveur démarré", { port: info.port, provider: config.provider, baseUrl: config.baseUrl.toString() });
  });

  const timer = setInterval(() => {
    limiter.sweep();
    repo.purgeExpired();
  }, 60_000);
  timer.unref();

  const shutdown = (signal: string) => {
    log.info("arrêt demandé", { signal });
    clearInterval(timer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    log.error(err.message);
  } else {
    log.error("démarrage impossible", { err, stack: err instanceof Error ? err.stack : undefined });
  }
  process.exit(1);
});
