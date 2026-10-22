import { DateTime } from "luxon";
import type { DB } from "../db/index.js";
import { pkceChallenge, randomToken } from "../lib/crypto.js";
import {
  type AccountCredentials,
  type BusyPeriod,
  type CalendarProvider,
  type CreatedEvent,
  type EventInput,
  type ExistingEvent,
  InvalidGrantError,
  type OAuthPurpose,
  type ProviderCalendar,
  ProviderError,
  type TokenResult,
} from "./types.js";

// Fournisseur simulé : remplace Google pour l'OAuth, la liste des agendas, les disponibilités et les événements.
// Les événements créés sont conservés en base (table mock_events). Des occupations récurrentes
// rendent les disponibilités réalistes. Un compte dont l'adresse commence par « revoque » simule un invalid_grant.

export const MOCK_COMPANY_CALENDAR = "c_evenements@group.calendar.google.com";
export const MOCK_HOLIDAY_CALENDAR = "fr.french#holiday@group.v.calendar.google.com";
const ZONE = "Europe/Paris";

interface PendingCode {
  email: string;
  codeChallenge: string;
  purpose: OAuthPurpose;
  expiresAt: number;
}

interface Recurring {
  weekday: number;
  start: string;
  end: string;
}

const RECURRING: Record<string, Recurring[]> = {
  primary: [
    { weekday: 1, start: "12:30", end: "13:30" },
    { weekday: 2, start: "12:30", end: "13:30" },
    { weekday: 3, start: "12:30", end: "13:30" },
    { weekday: 3, start: "16:00", end: "17:00" },
    { weekday: 4, start: "12:30", end: "13:30" },
    { weekday: 5, start: "12:30", end: "13:30" },
  ],
  [MOCK_COMPANY_CALENDAR]: [
    { weekday: 2, start: "10:00", end: "11:30" },
    { weekday: 4, start: "14:00", end: "15:00" },
  ],
};

export interface MockEventRow {
  calendarId: string;
  eventId: string;
  summary: string;
  description: string;
  location: string | null;
  start: number;
  end: number;
  status: string;
  attendees: { email: string; name: string }[];
  meetUrl: string | null;
  updatesSent: number;
}

export class MockProvider implements CalendarProvider {
  readonly kind = "mock" as const;
  readonly connectScopes = ["openid", "email", "mock.calendar"];
  private readonly codes = new Map<string, PendingCode>();

