import { defineConfig, devices } from "@playwright/test";

// Deux instances en mode simulé : l'une avec données de démonstration, l'autre vide pour les états vides.
const server = (port: number, dir: string, seed: boolean) => ({
  command: `rm -rf ${dir} && node dist/server.js`,
  url: `http://localhost:${port}/healthz`,
  reuseExistingServer: false,
  timeout: 30_000,
  env: {
    CALENDAR_PROVIDER: "mock",
    DEMO_SEED: seed ? "true" : "false",
    ADMIN_EMAILS: "admin@exemple.test",
    DATA_DIR: dir,
    PORT: String(port),
    BASE_URL: `http://localhost:${port}`,
    LOG_LEVEL: "warn",
  },
});

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3101",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
    launchOptions: { args: ["--lang=fr-FR"], env: { ...process.env, LANG: "fr_FR.UTF-8", LANGUAGE: "fr" } },
  },
  projects: [
    { name: "e2e", testMatch: /booking\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [server(3101, ".tmp/e2e-demo", true), server(3102, ".tmp/e2e-vide", false)],
});
