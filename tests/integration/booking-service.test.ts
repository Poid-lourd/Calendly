import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { AvailabilityCheckError, BookingStateError, SlotUnavailableError } from "../../src/domain/bookings.js";
import { sha256 } from "../../src/lib/crypto.js";
import { createContext, firstSlots } from "../helpers.js";

const PARIS = "Europe/Paris";
const invitee = { name: "Jeanne Dupont", email: "jeanne@exemple.fr", note: "Sujet : refonte du site", timeZone: "America/Montreal" };

describe("réservation", () => {
  it("crée l'événement dans l'agenda de destination avec l'invité, Meet et les liens de gestion", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const [start] = await firstSlots(ctx, et.slug);
    const { booking, token } = await ctx.bookings.create({ eventType: et, start: start!, ...invitee });

    expect(booking.status).toBe("confirmed");
    expect(booking.endAt - booking.startAt).toBe(30 * 60_000);
    expect(ctx.repo.getBookingByTokenHash(sha256(token))?.id).toBe(booking.id);
    expect(booking.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);

    const [event] = ctx.provider.listEvents();
    const destination = ctx.repo.getCalendar(et.destinationCalendarId)!;
    expect(event!.calendarId).toBe(destination.externalId);
    expect(event!.eventId).toBe(booking.externalEventId);
    expect(event!.attendees).toEqual([{ email: invitee.email, name: invitee.name }]);
    expect(event!.description).toContain(`http://localhost:3000/b/${token}/annuler`);
    expect(event!.description).toContain(`http://localhost:3000/b/${token}/reprogrammer`);
    expect(event!.description).toContain("Sujet : refonte du site");
    expect(event!.updatesSent).toBe(1);
  });

  it("le créneau réservé et ses tampons disparaissent des disponibilités", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const before = await firstSlots(ctx, et.slug);
    const start = before[0]!;
    await ctx.bookings.create({ eventType: et, start, ...invitee });
    const after = await firstSlots(ctx, et.slug);
    expect(after).not.toContain(start);
    // Tampon après de 10 minutes : le créneau suivant (début à la fin du premier) n'est plus libre.
    expect(after).not.toContain(start + 30 * 60_000);
  });

  it("refuse un créneau hors disponibilités", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const sunday = DateTime.fromISO("2027-01-10T10:00", { zone: PARIS }).toMillis();
    await expect(ctx.bookings.create({ eventType: et, start: sunday, ...invitee })).rejects.toBeInstanceOf(SlotUnavailableError);
    const misaligned = (await firstSlots(ctx, et.slug))[0]! + 5 * 60_000;
    await expect(ctx.bookings.create({ eventType: et, start: misaligned, ...invitee })).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(ctx.repo.listBookings({ when: "upcoming", limit: 10, offset: 0 })).toEqual([]);
  });

  it("un type inactif ne peut pas être réservé", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const [start] = await firstSlots(ctx, et.slug);
    await expect(ctx.bookings.create({ eventType: { ...et, active: false }, start: start!, ...invitee })).rejects.toBeInstanceOf(
      BookingStateError,
    );
  });

  it("respecte le plafond quotidien", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("point-projet")!;
    const slots = await firstSlots(ctx, et.slug);
    const day = DateTime.fromMillis(slots[0]!, { zone: PARIS }).toISODate();
    const sameDay = slots.filter((s) => DateTime.fromMillis(s, { zone: PARIS }).toISODate() === day);
    expect(sameDay.length).toBeGreaterThan(2);
    await ctx.bookings.create({ eventType: et, start: sameDay[0]!, ...invitee });
    const second = (await firstSlots(ctx, et.slug)).find((s) => DateTime.fromMillis(s, { zone: PARIS }).toISODate() === day)!;
    await ctx.bookings.create({ eventType: et, start: second, ...invitee, email: "b@exemple.fr" });
    const remaining = (await firstSlots(ctx, et.slug)).filter((s) => DateTime.fromMillis(s, { zone: PARIS }).toISODate() === day);
    expect(remaining).toEqual([]);
  });

  it("une réservation sur l'agenda entreprise bloque les types qui le surveillent", async () => {
    const ctx = await createContext();
    const projet = ctx.repo.getEventTypeBySlug("point-projet")!;
    const echange = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const start = (await firstSlots(ctx, projet.slug))[0]!;
    expect(await firstSlots(ctx, echange.slug)).toContain(start);
    await ctx.bookings.create({ eventType: projet, start, ...invitee });
    expect(await firstSlots(ctx, echange.slug)).not.toContain(start);
  });
});

