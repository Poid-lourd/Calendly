export type OAuthPurpose = "login" | "connect";

export interface Identity {
  subject: string;
  email: string;
  emailVerified: boolean;
}

export interface TokenResult {
  identity: Identity;
  refreshToken: string | null;
  scopes: string[];
}

export interface ProviderCalendar {
  externalId: string;
  summary: string;
  timeZone: string | null;
  accessRole: string;
  primary: boolean;
}

export interface BusyPeriod {
  start: number;
  end: number;
}

export interface EventInput {
  eventId: string;
  summary: string;
  description: string;
  start: number;
  end: number;
  timeZone: string;
  attendee: { email: string; name: string };
  location: string | null;
  createMeet: boolean;
}

export interface CreatedEvent {
  eventId: string;
  meetUrl: string | null;
}

export interface ExistingEvent {
  status: string;
  start: number;
  end: number;
}

// Identifiants d'un compte connecté : le refresh token déchiffré.
export interface AccountCredentials {
  accountId: number;
  refreshToken: string;
}

export interface CalendarProvider {
  readonly kind: "google" | "mock";
  // Scopes demandés pour connecter un compte d'agenda.
  readonly connectScopes: string[];
  authorizationUrl(input: { state: string; codeChallenge: string; purpose: OAuthPurpose; redirectUri: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenResult>;
  listCalendars(account: AccountCredentials): Promise<ProviderCalendar[]>;
  // Périodes occupées par agenda (identifiant externe), entre timeMin et timeMax.
  freeBusy(account: AccountCredentials, calendarIds: string[], timeMin: number, timeMax: number): Promise<Map<string, BusyPeriod[]>>;
  createEvent(account: AccountCredentials, calendarId: string, input: EventInput): Promise<CreatedEvent>;
  rescheduleEvent(
    account: AccountCredentials,
    calendarId: string,
    eventId: string,
    input: { start: number; end: number; timeZone: string },
  ): Promise<void>;
  cancelEvent(account: AccountCredentials, calendarId: string, eventId: string, input: { description: string }): Promise<void>;
  getEvent(account: AccountCredentials, calendarId: string, eventId: string): Promise<ExistingEvent | null>;
  revoke(refreshToken: string): Promise<void>;
}

// Le refresh token n'est plus valide (révoqué, expiré). Le compte doit être reconnecté.
export class InvalidGrantError extends Error {
  constructor(message = "invalid_grant") {
    super(message);
    this.name = "InvalidGrantError";
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