  constructor(
    private readonly db: DB,
    private readonly opts: { latencyMs?: number; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async delay(): Promise<void> {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
  }

  private emailFor(account: AccountCredentials): string {
    if (!account.refreshToken.startsWith("mock-refresh:")) throw new InvalidGrantError("Jeton simulé inconnu");
    const email = account.refreshToken.slice("mock-refresh:".length);
    if (email.startsWith("revoque")) throw new InvalidGrantError("Token has been expired or revoked.");
    return email;
  }

  authorizationUrl(input: { state: string; codeChallenge: string; purpose: OAuthPurpose; redirectUri: string }): string {
    const params = new URLSearchParams({
      state: input.state,
      code_challenge: input.codeChallenge,
      purpose: input.purpose,
      redirect_uri: input.redirectUri,
    });
    return `/auth/mock/authorize?${params.toString()}`;
  }

  // Appelé par l'écran de consentement simulé.
  issueCode(input: { email: string; codeChallenge: string; purpose: OAuthPurpose }): string {
    const code = randomToken(24);
    this.codes.set(code, { ...input, email: input.email.toLowerCase(), expiresAt: this.now + 5 * 60_000 });
    return code;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenResult> {
    await this.delay();
    const pending = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!pending || pending.expiresAt < this.now) throw new ProviderError("Code d'autorisation invalide ou expiré", 400);
    if (pkceChallenge(input.codeVerifier) !== pending.codeChallenge) throw new ProviderError("Vérification PKCE échouée", 400);
    return {
      identity: { subject: `mock-${pending.email}`, email: pending.email, emailVerified: true },
      refreshToken: pending.purpose === "connect" ? `mock-refresh:${pending.email}` : null,
      scopes: pending.purpose === "connect" ? this.connectScopes : ["openid", "email"],
    };
  }

  async listCalendars(account: AccountCredentials): Promise<ProviderCalendar[]> {
    await this.delay();
    const email = this.emailFor(account);
    return [
      { externalId: email, summary: email, timeZone: ZONE, accessRole: "owner", primary: true },
      { externalId: MOCK_COMPANY_CALENDAR, summary: "Événements entreprise", timeZone: ZONE, accessRole: "writer", primary: false },
      { externalId: MOCK_HOLIDAY_CALENDAR, summary: "Jours fériés en France", timeZone: ZONE, accessRole: "reader", primary: false },
    ];
  }

  private recurringBusy(calendarId: string, email: string, timeMin: number, timeMax: number): BusyPeriod[] {
    const pattern = calendarId === email ? RECURRING.primary : RECURRING[calendarId];
    if (!pattern) return [];
    const out: BusyPeriod[] = [];
    let day = DateTime.fromMillis(timeMin, { zone: ZONE }).startOf("day");
    const last = DateTime.fromMillis(timeMax, { zone: ZONE }).endOf("day");
    while (day <= last) {
      for (const p of pattern) {
        if (p.weekday !== day.weekday) continue;
        const start = DateTime.fromISO(`${day.toISODate()}T${p.start}`, { zone: ZONE }).toMillis();
        const end = DateTime.fromISO(`${day.toISODate()}T${p.end}`, { zone: ZONE }).toMillis();
        if (start < timeMax && end > timeMin) out.push({ start, end });
      }
      day = day.plus({ days: 1 });
    }
    return out;
  }

  async freeBusy(
    account: AccountCredentials,
    calendarIds: string[],
    timeMin: number,
    timeMax: number,
  ): Promise<Map<string, BusyPeriod[]>> {
    await this.delay();
    const email = this.emailFor(account);
    const result = new Map<string, BusyPeriod[]>();
    const stmt = this.db.prepare(
      "SELECT start_at, end_at FROM mock_events WHERE calendar_external_id = ? AND status != 'cancelled' AND start_at < ? AND end_at > ?",
    );
    for (const id of calendarIds) {
      const stored = (stmt.all(id, timeMax, timeMin) as { start_at: number; end_at: number }[]).map((r) => ({
        start: r.start_at,
        end: r.end_at,
      }));
      result.set(id, [...this.recurringBusy(id, email, timeMin, timeMax), ...stored].sort((a, b) => a.start - b.start));
    }
    return result;
  }

  async createEvent(account: AccountCredentials, calendarId: string, input: EventInput): Promise<CreatedEvent> {
    await this.delay();
    this.emailFor(account);
    if (calendarId === MOCK_HOLIDAY_CALENDAR) throw new ProviderError("Accès en écriture refusé sur cet agenda", 403);
    const meetUrl = input.createMeet
      ? `https://meet.google.com/${input.eventId.slice(0, 3)}-${input.eventId.slice(3, 7)}-${input.eventId.slice(7, 10)}`
      : null;
    const existing = this.db
      .prepare("SELECT meet_url FROM mock_events WHERE calendar_external_id = ? AND event_id = ?")
      .get(calendarId, input.eventId) as { meet_url: string | null } | undefined;
    if (existing) return { eventId: input.eventId, meetUrl: existing.meet_url };
    this.db
      .prepare(
        `INSERT INTO mock_events (calendar_external_id, event_id, summary, description, location, start_at, end_at, status,
           attendees, meet_url, updates_sent) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, 1)`,
      )
      .run(
        calendarId,
        input.eventId,
        input.summary,
        input.description,
        input.location,
        input.start,
        input.end,
        JSON.stringify([input.attendee]),
        meetUrl,
      );
    return { eventId: input.eventId, meetUrl };
  }

  async rescheduleEvent(
    account: AccountCredentials,
    calendarId: string,
    eventId: string,
    input: { start: number; end: number; timeZone: string },
  ): Promise<void> {
    await this.delay();
    this.emailFor(account);
    const res = this.db
      .prepare(
        "UPDATE mock_events SET start_at = ?, end_at = ?, updates_sent = updates_sent + 1 WHERE calendar_external_id = ? AND event_id = ? AND status != 'cancelled'",
      )
      .run(input.start, input.end, calendarId, eventId);
    if (res.changes === 0) throw new ProviderError("Événement introuvable", 404);
  }

  async cancelEvent(account: AccountCredentials, calendarId: string, eventId: string, input: { description: string }): Promise<void> {
    await this.delay();
    this.emailFor(account);
    this.db
      .prepare(
        "UPDATE mock_events SET status = 'cancelled', description = ?, updates_sent = updates_sent + 1 WHERE calendar_external_id = ? AND event_id = ?",
      )
      .run(input.description, calendarId, eventId);
  }

  async getEvent(account: AccountCredentials, calendarId: string, eventId: string): Promise<ExistingEvent | null> {
    await this.delay();
    this.emailFor(account);
    const r = this.db
      .prepare("SELECT status, start_at, end_at FROM mock_events WHERE calendar_external_id = ? AND event_id = ?")
      .get(calendarId, eventId) as { status: string; start_at: number; end_at: number } | undefined;
    if (!r || r.status === "cancelled") return null;
    return { status: r.status, start: r.start_at, end: r.end_at };
  }

  async revoke(): Promise<void> {
    await this.delay();
  }

  // Lecture des événements simulés, pour l'inspection et les tests.
  listEvents(): MockEventRow[] {
    return (this.db.prepare("SELECT * FROM mock_events ORDER BY start_at").all() as Record<string, unknown>[]).map((r) => ({
      calendarId: r.calendar_external_id as string,
      eventId: r.event_id as string,
      summary: r.summary as string,
      description: r.description as string,
      location: r.location as string | null,
      start: r.start_at as number,
      end: r.end_at as number,
      status: r.status as string,
      attendees: JSON.parse(r.attendees as string) as { email: string; name: string }[],
      meetUrl: r.meet_url as string | null,
      updatesSent: r.updates_sent as number,
    }));
  }
}
