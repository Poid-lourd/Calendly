import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Repo } from "../../src/db/repo.js";
import { encrypt } from "../../src/lib/crypto.js";
import { AccountUnavailableError, Accounts, MissingScopesError } from "../../src/providers/accounts.js";
import { CALENDAR_SCOPES, GoogleProvider } from "../../src/providers/google.js";
import { InvalidGrantError, ProviderError } from "../../src/providers/types.js";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

type Responder = (call: Call) => { status: number; body?: unknown } | undefined;

function fakeFetch(...responders: Responder[]) {
  const calls: Call[] = [];
  const fn = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "",
    };
    calls.push(call);
    for (const r of responders) {
      const res = r(call);
      if (res) {
        return Promise.resolve(
          new Response(res.body === undefined ? null : JSON.stringify(res.body), {
            status: res.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    return Promise.reject(new Error(`Requête inattendue ${call.method} ${call.url.toString()}`));
  };
  return { fn: fn as typeof fetch, calls };
}

const NOW = Date.parse("2027-01-04T08:00:00Z");
const CLIENT_ID = "client-123.apps.googleusercontent.com";

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.signature`;
}

const validClaims = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "1234567890",
  email: "Moi@Exemple.fr",
  email_verified: true,
  exp: NOW / 1000 + 3600,
};

const refreshOk: Responder = (c) =>
  c.url.href === "https://oauth2.googleapis.com/token" && c.body.includes("grant_type=refresh_token")
    ? { status: 200, body: { access_token: "access-1", expires_in: 3599, token_type: "Bearer" } }
    : undefined;

function provider(fetchFn: typeof fetch) {
  return new GoogleProvider({ clientId: CLIENT_ID, clientSecret: "secret", fetch: fetchFn, now: () => NOW });
}

const creds = { accountId: 1, refreshToken: "1//refresh" };

describe("OAuth Google", () => {
  it("demande un accès hors ligne avec PKCE et les scopes restreints", () => {
    const url = new URL(
      provider(fakeFetch().fn).authorizationUrl({
        state: "st",
        codeChallenge: "ch",
        purpose: "connect",
        redirectUri: "https://rdv.exemple.fr/auth/google/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("prompt")).toContain("consent");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", ...CALENDAR_SCOPES]);
    expect(url.searchParams.get("scope")).not.toContain("auth/calendar ");
  });

  it("la connexion admin ne demande que l'identité", () => {
    const url = new URL(
      provider(fakeFetch().fn).authorizationUrl({ state: "s", codeChallenge: "c", purpose: "login", redirectUri: "https://x/cb" }),
    );
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("access_type")).toBe("online");
  });

  it("échange le code avec le vérificateur PKCE et lit l'identité", async () => {
    const f = fakeFetch((c) =>
      c.url.href === "https://oauth2.googleapis.com/token"
        ? {
            status: 200,
            body: {
              access_token: "access-0",
              expires_in: 3599,
              refresh_token: "1//refresh",
              scope: ["openid", "https://www.googleapis.com/auth/userinfo.email", ...CALENDAR_SCOPES].join(" "),
              id_token: idToken(validClaims),
            },
          }
        : undefined,
    );
    const tokens = await provider(f.fn).exchangeCode({ code: "abc", codeVerifier: "verifier", redirectUri: "https://x/cb" });
    const sent = new URLSearchParams(f.calls[0]!.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("verifier");
    expect(sent.get("client_secret")).toBe("secret");
    expect(tokens.identity).toEqual({ subject: "1234567890", email: "moi@exemple.fr", emailVerified: true });
    expect(tokens.refreshToken).toBe("1//refresh");
    expect(tokens.scopes).toContain(CALENDAR_SCOPES[0]);
  });

  it("refuse un id_token destiné à une autre application", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: "a", id_token: idToken({ ...validClaims, aud: "autre" }) } }));
    await expect(provider(f.fn).exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "r" })).rejects.toThrow(/Audience/);
  });

  it("traduit invalid_grant en erreur dédiée", async () => {
    const f = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await expect(provider(f.fn).listCalendars(creds)).rejects.toBeInstanceOf(InvalidGrantError);
  });
});

describe("API Agenda", () => {
  it("liste tous les agendas, pagination et agendas partagés compris", async () => {
    const f = fakeFetch(refreshOk, (c) => {
      if (!c.url.pathname.endsWith("/users/me/calendarList")) return undefined;
      expect(c.headers.authorization).toBe("Bearer access-1");
      if (!c.url.searchParams.get("pageToken")) {
        return {
          status: 200,
          body: {
            items: [{ id: "moi@exemple.fr", summary: "moi@exemple.fr", accessRole: "owner", primary: true, timeZone: "Europe/Paris" }],
            nextPageToken: "p2",
          },
        };
      }
      return {
        status: 200,
        body: {
          items: [
            { id: "c_evt@group.calendar.google.com", summary: "Événements", summaryOverride: "Événements entreprise", accessRole: "writer" },
            { id: "old@group.calendar.google.com", summary: "Ancien", accessRole: "reader", deleted: true },
          ],
        },
      };
    });
    const list = await provider(f.fn).listCalendars(creds);
    expect(list).toEqual([
      { externalId: "moi@exemple.fr", summary: "moi@exemple.fr", timeZone: "Europe/Paris", accessRole: "owner", primary: true },
      { externalId: "c_evt@group.calendar.google.com", summary: "Événements entreprise", timeZone: null, accessRole: "writer", primary: false },
    ]);
    // Un seul renouvellement de jeton pour deux pages.
    expect(f.calls.filter((c) => c.url.hostname === "oauth2.googleapis.com").length).toBe(1);
  });

  it("interroge freebusy et convertit les périodes", async () => {
    const f = fakeFetch(refreshOk, (c) => {
      if (!c.url.pathname.endsWith("/freeBusy")) return undefined;
      const body = JSON.parse(c.body) as { items: { id: string }[]; timeMin: string };
      expect(body.items).toEqual([{ id: "a" }, { id: "b" }]);
      expect(body.timeMin).toBe("2027-01-04T00:00:00.000Z");
      return {
        status: 200,
        body: {
          calendars: {
            a: { busy: [{ start: "2027-01-04T10:00:00+01:00", end: "2027-01-04T11:00:00+01:00" }] },
            b: { busy: [] },
          },
        },
      };
    });
    const res = await provider(f.fn).freeBusy(creds, ["a", "b"], Date.parse("2027-01-04T00:00:00Z"), Date.parse("2027-01-05T00:00:00Z"));
    expect(res.get("a")).toEqual([{ start: Date.parse("2027-01-04T09:00:00Z"), end: Date.parse("2027-01-04T10:00:00Z") }]);
    expect(res.get("b")).toEqual([]);
  });

  it("échoue si freebusy signale une erreur sur un agenda", async () => {
    const f = fakeFetch(refreshOk, (c) =>
      c.url.pathname.endsWith("/freeBusy")
        ? { status: 200, body: { calendars: { a: { errors: [{ domain: "global", reason: "notFound" }], busy: [] } } } }
        : undefined,
    );
    await expect(provider(f.fn).freeBusy(creds, ["a"], 0, 1)).rejects.toThrow(/notFound/);
  });

  it("crée l'événement avec invitation et lien Meet", async () => {
    const f = fakeFetch(refreshOk, (c) => {
      if (c.method !== "POST" || !c.url.pathname.includes("/events")) return undefined;
      return {
        status: 200,
        body: { id: "evt123", hangoutLink: "https://meet.google.com/abc-defg-hij", status: "confirmed" },
      };
    });
    const created = await provider(f.fn).createEvent(creds, "c_evt@group.calendar.google.com", {
      eventId: "evt123",
      summary: "Échange",
      description: "Annuler : https://x/b/t/annuler",
      start: Date.parse("2027-01-04T09:00:00Z"),
      end: Date.parse("2027-01-04T09:30:00Z"),
      timeZone: "Europe/Paris",
      attendee: { email: "invite@exemple.fr", name: "Invité" },
      location: null,
      createMeet: true,
    });
    const call = f.calls.find((c) => c.method === "POST" && c.url.pathname.includes("/events"))!;
    expect(call.url.pathname).toBe("/calendar/v3/calendars/c_evt%40group.calendar.google.com/events");
    expect(call.url.searchParams.get("sendUpdates")).toBe("all");
    expect(call.url.searchParams.get("conferenceDataVersion")).toBe("1");
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.attendees).toEqual([{ email: "invite@exemple.fr", displayName: "Invité" }]);
    expect(body.start).toEqual({ dateTime: "2027-01-04T10:00:00+01:00", timeZone: "Europe/Paris" });
    expect(body.conferenceData).toEqual({ createRequest: { requestId: "evt123", conferenceSolutionKey: { type: "hangoutsMeet" } } });
    expect(created).toEqual({ eventId: "evt123", meetUrl: "https://meet.google.com/abc-defg-hij" });
  });

  it("renouvelle le jeton une fois après un 401", async () => {
    let first = true;
    const f = fakeFetch(refreshOk, (c) => {
      if (!c.url.pathname.includes("/events/")) return undefined;
      if (first) {
        first = false;
        return { status: 401, body: { error: { message: "Invalid Credentials" } } };
      }
      return { status: 200, body: { status: "confirmed", start: { dateTime: "2027-01-04T10:00:00+01:00" }, end: { dateTime: "2027-01-04T10:30:00+01:00" } } };
    });
    const ev = await provider(f.fn).getEvent(creds, "cal", "evt");
    expect(ev).toEqual({ status: "confirmed", start: Date.parse("2027-01-04T09:00:00Z"), end: Date.parse("2027-01-04T09:30:00Z") });
    expect(f.calls.filter((c) => c.url.hostname === "oauth2.googleapis.com").length).toBe(2);
  });

  it("reprogramme avec notification", async () => {
    const f = fakeFetch(refreshOk, (c) => (c.method === "PATCH" ? { status: 200, body: { id: "evt" } } : undefined));
    await provider(f.fn).rescheduleEvent(creds, "cal", "evt", {
      start: Date.parse("2027-07-05T07:00:00Z"),
      end: Date.parse("2027-07-05T08:00:00Z"),
      timeZone: "Europe/Paris",
    });
    const call = f.calls.find((c) => c.method === "PATCH")!;
    expect(call.url.searchParams.get("sendUpdates")).toBe("all");
    expect(JSON.parse(call.body)).toEqual({
      start: { dateTime: "2027-07-05T09:00:00+02:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2027-07-05T10:00:00+02:00", timeZone: "Europe/Paris" },
    });
  });

  it("annule : description sans notification, puis suppression notifiée", async () => {
    const f = fakeFetch(
      refreshOk,
      (c) => (c.method === "PATCH" ? { status: 200, body: {} } : undefined),
      (c) => (c.method === "DELETE" ? { status: 410, body: { error: { message: "Resource has been deleted" } } } : undefined),
    );
    await provider(f.fn).cancelEvent(creds, "cal", "evt", { description: "Annulé. Motif : imprévu" });
    const patch = f.calls.find((c) => c.method === "PATCH")!;
    const del = f.calls.find((c) => c.method === "DELETE")!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("none");
    expect(del.url.searchParams.get("sendUpdates")).toBe("all");
  });

  it("signale les erreurs de l'API", async () => {
    const f = fakeFetch(refreshOk, () => ({ status: 403, body: { error: { message: "Forbidden" } } }));
    await expect(provider(f.fn).listCalendars(creds)).rejects.toBeInstanceOf(ProviderError);
  });

  it("considère un événement annulé comme absent", async () => {
    const f = fakeFetch(refreshOk, () => ({ status: 200, body: { status: "cancelled" } }));
    expect(await provider(f.fn).getEvent(creds, "cal", "evt")).toBeNull();
  });
});

describe("comptes connectés", () => {
  const key = randomBytes(32);

  it("un invalid_grant marque le compte déconnecté sans planter", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const account = repo.upsertAccount({ subject: "s", email: "moi@exemple.fr", refreshTokenEnc: encrypt("1//r", key), scopes: [] });
    const f = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
    const accounts = new Accounts(repo, provider(f.fn), key);
    await expect(accounts.sync(account.id)).rejects.toBeInstanceOf(AccountUnavailableError);
    const after = repo.getAccount(account.id)!;
    expect(after.status).toBe("disconnected");
    expect(after.lastError).toMatch(/invalid_grant/);
    // Les appels suivants échouent immédiatement, sans requête réseau.
    const before = f.calls.length;
    await expect(accounts.sync(account.id)).rejects.toBeInstanceOf(AccountUnavailableError);
    expect(f.calls.length).toBe(before);
  });

  it("refuse une connexion sans les scopes agenda", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const accounts = new Accounts(repo, provider(fakeFetch().fn), key);
    await expect(
      accounts.connect({
        identity: { subject: "s", email: "a@b.c", emailVerified: true },
        refreshToken: "r",
        scopes: ["openid", "email"],
      }),
    ).rejects.toBeInstanceOf(MissingScopesError);
    expect(repo.listAccounts()).toEqual([]);
  });

  it("stocke le refresh token chiffré et synchronise les agendas", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const f = fakeFetch(refreshOk, (c) =>
      c.url.pathname.endsWith("/calendarList")
        ? { status: 200, body: { items: [{ id: "moi@exemple.fr", summary: "moi", accessRole: "owner", primary: true }] } }
        : undefined,
    );
    const accounts = new Accounts(repo, provider(f.fn), key);
    const acc = await accounts.connect({
      identity: { subject: "s", email: "moi@exemple.fr", emailVerified: true },
      refreshToken: "1//secret-refresh",
      scopes: ["openid", "email", ...CALENDAR_SCOPES],
    });
    expect(acc.refreshTokenEnc).not.toContain("secret-refresh");
    const raw = repo.db.prepare("SELECT refresh_token_enc FROM google_accounts").get() as { refresh_token_enc: string };
    expect(raw.refresh_token_enc.startsWith("v1.")).toBe(true);
    expect(repo.listCalendars().map((c) => c.externalId)).toEqual(["moi@exemple.fr"]);
  });
});
