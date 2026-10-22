import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calendarEventId, decrypt, encrypt, pkceChallenge, pkcePair, randomToken } from "../../src/lib/crypto.js";

describe("chiffrement", () => {
  const key = randomBytes(32);

  it("chiffre et déchiffre", () => {
    const enc = encrypt("1//refresh-token", key);
    expect(enc).not.toContain("refresh");
    expect(decrypt(enc, key)).toBe("1//refresh-token");
  });

  it("produit un chiffré différent à chaque appel", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });

  it("refuse une autre clé ou un chiffré altéré", () => {
    const enc = encrypt("secret", key);
    expect(() => decrypt(enc, randomBytes(32))).toThrow();
    const parts = enc.split(".");
    parts[3] = Buffer.from("autre").toString("base64url");
    expect(() => decrypt(parts.join("."), key)).toThrow();
  });
});

describe("jetons", () => {
  it("génère des jetons non devinables", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it("PKCE S256", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkceChallenge(verifier)).toBe(challenge);
  });

  it("identifiant d'événement compatible Google", () => {
    expect(calendarEventId()).toMatch(/^[0-9a-v]{26}$/);
  });
});
