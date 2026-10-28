import { DateTime } from "luxon";
import type { Repo } from "../db/repo.js";
import type { Booking, EventType, LocationType } from "../db/types.js";
import { calendarEventId, randomToken, sha256 } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { AccountUnavailableError, type Accounts } from "../providers/accounts.js";
import type { Availability } from "./availability.js";
import { calendarsFor } from "./availability.js";
import { conflicts, rangeBounds, rangesForDate } from "./slots.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Le créneau demandé n'est pas (ou plus) disponible.
export class SlotUnavailableError extends Error {
  constructor() {
    super("Ce créneau n'est plus disponible.");
    this.name = "SlotUnavailableError";
  }
}

// L'opération n'est pas possible dans l'état actuel de la réservation ou du type d'événement.
export class BookingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingStateError";
  }
}

// Les disponibilités n'ont pas pu être vérifiées auprès de l'agenda.
export class AvailabilityCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvailabilityCheckError";
  }
}

export interface NewBookingInput {
  eventType: EventType;
  start: number;
  name: string;
  email: string;
  note: string;
  timeZone: string;
}

export function locationText(type: LocationType, value: string): string | null {
  switch (type) {
    case "meet":
      return null;
    case "phone":
      return `Téléphone : ${value}`;
    case "address":
    case "text":
      return value || null;
  }
}

export class Bookings {
  constructor(
    private readonly repo: Repo,
    private readonly accounts: Accounts,
    private readonly availability: Availability,
    private readonly baseUrl: URL,
    private readonly now: () => number = Date.now,
  ) {}

  manageUrl(token: string, action?: "annuler" | "reprogrammer"): string {
    return new URL(`/b/${token}${action ? `/${action}` : ""}`, this.baseUrl).toString();
  }

  private ensureSlot(slots: number[], start: number): void {
    if (!slots.includes(start)) throw new SlotUnavailableError();
  }

  private conflictWindow(et: EventType, start: number): { end: number } {
    return { end: start + et.durationMinutes * MINUTE };
  }

  // Revérifie, dans la transaction, qu'aucune réservation locale ne chevauche le créneau
  // et que ni le plafond quotidien ni le nombre de créneaux de la plage ne sont atteints.
  private assertNoLocalConflict(et: EventType, calendarIds: number[], start: number, excludeId: number | null): void {
    const { end } = this.conflictWindow(et, start);
    const candidate = { start, end, before: et.bufferBeforeMinutes * MINUTE, after: et.bufferAfterMinutes * MINUTE };
    const nearby = this.repo.localBusy(calendarIds, start - DAY, end + DAY, excludeId);
    if (nearby.some((existing) => conflicts(candidate, existing))) throw new SlotUnavailableError();
    const schedule = this.repo.getSchedule(et.scheduleId);
    if (!schedule) throw new BookingStateError("Planning introuvable.");
    const day = DateTime.fromMillis(start, { zone: schedule.timeZone }).startOf("day");
    if (et.dailyLimit !== null) {
      const count = this.repo.activeStartsForEventType(et.id, day.toMillis(), day.plus({ days: 1 }).toMillis(), excludeId).length;
      if (count >= et.dailyLimit) throw new SlotUnavailableError();
    }
    for (const range of rangesForDate(schedule.weekly, schedule.overrides, day)) {
      if (range.maxSlots === undefined) continue;
      const bounds = rangeBounds(day, range);
      if (start < bounds.start || start >= bounds.end) continue;
      const count = this.repo.activeStartsForSchedule(schedule.id, bounds.start, bounds.end, excludeId).length;
      if (count >= range.maxSlots) throw new SlotUnavailableError();
    }
  }

  private async checkAvailability(et: EventType, start: number, exclude?: Booking): Promise<void> {
    const result = await this.availability.slots(et, start, start + 1, { fresh: true, ...(exclude ? { exclude } : {}) });
    if (!result.ok) throw new AvailabilityCheckError(result.message);
    this.ensureSlot(result.slots, start);
  }

