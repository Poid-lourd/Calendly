import { describe, expect, it } from "vitest";
import { canSignIn, ConfigError, loadConfig } from "../../src/config.js";

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

  it("exige au moins une adresse ou un domaine autorisé", () => {
    expect(() => loadConfig({ CALENDAR_PROVIDER: "mock" })).toThrow(/ADMIN_EMAILS ou ADMIN_DOMAINS/);
    expect(() => loadConfig({ CALENDAR_PROVIDER: "mock", ADMIN_DOMAINS: "pas un domaine" })).toThrow(/ADMIN_DOMAINS/);
    expect(loadConfig({ CALENDAR_PROVIDER: "mock", ADMIN_DOMAINS: "@42Lausanne.ch" }).adminDomains).toEqual(["42lausanne.ch"]);
  });

  it("autorise les adresses listées et celles des domaines, au domaine exact", () => {
    const c = loadConfig({ ...base, CALENDAR_PROVIDER: "mock", ADMIN_DOMAINS: "42lausanne.ch" });
    expect(canSignIn(c, "Moi@Exemple.fr")).toBe(true);
    expect(canSignIn(c, "marie.dupont@42lausanne.ch")).toBe(true);
    expect(canSignIn(c, "intrus@exemple.fr")).toBe(false);
    expect(canSignIn(c, "x@etudiant.42lausanne.ch")).toBe(false);
    expect(canSignIn(c, "x@42lausanne.ch.pirate.com")).toBe(false);
    expect(canSignIn(c, "42lausanne.ch")).toBe(false);
  });
});
