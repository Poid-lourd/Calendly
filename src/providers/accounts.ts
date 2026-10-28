import type { Repo } from "../db/repo.js";
import type { GoogleAccount } from "../db/types.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { type AccountCredentials, type CalendarProvider, InvalidGrantError, type TokenResult } from "./types.js";

// Un compte requis est déconnecté : il faut le reconnecter depuis l'admin.
export class AccountUnavailableError extends Error {
  constructor(readonly email: string) {
    super(`Le compte Google ${email} est déconnecté`);
    this.name = "AccountUnavailableError";
  }
}

// Un compte Google n'appartient qu'à une personne : ses agendas et ses jetons ne se partagent pas entre espaces.
export class AccountTakenError extends Error {
  constructor(readonly email: string) {
    super(`Le compte Google ${email} est déjà connecté par une autre personne`);
    this.name = "AccountTakenError";
  }
}

export class MissingScopesError extends Error {
  constructor(readonly missing: string[]) {
    super(`Autorisations manquantes : ${missing.join(", ")}`);
    this.name = "MissingScopesError";
  }
}

// Accès aux comptes connectés : déchiffrement des jetons, détection des invalid_grant.
export class Accounts {
  constructor(
    private readonly repo: Repo,
    readonly provider: CalendarProvider,
    private readonly key: Buffer,
  ) {}

  private credentials(account: GoogleAccount): AccountCredentials {
    if (account.status !== "connected" || !account.refreshTokenEnc) throw new AccountUnavailableError(account.email);
    try {
      return { accountId: account.id, refreshToken: decrypt(account.refreshTokenEnc, this.key) };
    } catch {
      this.repo.markAccountDisconnected(account.id, "Jeton illisible avec la clé de chiffrement actuelle");
      throw new AccountUnavailableError(account.email);
    }
  }

  // Exécute un appel au fournisseur pour un compte. Un invalid_grant déconnecte le compte sans propager d'erreur fatale.
  async with<T>(accountId: number, fn: (creds: AccountCredentials) => Promise<T>): Promise<T> {
    const account = this.repo.getAccount(accountId);
    if (!account) throw new AccountUnavailableError(`#${accountId}`);
    const creds = this.credentials(account);
    try {
      return await fn(creds);
    } catch (err) {
      if (err instanceof InvalidGrantError) {
        log.warn("compte Google déconnecté (invalid_grant)", { accountId, email: account.email });
        this.repo.markAccountDisconnected(accountId, "Autorisation révoquée ou expirée (invalid_grant)");
        throw new AccountUnavailableError(account.email);
      }
      throw err;
    }
  }

  async connect(userId: number, tokens: TokenResult): Promise<GoogleAccount> {
    const missing = this.provider.connectScopes.filter((s) => !tokens.scopes.includes(s) && s !== "openid" && s !== "email");
    if (missing.length > 0) throw new MissingScopesError(missing);
    if (!tokens.refreshToken) throw new Error("Google n'a pas fourni de refresh token");
    const account = this.repo.upsertAccount(userId, {
      subject: tokens.identity.subject,
      email: tokens.identity.email,
      refreshTokenEnc: encrypt(tokens.refreshToken, this.key),
      scopes: tokens.scopes,
    });
    if (!account) throw new AccountTakenError(tokens.identity.email);
    try {
      await this.sync(account.id);
    } catch (err) {
      log.warn("synchronisation des agendas impossible après connexion", { accountId: account.id, err });
    }
    return this.repo.getAccount(account.id)!;
  }

  async sync(accountId: number): Promise<void> {
    const calendars = await this.with(accountId, (c) => this.provider.listCalendars(c));
    this.repo.syncCalendars(accountId, calendars);
  }

  async remove(accountId: number): Promise<void> {
    const account = this.repo.getAccount(accountId);
    if (!account) return;
    if (account.status === "connected" && account.refreshTokenEnc) {
      try {
        await this.provider.revoke(decrypt(account.refreshTokenEnc, this.key));
      } catch (err) {
        log.warn("révocation du jeton impossible", { accountId, err });
      }
    }
    this.repo.deleteAccount(accountId);
  }
}
