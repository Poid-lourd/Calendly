import { DateTime } from "luxon";
import { sha256 } from "../lib/crypto.js";
import {
  type AccountCredentials,
  type BusyPeriod,
  type CalendarProvider,
  type CreatedEvent,
  type EventInput,
  type ExistingEvent,
  type Identity,
  InvalidGrantError,
  type OAuthPurpose,
  type ProviderCalendar,
  ProviderError,
  type TokenResult,
} from "./types.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

export const LOGIN_SCOPES = ["openid", "email"];
// Scopes les plus restreints couvrant les besoins :
// liste des agendas (lecture seule), disponibilités, création et modification d'événements.
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];

type FetchFn = typeof fetch;

interface Options {
  clientId: string;
  clientSecret: string;
  fetch?: FetchFn;
  now?: () => number;
  timeoutMs?: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

function decodeIdToken(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  if (!payload) throw new ProviderError("id_token invalide");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function text(v: unknown, fallback: string): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : fallback;
}

function rfc3339(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toISO({ suppressMilliseconds: true })!;
}

function parseInstant(v: unknown): number {
  const raw = text(v, "");
  const parsed = DateTime.fromISO(raw, { setZone: true });
  if (!parsed.isValid) throw new ProviderError(`Date invalide renvoyée par Google : ${raw}`);
  return parsed.toMillis();
}

export class GoogleProvider implements CalendarProvider {
  readonly kind = "google" as const;
  readonly connectScopes = [...LOGIN_SCOPES, ...CALENDAR_SCOPES];
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly opts: Options) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  authorizationUrl(input: { state: string; codeChallenge: string; purpose: OAuthPurpose; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    });
    if (input.purpose === "login") {
      params.set("scope", LOGIN_SCOPES.join(" "));
      params.set("access_type", "online");
      params.set("prompt", "select_account");
    } else {
      params.set("scope", this.connectScopes.join(" "));
      params.set("access_type", "offline");
      // consent garantit la délivrance d'un refresh token, même pour un compte déjà autorisé.
      params.set("prompt", "consent select_account");
      params.set("include_granted_scopes", "false");
    }
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenResult> {
    const body = await this.tokenRequest({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
    const idToken = typeof body.id_token === "string" ? body.id_token : null;
    if (!idToken) throw new ProviderError("Réponse OAuth sans id_token");
    const identity = this.identityFrom(idToken);
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
    const scopes = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
    if (refreshToken && typeof body.access_token === "string") {
      this.cacheToken(refreshToken, body.access_token, Number(body.expires_in ?? 0));
    }
    return { identity, refreshToken, scopes };
  }

  // Le jeton d'identité vient directement du point de terminaison de Google, par TLS :
  // OpenID Connect Core 3.1.3.7 dispense alors de vérifier la signature. Émetteur, audience et expiration sont contrôlés.
  private identityFrom(idToken: string): Identity {
    const claims = decodeIdToken(idToken);
    const iss = claims.iss;
    if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") throw new ProviderError("Émetteur id_token inattendu");
    if (claims.aud !== this.opts.clientId) throw new ProviderError("Audience id_token inattendue");
    if (typeof claims.exp !== "number" || claims.exp * 1000 < this.now()) throw new ProviderError("id_token expiré");
    if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw new ProviderError("id_token incomplet");
    return {
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
    };
  }

  private cacheToken(refreshToken: string, accessToken: string, expiresIn: number): void {
    this.tokens.set(sha256(refreshToken), { accessToken, expiresAt: this.now() + Math.max(0, expiresIn - 60) * 1000 });
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, ...params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (body.error === "invalid_grant") throw new InvalidGrantError(text(body.error_description, "invalid_grant"));
      throw new ProviderError(`OAuth : ${text(body.error, String(res.status))}`, res.status);
    }
    return body;
  }

  private async accessToken(account: AccountCredentials, force = false): Promise<string> {
    const key = sha256(account.refreshToken);
    const cached = this.tokens.get(key);
    if (!force && cached && cached.expiresAt > this.now()) return cached.accessToken;
    const body = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: account.refreshToken });
    if (typeof body.access_token !== "string") throw new ProviderError("Réponse OAuth sans access_token");
    this.cacheToken(account.refreshToken, body.access_token, Number(body.expires_in ?? 3600));
    return body.access_token;
  }

  private async api(
    account: AccountCredentials,
    method: string,
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const url = `${API}${path}${Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ""}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(account, attempt > 0);
      const res = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      const data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      return { status: res.status, data };
    }
    throw new ProviderError("Accès refusé par Google après renouvellement du jeton", 401);
  }

  private static fail(what: string, res: { status: number; data: Record<string, unknown> }): never {
    const err = res.data.error as { message?: string } | undefined;
    throw new ProviderError(`${what} : ${err?.message ?? `HTTP ${res.status}`}`, res.status);
  }

  async listCalendars(account: AccountCredentials): Promise<ProviderCalendar[]> {
    const out: ProviderCalendar[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { maxResults: "250", showHidden: "true" };
      if (pageToken) query.pageToken = pageToken;
      const res = await this.api(account, "GET", "/users/me/calendarList", query);
      if (res.status !== 200) GoogleProvider.fail("Liste des agendas", res);
      for (const item of (res.data.items ?? []) as Record<string, unknown>[]) {
        if (item.deleted === true) continue;
        out.push({
          externalId: text(item.id, ""),
          summary: text(item.summaryOverride, text(item.summary, text(item.id, ""))),
          timeZone: typeof item.timeZone === "string" ? item.timeZone : null,
          accessRole: text(item.accessRole, "freeBusyReader"),
          primary: item.primary === true,
        });
      }
      pageToken = typeof res.data.nextPageToken === "string" ? res.data.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  async freeBusy(
    account: AccountCredentials,
    calendarIds: string[],
    timeMin: number,
    timeMax: number,
  ): Promise<Map<string, BusyPeriod[]>> {
    const result = new Map<string, BusyPeriod[]>();
    // Google accepte au plus 50 agendas par requête.
    for (let i = 0; i < calendarIds.length; i += 50) {
      const chunk = calendarIds.slice(i, i + 50);
      const res = await this.api(account, "POST", "/freeBusy", {}, {
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        timeZone: "UTC",
        items: chunk.map((id) => ({ id })),
      });
      if (res.status !== 200) GoogleProvider.fail("Disponibilités", res);
      const calendars = (res.data.calendars ?? {}) as Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }>;
      for (const id of chunk) {
        const entry = calendars[id];
        if (!entry) throw new ProviderError(`Disponibilités absentes pour l'agenda ${id}`);
        if (entry.errors && entry.errors.length > 0) {
          throw new ProviderError(`Disponibilités indisponibles pour l'agenda ${id} : ${entry.errors.map((e) => e.reason).join(", ")}`);
        }
        result.set(
          id,
          (entry.busy ?? []).map((b) => ({ start: parseInstant(b.start), end: parseInstant(b.end) })),
        );
      }
    }
    return result;
  }

  async createEvent(account: AccountCredentials, calendarId: string, input: EventInput): Promise<CreatedEvent> {
    const body: Record<string, unknown> = {
      id: input.eventId,
      summary: input.summary,
      description: input.description,
      start: { dateTime: rfc3339(input.start, input.timeZone), timeZone: input.timeZone },
      end: { dateTime: rfc3339(input.end, input.timeZone), timeZone: input.timeZone },
      attendees: [{ email: input.attendee.email, displayName: input.attendee.name }],
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      reminders: { useDefault: true },
    };
    if (input.location) body.location = input.location;
    if (input.createMeet) {
      body.conferenceData = {
        createRequest: { requestId: input.eventId, conferenceSolutionKey: { type: "hangoutsMeet" } },
      };
    }
    const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
    const res = await this.api(account, "POST", path, { sendUpdates: "all", conferenceDataVersion: "1" }, body);
    if (res.status === 409) {
      // L'événement existe déjà avec cet identifiant : une tentative précédente a abouti.
      const existing = await this.api(account, "GET", `${path}/${encodeURIComponent(input.eventId)}`);
      if (existing.status !== 200) GoogleProvider.fail("Création de l'événement", existing);
      return { eventId: input.eventId, meetUrl: GoogleProvider.meetUrl(existing.data) };
    }
    if (res.status !== 200) GoogleProvider.fail("Création de l'événement", res);
    return { eventId: text(res.data.id, input.eventId), meetUrl: GoogleProvider.meetUrl(res.data) };
  }

  private static meetUrl(event: Record<string, unknown>): string | null {
    if (typeof event.hangoutLink === "string") return event.hangoutLink;
    const conf = event.conferenceData as { entryPoints?: { entryPointType?: string; uri?: string }[] } | undefined;
    const video = conf?.entryPoints?.find((e) => e.entryPointType === "video");
    return video?.uri ?? null;
  }

  async rescheduleEvent(
    account: AccountCredentials,
    calendarId: string,
    eventId: string,
    input: { start: number; end: number; timeZone: string },
  ): Promise<void> {
    const res = await this.api(
      account,
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { sendUpdates: "all" },
      {
        start: { dateTime: rfc3339(input.start, input.timeZone), timeZone: input.timeZone },
        end: { dateTime: rfc3339(input.end, input.timeZone), timeZone: input.timeZone },
      },
    );
    if (res.status !== 200) GoogleProvider.fail("Reprogrammation de l'événement", res);
  }

  async cancelEvent(account: AccountCredentials, calendarId: string, eventId: string, input: { description: string }): Promise<void> {
    const path = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    // Mise à jour silencieuse de la description (motif), puis annulation notifiée aux invités.
    const patch = await this.api(account, "PATCH", path, { sendUpdates: "none" }, { description: input.description });
    if (patch.status === 404 || patch.status === 410) return;
    if (patch.status !== 200) GoogleProvider.fail("Annulation de l'événement", patch);
    const del = await this.api(account, "DELETE", path, { sendUpdates: "all" });
    if (del.status === 204 || del.status === 200 || del.status === 404 || del.status === 410) return;
    GoogleProvider.fail("Annulation de l'événement", del);
  }

  async getEvent(account: AccountCredentials, calendarId: string, eventId: string): Promise<ExistingEvent | null> {
    const res = await this.api(account, "GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    if (res.status === 404 || res.status === 410) return null;
    if (res.status !== 200) GoogleProvider.fail("Lecture de l'événement", res);
    if (res.data.status === "cancelled") return null;
    const start = res.data.start as { dateTime?: string } | undefined;
    const end = res.data.end as { dateTime?: string } | undefined;
    return {
      status: text(res.data.status, "confirmed"),
      start: parseInstant(start?.dateTime),
      end: parseInstant(end?.dateTime),
    };
  }

  async revoke(refreshToken: string): Promise<void> {
    this.tokens.delete(sha256(refreshToken));
    await this.fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
