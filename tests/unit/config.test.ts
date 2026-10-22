import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const base = { ADMIN_EMAILS: "Moi@Exemple.fr, autre@exemple.fr" };

describe("configuration", () => {
  it("mode simulé avec valeurs par défaut", () => {
    const c = loadConfig({ ...base, CALENDAR_PROVIDER: "mock" });
    expect(c.provider).toBe("mock");
    expect(c.adminEmails).toEqual(["moi@exemple.fr", "autre@exemple.fr"]);
    expect(c.encryptionKey.length).toBe(32);
    expect(c.warnings.length).toBe(1);
    expect(c.secureCookies).toBe(false);
  });

  it("mode Google exige identifiants et clé", () => {
    expect(() => loadConfig({ ...base })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" })).toThrow(/ENCRYPTION_KEY/);
    const c = loadConfig({
      ...base,
      GOOGLE_CLIENT_ID: "a",
      GOOGLE_CLIENT_SECRET: "b",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      BASE_URL: "https://rdv.exemple.fr",
    });
    expect(c.secureCookies).toBe(true);
    expect(c.google).toEqual({ clientId: "a", clientSecret: "b" });
  });

  it("refuse une clé de mauvaise taille, ignore DEMO_SEED hors simulation", () => {
    expect(() => loadConfig({ ...base, CALENDAR_PROVIDER: "mock", ENCRYPTION_KEY: "abc" })).toThrow(/32 octets/);
    const google = loadConfig({ ...base, GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", ENCRYPTION_KEY: "0".repeat(64), DEMO_SEED: "true" });
    expect(google.demoSeed).toBe(false);
    expect(google.warnings.join(" ")).toMatch(/DEMO_SEED/);
  });

  it("exige au moins un administrateur", () => {
    expect(() => loadConfig({ CALENDAR_PROVIDER: "mock" })).toThrow(/ADMIN_EMAILS/);
  });
});