  private description(et: EventType, input: { name: string; email: string; note: string }, token: string): string {
    const lines: string[] = [];
    if (et.description.trim()) lines.push(et.description.trim(), "");
    lines.push(`Réservé par ${input.name} (${input.email})`);
    if (input.note.trim()) lines.push("", `Note : ${input.note.trim()}`);
    lines.push("", `Reprogrammer : ${this.manageUrl(token, "reprogrammer")}`, `Annuler : ${this.manageUrl(token, "annuler")}`);
    return lines.join("\n");
  }

  async create(input: NewBookingInput): Promise<{ booking: Booking; token: string }> {
    const et = input.eventType;
    if (!et.active) throw new BookingStateError("Ce type de rendez-vous n'est plus proposé.");
    const calendars = calendarsFor(this.repo, et);
    const destination = this.repo.getCalendar(et.destinationCalendarId);
    const schedule = this.repo.getSchedule(et.scheduleId);
    if (!calendars || !destination || !schedule) throw new BookingStateError("Type d'événement incomplet.");

    await this.checkAvailability(et, input.start);

    const token = randomToken();
    const eventId = calendarEventId();
    const { end } = this.conflictWindow(et, input.start);
    const calendarIds = calendars.map((c) => c.id);
    const bookingId = this.repo.immediate(() => {
      this.assertNoLocalConflict(et, calendarIds, input.start, null);
      return this.repo.insertPendingBooking({
        eventTypeId: et.id,
        calendarId: destination.id,
        startAt: input.start,
        endAt: end,
        title: et.title,
        locationType: et.locationType,
        locationValue: et.locationValue,
        inviteeName: input.name,
        inviteeEmail: input.email,
        inviteeNote: input.note,
        inviteeTimeZone: input.timeZone,
        tokenHash: sha256(token),
        externalEventId: eventId,
      });
    });
    this.availability.invalidate();

    const host = this.repo.getUser(et.userId)?.displayName.trim() ?? "";
    try {
      const created = await this.accounts.with(destination.accountId, (creds) =>
        this.accounts.provider.createEvent(creds, destination.externalId, {
          eventId,
          summary: host ? `${et.title} – ${host} et ${input.name}` : `${et.title} – ${input.name}`,
          description: this.description(et, input, token),
          start: input.start,
          end,
          timeZone: schedule.timeZone,
          attendee: { email: input.email, name: input.name },
          location: locationText(et.locationType, et.locationValue),
          createMeet: et.locationType === "meet",
        }),
      );
      this.repo.confirmBooking(bookingId, created.meetUrl);
    } catch (err) {
      this.repo.deleteBooking(bookingId);
      this.availability.invalidate();
      log.error("création de l'événement impossible", { eventTypeId: et.id, err });
      throw err instanceof AccountUnavailableError ? new AvailabilityCheckError(err.message) : err;
    }
    this.availability.invalidate();
    log.info("réservation créée", { bookingId, eventTypeId: et.id });
    return { booking: this.repo.getBooking(bookingId)!, token };
  }

  async cancel(booking: Booking, by: "invitee" | "host", reason: string | null): Promise<void> {
    if (booking.status !== "confirmed") throw new BookingStateError("Cette réservation est déjà annulée.");
    if (by === "invitee" && booking.endAt <= this.now()) throw new BookingStateError("Ce rendez-vous est passé.");
    const calendar = booking.calendarId === null ? null : this.repo.getCalendar(booking.calendarId);
    if (calendar) {
      const who = by === "invitee" ? "l'invité" : "l'organisateur";
      const description = [`Rendez-vous annulé par ${who}.`, reason ? `Motif : ${reason}` : null].filter(Boolean).join("\n");
      await this.accounts.with(calendar.accountId, (creds) =>
        this.accounts.provider.cancelEvent(creds, calendar.externalId, booking.externalEventId, { description }),
      );
    }
    this.repo.cancelBooking(booking.id, by, reason);
    this.availability.invalidate();
    log.info("réservation annulée", { bookingId: booking.id, by });
  }

