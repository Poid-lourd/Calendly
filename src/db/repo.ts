import type { DB } from "./index.js";
import type {
  Booking,
  BookingStatus,
  Calendar,
  EventType,
  GoogleAccount,
  LocationType,
  MinuteRange,
  Schedule,
  ScheduleDetail,
  Settings,
  Visibility,
} from "./types.js";

type Row = Record<string, unknown>;

const num = (v: unknown): number => v as number;
const str = (v: unknown): string => v as string;
const nnum = (v: unknown): number | null => (v === null || v === undefined ? null : (v as number));
const nstr = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string));

function toAccount(r: Row): GoogleAccount {
  return {
    id: num(r.id),
    subject: str(r.subject),
    email: str(r.email),
    refreshTokenEnc: nstr(r.refresh_token_enc),
    scopes: str(r.scopes).split(" ").filter(Boolean),
    status: r.status as GoogleAccount["status"],
    lastError: nstr(r.last_error),
    connectedAt: num(r.connected_at),
    syncedAt: nnum(r.synced_at),
  };
}

function toRange(r: Row): MinuteRange {
  const maxSlots = nnum(r.max_slots);
  return maxSlots === null ? { start: num(r.start_minute), end: num(r.end_minute) } : { start: num(r.start_minute), end: num(r.end_minute), maxSlots };
}

function toCalendar(r: Row): Calendar {
  return {
    id: num(r.id),
    accountId: num(r.account_id),
    externalId: str(r.external_id),
    summary: str(r.summary),
    timeZone: nstr(r.time_zone),
    accessRole: str(r.access_role),
    isPrimary: r.is_primary === 1,
    present: r.present === 1,
  };
}

function toEventType(r: Row, blocking: number[]): EventType {
  return {
    id: num(r.id),
    slug: str(r.slug),
    title: str(r.title),
    description: str(r.description),
    durationMinutes: num(r.duration_minutes),
    locationType: r.location_type as LocationType,
    locationValue: str(r.location_value),
    scheduleId: num(r.schedule_id),
    destinationCalendarId: num(r.destination_calendar_id),
    slotIntervalMinutes: nnum(r.slot_interval_minutes),
    bufferBeforeMinutes: num(r.buffer_before_minutes),
    bufferAfterMinutes: num(r.buffer_after_minutes),
    minNoticeMinutes: num(r.min_notice_minutes),
    maxHorizonDays: num(r.max_horizon_days),
    dailyLimit: nnum(r.daily_limit),
    visibility: r.visibility as Visibility,
    active: r.active === 1,
    position: num(r.position),
    blockingCalendarIds: blocking,
  };
}

function toBooking(r: Row): Booking {
  return {
    id: num(r.id),
    eventTypeId: num(r.event_type_id),
    calendarId: nnum(r.calendar_id),
    startAt: num(r.start_at),
    endAt: num(r.end_at),
    pendingStartAt: nnum(r.pending_start_at),
    pendingEndAt: nnum(r.pending_end_at),
    title: str(r.title),
    locationType: r.location_type as LocationType,
    locationValue: str(r.location_value),
    inviteeName: str(r.invitee_name),
    inviteeEmail: str(r.invitee_email),
    inviteeNote: str(r.invitee_note),
    inviteeTimeZone: str(r.invitee_time_zone),
    status: r.status as BookingStatus,
    externalEventId: str(r.external_event_id),
    meetUrl: nstr(r.meet_url),
    cancelReason: nstr(r.cancel_reason),
    cancelledBy: r.cancelled_by as Booking["cancelledBy"],
    cancelledAt: nnum(r.cancelled_at),
    rescheduledAt: nnum(r.rescheduled_at),
    createdAt: num(r.created_at),
  };
}

export interface EventTypeInput {
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  locationType: LocationType;
  locationValue: string;
  scheduleId: number;
  destinationCalendarId: number;
  slotIntervalMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  dailyLimit: number | null;
  visibility: Visibility;
  active: boolean;
  blockingCalendarIds: number[];
}