describe("nombre de créneaux par plage", () => {
  it("propose les créneaux demandés et chaque réservation en consomme un", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const schedule = ctx.repo.getSchedule(et.scheduleId)!;
    ctx.repo.saveSchedule(schedule.id, { name: schedule.name, timeZone: PARIS, weekly: { 2: [{ start: 13 * 60, end: 15 * 60, maxSlots: 2 }] } });
    ctx.availability.invalidate();
    const tuesday = (time: string) => DateTime.fromISO(`2027-01-05T${time}`, { zone: PARIS }).toMillis();

    // Déjeuner simulé de 12:30 à 13:30 : 13:00 est occupé.
    expect(await firstSlots(ctx, et.slug, 7)).toEqual([tuesday("13:30"), tuesday("14:30")]);
    // Libre, mais au-delà des deux créneaux de la plage.
    await expect(ctx.bookings.create({ eventType: et, start: tuesday("14:00"), ...invitee })).rejects.toBeInstanceOf(SlotUnavailableError);

    await ctx.bookings.create({ eventType: et, start: tuesday("13:30"), ...invitee });
    expect(await firstSlots(ctx, et.slug, 7)).toEqual([tuesday("14:30")]);
    await ctx.bookings.create({ eventType: et, start: tuesday("14:30"), ...invitee, email: "b@exemple.fr" });
    expect(await firstSlots(ctx, et.slug, 7)).toEqual([]);
  });
});

describe("annulation", () => {
  it("annule l'événement Google avec notification et libère le créneau", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const [start] = await firstSlots(ctx, et.slug);
    const { booking } = await ctx.bookings.create({ eventType: et, start: start!, ...invitee });
    await ctx.bookings.cancel(booking, "invitee", "Empêchement");

    const after = ctx.repo.getBooking(booking.id)!;
    expect(after.status).toBe("cancelled");
    expect(after.cancelReason).toBe("Empêchement");
    expect(after.cancelledBy).toBe("invitee");
    const [event] = ctx.provider.listEvents();
    expect(event!.status).toBe("cancelled");
    expect(event!.description).toContain("Motif : Empêchement");
    expect(event!.updatesSent).toBe(2);
    expect(await firstSlots(ctx, et.slug)).toContain(start);
    await expect(ctx.bookings.cancel(after, "invitee", null)).rejects.toBeInstanceOf(BookingStateError);
  });

  it("l'invité ne peut pas annuler un rendez-vous passé", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const [start] = await firstSlots(ctx, et.slug);
    const { booking } = await ctx.bookings.create({ eventType: et, start: start!, ...invitee });
    ctx.clock.now = booking.endAt + 1;
    await expect(ctx.bookings.cancel(booking, "invitee", null)).rejects.toBeInstanceOf(BookingStateError);
    await ctx.bookings.cancel(booking, "host", null);
    expect(ctx.repo.getBooking(booking.id)!.cancelledBy).toBe("host");
  });
});