  async reschedule(booking: Booking, start: number): Promise<Booking> {
    if (booking.status !== "confirmed") throw new BookingStateError("Cette réservation est annulée.");
    if (booking.endAt <= this.now()) throw new BookingStateError("Ce rendez-vous est passé.");
    if (booking.pendingStartAt !== null) throw new BookingStateError("Une modification est déjà en cours.");
    const et = this.repo.getEventType(booking.eventTypeId);
    if (!et || !et.active) throw new BookingStateError("Ce type de rendez-vous n'est plus proposé.");
    const calendar = booking.calendarId === null ? null : this.repo.getCalendar(booking.calendarId);
    const calendars = calendarsFor(this.repo, et);
    const schedule = this.repo.getSchedule(et.scheduleId);
    if (!calendar || !calendars || !schedule) throw new BookingStateError("L'agenda de cette réservation n'est plus connecté.");
    if (start === booking.startAt) throw new BookingStateError("Choisissez un horaire différent de l'actuel.");

    await this.checkAvailability(et, start, booking);

    const { end } = this.conflictWindow(et, start);
    const calendarIds = [...new Set([...calendars.map((c) => c.id), calendar.id])];
    this.repo.immediate(() => {
      const current = this.repo.getBooking(booking.id);
      if (!current || current.status !== "confirmed" || current.pendingStartAt !== null) {
        throw new BookingStateError("Une modification est déjà en cours.");
      }
      this.assertNoLocalConflict(et, calendarIds, start, booking.id);
      this.repo.setPendingReschedule(booking.id, start, end);
    });
    this.availability.invalidate();

    try {
      await this.accounts.with(calendar.accountId, (creds) =>
        this.accounts.provider.rescheduleEvent(creds, calendar.externalId, booking.externalEventId, {
          start,
          end,
          timeZone: schedule.timeZone,
        }),
      );
    } catch (err) {
      this.repo.clearPendingReschedule(booking.id);
      this.availability.invalidate();
      log.error("reprogrammation impossible", { bookingId: booking.id, err });
      throw err instanceof AccountUnavailableError ? new AvailabilityCheckError(err.message) : err;
    }
    this.repo.commitReschedule(booking.id);
    this.availability.invalidate();
    log.info("réservation reprogrammée", { bookingId: booking.id });
    return this.repo.getBooking(booking.id)!;
  }

  // Réconcilie les opérations interrompues (arrêt du processus pendant l'appel à Google).
  async recover(): Promise<void> {
    const threshold = this.now() - 2 * MINUTE;
    for (const b of this.repo.stalePendingBookings(threshold)) {
      const cal = b.calendarId === null ? null : this.repo.getCalendar(b.calendarId);
      try {
        const event = cal
          ? await this.accounts.with(cal.accountId, (c) => this.accounts.provider.getEvent(c, cal.externalId, b.externalEventId))
          : null;
        if (event) this.repo.confirmBooking(b.id, null);
        else this.repo.deleteBooking(b.id);
        log.info("réservation interrompue réconciliée", { bookingId: b.id, kept: Boolean(event) });
      } catch (err) {
        log.warn("réconciliation impossible, nouvel essai au prochain démarrage", { bookingId: b.id, err });
      }
    }
    for (const b of this.repo.stalePendingReschedules(threshold)) {
      const cal = b.calendarId === null ? null : this.repo.getCalendar(b.calendarId);
      try {
        const event = cal
          ? await this.accounts.with(cal.accountId, (c) => this.accounts.provider.getEvent(c, cal.externalId, b.externalEventId))
          : null;
        if (event && event.start === b.pendingStartAt) this.repo.commitReschedule(b.id);
        else this.repo.clearPendingReschedule(b.id);
      } catch (err) {
        log.warn("réconciliation impossible, nouvel essai au prochain démarrage", { bookingId: b.id, err });
      }
    }
  }
}