export interface NewBooking {
  eventTypeId: number;
  calendarId: number;
  startAt: number;
  endAt: number;
  title: string;
  locationType: LocationType;
  locationValue: string;
  inviteeName: string;
  inviteeEmail: string;
  inviteeNote: string;
  inviteeTimeZone: string;
  tokenHash: string;
  externalEventId: string;
}

export interface LocalBusy {
  start: number;
  end: number;
  before: number;
  after: number;
}

export class Repo {
  constructor(
    readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  // Exécute fn dans une transaction BEGIN IMMEDIATE : aucun autre écrivain ne peut s'intercaler.
  immediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // Réglages

  getSettings(): Settings {
    const r = this.db
      .prepare(
        `SELECT display_name, accent_color, avatar IS NOT NULL AS has_avatar, avatar_updated_at, signature_event_type_id,
           signature_max_slots FROM settings WHERE id = 1`,
      )
      .get() as Row;
    return {
      displayName: str(r.display_name),
      accentColor: str(r.accent_color),
      hasAvatar: r.has_avatar === 1,
      avatarUpdatedAt: nnum(r.avatar_updated_at),
      signatureEventTypeId: nnum(r.signature_event_type_id),
      signatureMaxSlots: num(r.signature_max_slots),
    };
  }

  updateSignature(input: { eventTypeId: number | null; maxSlots: number }): void {
    this.db
      .prepare("UPDATE settings SET signature_event_type_id = ?, signature_max_slots = ?, updated_at = ? WHERE id = 1")
      .run(input.eventTypeId, input.maxSlots, this.now());
  }

  updateSettings(input: { displayName: string; accentColor: string }): void {
    this.db
      .prepare("UPDATE settings SET display_name = ?, accent_color = ?, updated_at = ? WHERE id = 1")
      .run(input.displayName, input.accentColor, this.now());
  }

  setAvatar(data: Buffer | null, type: string | null): void {
    this.db
      .prepare("UPDATE settings SET avatar = ?, avatar_type = ?, avatar_updated_at = ?, updated_at = ? WHERE id = 1")
      .run(data, type, data ? this.now() : null, this.now());
  }

  getAvatar(): { data: Buffer; type: string } | null {
    const r = this.db.prepare("SELECT avatar, avatar_type FROM settings WHERE id = 1").get() as Row;
    if (!r.avatar || !r.avatar_type) return null;
    return { data: r.avatar as Buffer, type: str(r.avatar_type) };
  }

  // Sessions admin

  createSession(idHash: string, email: string, ttlMs: number): void {
    const now = this.now();
    this.db
      .prepare("INSERT INTO admin_sessions (id_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(idHash, email, now, now + ttlMs);
  }

  getSession(idHash: string): { email: string } | null {
    const r = this.db
      .prepare("SELECT email FROM admin_sessions WHERE id_hash = ? AND expires_at > ?")
      .get(idHash, this.now()) as Row | undefined;
    return r ? { email: str(r.email) } : null;
  }

  deleteSession(idHash: string): void {
    this.db.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").run(idHash);
  }

  // OAuth

  saveOAuthState(state: string, codeVerifier: string, purpose: "login" | "connect", ttlMs: number): void {
    const now = this.now();
    this.db
      .prepare("INSERT INTO oauth_states (state, code_verifier, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(state, codeVerifier, purpose, now, now + ttlMs);
  }

  // Lecture et suppression en une fois : un state ne sert qu'une seule fois.
  consumeOAuthState(state: string): { codeVerifier: string; purpose: "login" | "connect" } | null {
    return this.immediate(() => {
      const r = this.db
        .prepare("SELECT code_verifier, purpose, expires_at FROM oauth_states WHERE state = ?")
        .get(state) as Row | undefined;
      if (!r) return null;
      this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
      if (num(r.expires_at) <= this.now()) return null;
      return { codeVerifier: str(r.code_verifier), purpose: r.purpose as "login" | "connect" };
    });
  }

  purgeExpired(): void {
    const now = this.now();
    this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
  }

  // Comptes Google

  listAccounts(): GoogleAccount[] {
    return (this.db.prepare("SELECT * FROM google_accounts ORDER BY connected_at").all() as Row[]).map(toAccount);
  }

  getAccount(id: number): GoogleAccount | null {
    const r = this.db.prepare("SELECT * FROM google_accounts WHERE id = ?").get(id) as Row | undefined;
    return r ? toAccount(r) : null;
  }

  upsertAccount(input: { subject: string; email: string; refreshTokenEnc: string; scopes: string[] }): GoogleAccount {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO google_accounts (subject, email, refresh_token_enc, scopes, status, last_error, connected_at, updated_at)
         VALUES (@subject, @email, @token, @scopes, 'connected', NULL, @now, @now)
         ON CONFLICT (subject) DO UPDATE SET email = @email, refresh_token_enc = @token, scopes = @scopes,
           status = 'connected', last_error = NULL, connected_at = @now, updated_at = @now`,
      )
      .run({ subject: input.subject, email: input.email, token: input.refreshTokenEnc, scopes: input.scopes.join(" "), now });
    return toAccount(this.db.prepare("SELECT * FROM google_accounts WHERE subject = ?").get(input.subject) as Row);
  }

  markAccountDisconnected(id: number, error: string): void {
    this.db
      .prepare("UPDATE google_accounts SET status = 'disconnected', last_error = ?, updated_at = ? WHERE id = ?")
      .run(error, this.now(), id);
  }

  deleteAccount(id: number): void {
    this.immediate(() => {
      this.db.prepare("UPDATE bookings SET calendar_id = NULL WHERE calendar_id IN (SELECT id FROM calendars WHERE account_id = ?)").run(id);
      this.db.prepare("DELETE FROM google_accounts WHERE id = ?").run(id);
    });
  }

  // Agendas

  listCalendars(): Calendar[] {
    return (
      this.db.prepare("SELECT * FROM calendars ORDER BY account_id, is_primary DESC, summary COLLATE NOCASE").all() as Row[]
    ).map(toCalendar);
  }

  getCalendar(id: number): Calendar | null {
    const r = this.db.prepare("SELECT * FROM calendars WHERE id = ?").get(id) as Row | undefined;
    return r ? toCalendar(r) : null;
  }

  syncCalendars(
    accountId: number,
    items: { externalId: string; summary: string; timeZone: string | null; accessRole: string; primary: boolean }[],
  ): void {
    const now = this.now();
    this.immediate(() => {
      this.db.prepare("UPDATE calendars SET present = 0 WHERE account_id = ?").run(accountId);
      const upsert = this.db.prepare(
        `INSERT INTO calendars (account_id, external_id, summary, time_zone, access_role, is_primary, present, updated_at)
         VALUES (@accountId, @externalId, @summary, @timeZone, @accessRole, @primary, 1, @now)
         ON CONFLICT (account_id, external_id) DO UPDATE SET summary = @summary, time_zone = @timeZone,
           access_role = @accessRole, is_primary = @primary, present = 1, updated_at = @now`,
      );
      for (const it of items) {
        upsert.run({ accountId, ...it, primary: it.primary ? 1 : 0, now });
      }
      // Les agendas disparus et inutilisés sont supprimés ; ceux encore référencés restent marqués absents.
      this.db
        .prepare(
          `DELETE FROM calendars WHERE account_id = ? AND present = 0
             AND id NOT IN (SELECT destination_calendar_id FROM event_types)
             AND id NOT IN (SELECT calendar_id FROM event_type_calendars)`,
        )
        .run(accountId);
      this.db.prepare("UPDATE google_accounts SET synced_at = ? WHERE id = ?").run(now, accountId);
    });
  }

  // Types d'événements qui utilisent les agendas d'un compte.
  eventTypesUsingAccount(accountId: number): { id: number; title: string }[] {
    return this.db
      .prepare(
        `SELECT DISTINCT e.id, e.title FROM event_types e
         LEFT JOIN event_type_calendars ec ON ec.event_type_id = e.id
         WHERE e.destination_calendar_id IN (SELECT id FROM calendars WHERE account_id = @a)
            OR ec.calendar_id IN (SELECT id FROM calendars WHERE account_id = @a)
         ORDER BY e.title`,
      )
      .all({ a: accountId }) as { id: number; title: string }[];
  }

  // Plannings

  listSchedules(): Schedule[] {
    return (this.db.prepare("SELECT id, name, time_zone FROM schedules ORDER BY name COLLATE NOCASE").all() as Row[]).map(
      (r) => ({ id: num(r.id), name: str(r.name), timeZone: str(r.time_zone) }),
    );
  }

  getSchedule(id: number): ScheduleDetail | null {
    const r = this.db.prepare("SELECT id, name, time_zone FROM schedules WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    const weekly: Record<number, MinuteRange[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    for (const rule of this.db
      .prepare("SELECT weekday, start_minute, end_minute, max_slots FROM schedule_rules WHERE schedule_id = ? ORDER BY weekday, start_minute")
      .all(id) as Row[]) {
      weekly[num(rule.weekday)]!.push(toRange(rule));
    }
    const overrides: Record<string, MinuteRange[]> = {};
    for (const o of this.db
      .prepare("SELECT date, start_minute, end_minute, max_slots FROM schedule_overrides WHERE schedule_id = ? ORDER BY date, start_minute")
      .all(id) as Row[]) {
      const list = (overrides[str(o.date)] ??= []);
      if (o.start_minute !== null) list.push(toRange(o));
    }
    return { id: num(r.id), name: str(r.name), timeZone: str(r.time_zone), weekly, overrides };
  }

  saveSchedule(id: number | null, input: { name: string; timeZone: string; weekly: Record<number, MinuteRange[]> }): number {
    const now = this.now();
    return this.immediate(() => {
      let scheduleId = id;
      if (scheduleId === null) {
        scheduleId = Number(
          this.db
            .prepare("INSERT INTO schedules (name, time_zone, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .run(input.name, input.timeZone, now, now).lastInsertRowid,
        );
      } else {
        this.db
          .prepare("UPDATE schedules SET name = ?, time_zone = ?, updated_at = ? WHERE id = ?")
          .run(input.name, input.timeZone, now, scheduleId);
        this.db.prepare("DELETE FROM schedule_rules WHERE schedule_id = ?").run(scheduleId);
      }
      const insert = this.db.prepare(
        "INSERT INTO schedule_rules (schedule_id, weekday, start_minute, end_minute, max_slots) VALUES (?, ?, ?, ?, ?)",
      );
      for (const [day, ranges] of Object.entries(input.weekly)) {
        for (const r of ranges) insert.run(scheduleId, Number(day), r.start, r.end, r.maxSlots ?? null);
      }
      return scheduleId;
    });
  }

  setOverride(scheduleId: number, date: string, ranges: MinuteRange[]): void {
    this.immediate(() => {
      this.db.prepare("DELETE FROM schedule_overrides WHERE schedule_id = ? AND date = ?").run(scheduleId, date);
      const insert = this.db.prepare(
        "INSERT INTO schedule_overrides (schedule_id, date, start_minute, end_minute, max_slots) VALUES (?, ?, ?, ?, ?)",
      );
      if (ranges.length === 0) insert.run(scheduleId, date, null, null, null);
      for (const r of ranges) insert.run(scheduleId, date, r.start, r.end, r.maxSlots ?? null);
      this.db.prepare("UPDATE schedules SET updated_at = ? WHERE id = ?").run(this.now(), scheduleId);
    });
  }

  deleteOverride(scheduleId: number, date: string): void {
    this.db.prepare("DELETE FROM schedule_overrides WHERE schedule_id = ? AND date = ?").run(scheduleId, date);
  }

  eventTypesUsingSchedule(scheduleId: number): { id: number; title: string }[] {
    return this.db
      .prepare("SELECT id, title FROM event_types WHERE schedule_id = ? ORDER BY title")
      .all(scheduleId) as { id: number; title: string }[];
  }

  deleteSchedule(id: number): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  // Types d'événements

  private blockingFor(ids: number[]): Map<number, number[]> {
    const map = new Map<number, number[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(`SELECT event_type_id, calendar_id FROM event_type_calendars WHERE event_type_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Row[];
    for (const r of rows) map.get(num(r.event_type_id))?.push(num(r.calendar_id));
    return map;
  }

  private eventTypesFrom(rows: Row[]): EventType[] {
    const blocking = this.blockingFor(rows.map((r) => num(r.id)));
    return rows.map((r) => toEventType(r, blocking.get(num(r.id)) ?? []));
  }

  listEventTypes(): EventType[] {
    return this.eventTypesFrom(
      this.db.prepare("SELECT * FROM event_types ORDER BY position, title COLLATE NOCASE").all() as Row[],
    );
  }

  listPublicEventTypes(): EventType[] {
    return this.eventTypesFrom(
      this.db
        .prepare("SELECT * FROM event_types WHERE active = 1 AND visibility = 'public' ORDER BY position, title COLLATE NOCASE")
        .all() as Row[],
    );
  }

  getEventType(id: number): EventType | null {
    const r = this.db.prepare("SELECT * FROM event_types WHERE id = ?").get(id) as Row | undefined;
    return r ? this.eventTypesFrom([r])[0]! : null;
  }

  getEventTypeBySlug(slug: string): EventType | null {
    const r = this.db.prepare("SELECT * FROM event_types WHERE slug = ?").get(slug) as Row | undefined;
    return r ? this.eventTypesFrom([r])[0]! : null;
  }

  saveEventType(id: number | null, input: EventTypeInput): number {
    const now = this.now();
    const params = {
      slug: input.slug,
      title: input.title,
      description: input.description,
      duration: input.durationMinutes,
      locationType: input.locationType,
      locationValue: input.locationValue,
      scheduleId: input.scheduleId,
      destination: input.destinationCalendarId,
      interval: input.slotIntervalMinutes,
      before: input.bufferBeforeMinutes,
      after: input.bufferAfterMinutes,
      notice: input.minNoticeMinutes,
      horizon: input.maxHorizonDays,
      dailyLimit: input.dailyLimit,
      visibility: input.visibility,
      active: input.active ? 1 : 0,
      now,
    };
    return this.immediate(() => {
      let eventTypeId = id;
      if (eventTypeId === null) {
        const position = (this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM event_types").get() as Row).p;
        eventTypeId = Number(
          this.db
            .prepare(
              `INSERT INTO event_types (slug, title, description, duration_minutes, location_type, location_value, schedule_id,
                 destination_calendar_id, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
                 max_horizon_days, daily_limit, visibility, active, position, created_at, updated_at)
               VALUES (@slug, @title, @description, @duration, @locationType, @locationValue, @scheduleId, @destination, @interval,
                 @before, @after, @notice, @horizon, @dailyLimit, @visibility, @active, @position, @now, @now)`,
            )
            .run({ ...params, position }).lastInsertRowid,
        );
      } else {
        this.db
          .prepare(
            `UPDATE event_types SET slug = @slug, title = @title, description = @description, duration_minutes = @duration,
               location_type = @locationType, location_value = @locationValue, schedule_id = @scheduleId,
               destination_calendar_id = @destination, slot_interval_minutes = @interval, buffer_before_minutes = @before,
               buffer_after_minutes = @after, min_notice_minutes = @notice, max_horizon_days = @horizon,
               daily_limit = @dailyLimit, visibility = @visibility, active = @active, updated_at = @now
             WHERE id = @id`,
          )
          .run({ ...params, id: eventTypeId });
        this.db.prepare("DELETE FROM event_type_calendars WHERE event_type_id = ?").run(eventTypeId);
      }
      const link = this.db.prepare("INSERT INTO event_type_calendars (event_type_id, calendar_id) VALUES (?, ?)");
      for (const cid of new Set(input.blockingCalendarIds)) link.run(eventTypeId, cid);
      return eventTypeId;
    });
  }

  countBookingsForEventType(id: number): number {
    return num((this.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ?").get(id) as Row).n);
  }

  deleteEventType(id: number): void {
    this.db.prepare("DELETE FROM event_types WHERE id = ?").run(id);
  }

  // Réservations

  insertPendingBooking(b: NewBooking): number {
    const now = this.now();
    return Number(
      this.db
        .prepare(
          `INSERT INTO bookings (event_type_id, calendar_id, start_at, end_at, title, location_type, location_value, invitee_name,
             invitee_email, invitee_note, invitee_time_zone, status, token_hash, external_event_id, created_at, updated_at)
           VALUES (@eventTypeId, @calendarId, @startAt, @endAt, @title, @locationType, @locationValue, @inviteeName,
             @inviteeEmail, @inviteeNote, @inviteeTimeZone, 'pending', @tokenHash, @externalEventId, @now, @now)`,
        )
        .run({ ...b, now }).lastInsertRowid,
    );
  }

  confirmBooking(id: number, meetUrl: string | null): void {
    this.db
      .prepare("UPDATE bookings SET status = 'confirmed', meet_url = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(meetUrl, this.now(), id);
  }

  deleteBooking(id: number): void {
    this.db.prepare("DELETE FROM bookings WHERE id = ?").run(id);
  }

  getBooking(id: number): Booking | null {
    const r = this.db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Row | undefined;
    return r ? toBooking(r) : null;
  }

  getBookingByTokenHash(hash: string): Booking | null {
    const r = this.db.prepare("SELECT * FROM bookings WHERE token_hash = ?").get(hash) as Row | undefined;
    return r ? toBooking(r) : null;
  }

  cancelBooking(id: number, by: "invitee" | "host", reason: string | null): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancel_reason = ?, cancelled_at = ?,
           pending_start_at = NULL, pending_end_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(by, reason, now, now, id);
  }

  setPendingReschedule(id: number, start: number, end: number): void {
    this.db
      .prepare("UPDATE bookings SET pending_start_at = ?, pending_end_at = ?, updated_at = ? WHERE id = ?")
      .run(start, end, this.now(), id);
  }

  commitReschedule(id: number): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE bookings SET start_at = pending_start_at, end_at = pending_end_at, pending_start_at = NULL,
           pending_end_at = NULL, rescheduled_at = ?, updated_at = ? WHERE id = ? AND pending_start_at IS NOT NULL`,
      )
      .run(now, now, id);
  }

  clearPendingReschedule(id: number): void {
    this.db
      .prepare("UPDATE bookings SET pending_start_at = NULL, pending_end_at = NULL, updated_at = ? WHERE id = ?")
      .run(this.now(), id);
  }

  // Réservations locales actives (confirmées, en cours de création ou de reprogrammation) sur un ensemble d'agendas,
  // avec les tampons de leur type d'événement en millisecondes.
  localBusy(calendarIds: number[], from: number, to: number, excludeBookingId: number | null): LocalBusy[] {
    if (calendarIds.length === 0) return [];
    const placeholders = calendarIds.map(() => "?").join(",");
    const exclude = excludeBookingId ?? -1;
    const rows = this.db
      .prepare(
        `SELECT b.start_at AS s, b.end_at AS e, t.buffer_before_minutes AS bb, t.buffer_after_minutes AS ba
           FROM bookings b JOIN event_types t ON t.id = b.event_type_id
           WHERE b.status IN ('pending', 'confirmed') AND b.calendar_id IN (${placeholders}) AND b.id != ?
             AND b.start_at < ? AND b.end_at > ?
         UNION ALL
         SELECT b.pending_start_at AS s, b.pending_end_at AS e, t.buffer_before_minutes AS bb, t.buffer_after_minutes AS ba
           FROM bookings b JOIN event_types t ON t.id = b.event_type_id
           WHERE b.status = 'confirmed' AND b.pending_start_at IS NOT NULL AND b.calendar_id IN (${placeholders}) AND b.id != ?
             AND b.pending_start_at < ? AND b.pending_end_at > ?`,
      )
      .all(...calendarIds, exclude, to, from, ...calendarIds, exclude, to, from) as Row[];
    return rows.map((r) => ({ start: num(r.s), end: num(r.e), before: num(r.bb) * 60_000, after: num(r.ba) * 60_000 }));
  }

  // Débuts des réservations actives des types d'événements d'un planning, pour le nombre de créneaux par plage.
  activeStartsForSchedule(scheduleId: number, from: number, to: number, excludeBookingId: number | null): number[] {
    const rows = this.db
      .prepare(
        `SELECT b.start_at AS s FROM bookings b JOIN event_types t ON t.id = b.event_type_id
           WHERE t.schedule_id = @id AND b.status IN ('pending', 'confirmed') AND b.id != @ex
             AND b.start_at >= @from AND b.start_at < @to
         UNION ALL
         SELECT b.pending_start_at AS s FROM bookings b JOIN event_types t ON t.id = b.event_type_id
           WHERE t.schedule_id = @id AND b.status = 'confirmed' AND b.id != @ex
             AND b.pending_start_at IS NOT NULL AND b.pending_start_at >= @from AND b.pending_start_at < @to`,
      )
      .all({ id: scheduleId, ex: excludeBookingId ?? -1, from, to }) as Row[];
    return rows.map((r) => num(r.s));
  }

  // Débuts des réservations actives d'un type d'événement, pour le plafond quotidien.
  activeStartsForEventType(eventTypeId: number, from: number, to: number, excludeBookingId: number | null): number[] {
    const rows = this.db
      .prepare(
        `SELECT start_at AS s FROM bookings WHERE event_type_id = @id AND status IN ('pending', 'confirmed') AND id != @ex
           AND start_at >= @from AND start_at < @to
         UNION ALL
         SELECT pending_start_at AS s FROM bookings WHERE event_type_id = @id AND status = 'confirmed' AND id != @ex
           AND pending_start_at IS NOT NULL AND pending_start_at >= @from AND pending_start_at < @to`,
      )
      .all({ id: eventTypeId, ex: excludeBookingId ?? -1, from, to }) as Row[];
    return rows.map((r) => num(r.s));
  }

  listBookings(filter: { when: "upcoming" | "past"; limit: number; offset: number }): (Booking & { eventTypeTitle: string })[] {
    const now = this.now();
    const sql =
      filter.when === "upcoming"
        ? `SELECT b.*, e.title AS event_type_title FROM bookings b JOIN event_types e ON e.id = b.event_type_id
             WHERE b.status != 'pending' AND b.end_at >= ? ORDER BY b.start_at ASC LIMIT ? OFFSET ?`
        : `SELECT b.*, e.title AS event_type_title FROM bookings b JOIN event_types e ON e.id = b.event_type_id
             WHERE b.status != 'pending' AND b.end_at < ? ORDER BY b.start_at DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(now, filter.limit, filter.offset) as Row[]).map((r) => ({
      ...toBooking(r),
      eventTypeTitle: str(r.event_type_title),
    }));
  }

  stalePendingBookings(olderThan: number): Booking[] {
    return (
      this.db.prepare("SELECT * FROM bookings WHERE status = 'pending' AND created_at < ?").all(olderThan) as Row[]
    ).map(toBooking);
  }

  stalePendingReschedules(olderThan: number): Booking[] {
    return (
      this.db
        .prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND pending_start_at IS NOT NULL AND updated_at < ?")
        .all(olderThan) as Row[]
    ).map(toBooking);
  }
}