describe("reprogrammation", () => {
  it("déplace l'événement Google existant et garde le même lien", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const slots = await firstSlots(ctx, et.slug);
    const { booking, token } = await ctx.bookings.create({ eventType: et, start: slots[0]!, ...invitee });
    const target = slots[slots.length - 1]!;
    const moved = await ctx.bookings.reschedule(booking, target);

    expect(moved.startAt).toBe(target);
    expect(moved.rescheduledAt).not.toBeNull();
    expect(ctx.repo.getBookingByTokenHash(sha256(token))!.id).toBe(booking.id);
    const events = ctx.provider.listEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.start).toBe(target);
    expect(events[0]!.updatesSent).toBe(2);
    const free = await firstSlots(ctx, et.slug);
    expect(free).toContain(slots[0]);
    expect(free).not.toContain(target);
  });

  it("accepte un nouvel horaire qui chevauche l'ancien", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("point-projet")!;
    ctx.repo.saveEventType(et.id, { ...et, slotIntervalMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 });
    const updated = ctx.repo.getEventTypeBySlug("point-projet")!;
    const slots = await firstSlots(ctx, updated.slug);
    const start = slots.find((s) => slots.includes(s + 30 * 60_000))!;
    const { booking } = await ctx.bookings.create({ eventType: updated, start, ...invitee });
    const moved = await ctx.bookings.reschedule(booking, start + 30 * 60_000);
    expect(moved.startAt).toBe(start + 30 * 60_000);
  });

  it("refuse un créneau occupé", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const slots = await firstSlots(ctx, et.slug);
    const a = await ctx.bookings.create({ eventType: et, start: slots[0]!, ...invitee });
    await ctx.bookings.create({ eventType: et, start: slots[5]!, ...invitee, email: "autre@exemple.fr" });
    await expect(ctx.bookings.reschedule(a.booking, slots[5]!)).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(ctx.repo.getBooking(a.booking.id)!.startAt).toBe(slots[0]);
  });
});

describe("compte déconnecté", () => {
  it("aucun créneau n'est proposé et la réservation est refusée", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const [start] = await firstSlots(ctx, et.slug);
    const account = ctx.repo.listAccounts()[0]!;
    ctx.repo.markAccountDisconnected(account.id, "invalid_grant");
    const res = await ctx.availability.slots(et, ctx.clock.now, ctx.clock.now + 7 * 86_400_000);
    expect(res.ok).toBe(false);
    await expect(ctx.bookings.create({ eventType: et, start: start!, ...invitee })).rejects.toBeInstanceOf(AvailabilityCheckError);
  });

  it("un invalid_grant pendant le calcul déconnecte le compte", async () => {
    const ctx = await createContext();
    await ctx.accounts.connect({
      identity: { subject: "mock-revoque@exemple.test", email: "revoque@exemple.test", emailVerified: true },
      refreshToken: "mock-refresh:revoque@exemple.test",
      scopes: ctx.provider.connectScopes,
    });
    const revoked = ctx.repo.listAccounts().find((a) => a.email === "revoque@exemple.test")!;
    expect(revoked.status).toBe("disconnected");
    expect(revoked.lastError).toMatch(/invalid_grant/);
  });
});

describe("reprise après interruption", () => {
  it("confirme une réservation dont l'événement existe et supprime les autres", async () => {
    const ctx = await createContext();
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const slots = await firstSlots(ctx, et.slug);
    const dest = ctx.repo.getCalendar(et.destinationCalendarId)!;
    const base = {
      eventTypeId: et.id,
      calendarId: dest.id,
      title: et.title,
      locationType: et.locationType,
      locationValue: "",
      inviteeName: "A",
      inviteeEmail: "a@exemple.fr",
      inviteeNote: "",
      inviteeTimeZone: PARIS,
    };
    const kept = ctx.repo.insertPendingBooking({ ...base, startAt: slots[0]!, endAt: slots[0]! + 1_800_000, tokenHash: "h1", externalEventId: "evt1aaaaa" });
    const lost = ctx.repo.insertPendingBooking({ ...base, startAt: slots[3]!, endAt: slots[3]! + 1_800_000, tokenHash: "h2", externalEventId: "evt2aaaaa" });
    await ctx.provider.createEvent({ accountId: 1, refreshToken: "mock-refresh:moi@exemple.test" }, dest.externalId, {
      eventId: "evt1aaaaa",
      summary: "x",
      description: "",
      start: slots[0]!,
      end: slots[0]! + 1_800_000,
      timeZone: PARIS,
      attendee: { email: "a@exemple.fr", name: "A" },
      location: null,
      createMeet: false,
    });
    ctx.clock.now += 5 * 60_000;
    await ctx.bookings.recover();
    expect(ctx.repo.getBooking(kept)!.status).toBe("confirmed");
    expect(ctx.repo.getBooking(lost)).toBeNull();
  });
});
