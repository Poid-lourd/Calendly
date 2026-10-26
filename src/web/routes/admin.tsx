import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DateTime } from "luxon";
import type { EventTypeInput } from "../../db/repo.js";
import type { EventType, LocationType, MinuteRange } from "../../db/types.js";
import { BookingStateError } from "../../domain/bookings.js";
import { log } from "../../lib/log.js";
import { AccountUnavailableError } from "../../providers/accounts.js";
import { contrast, isHexColor } from "../color.js";
import { type Ctx, type Deps, type Env, field, fields } from "../context.js";
import { isValidZone, minutesToTime, timeToMinutes } from "../format.js";
import {
  type AdminMeta,
  BookingDetailPage,
  BookingsPage,
  CalendarsPage,
  type Errors,
  EventTypeFormPage,
  EventTypesPage,
  type EventTypeValues,
  isWritable,
  ScheduleFormPage,
  SchedulesPage,
  type ScheduleValues,
  SettingsPage,
  type SettingsValues,
  SignaturePage,
} from "../views/admin.js";
import { signatureHtml } from "../signature.js";
import { requireAdmin } from "./auth.js";
import { RESERVED_SLUGS, notFound } from "./public.js";

const FLASH: Record<string, string> = {
  enregistre: "Modifications enregistrées.",
  cree: "Élément créé.",
  supprime: "Élément supprimé.",
  annulee: "Réservation annulée. Google a prévenu l'invité.",
  connecte: "Compte connecté. Ses agendas sont listés ci-dessous.",
  "connecte-erreur": "Compte enregistré, mais son autorisation n'est pas valide.",
  actualise: "Liste des agendas actualisée.",
  retire: "Compte retiré.",
  exception: "Exception enregistrée.",
};

const CONNECT_ERRORS: Record<string, string> = {
  refus: "L'autorisation a été refusée sur l'écran de Google.",
  autorisations: "Toutes les autorisations demandées sont nécessaires. Recommencez en cochant l'accès à Google Agenda.",
  echec: "La connexion a échoué. Réessayez.",
  actualisation: "La liste des agendas n'a pas pu être lue. Le compte est peut-être déconnecté.",
};

function adminZone(deps: Deps): string {
  return deps.repo.listSchedules()[0]?.timeZone ?? "Europe/Paris";
}

function adminMeta(c: Ctx, title: string, section: AdminMeta["section"]): AdminMeta {
  const deps = c.get("deps");
  const ok = c.req.query("ok");
  return {
    title,
    assets: deps.assets,
    settings: deps.repo.getSettings(),
    csrf: c.get("csrf"),
    email: c.get("admin")!.email,
    section,
    disconnected: deps.repo.listAccounts().filter((a) => a.status !== "connected"),
    flash: ok ? FLASH[ok] : undefined,
  };
}

const idParam = (c: Ctx): number | null => {
  const v = Number(c.req.param("id"));
  return Number.isInteger(v) && v > 0 ? v : null;
};

// ===== Types d'événements : formulaire =====

function eventTypeValues(et: EventType): EventTypeValues {
  return {
    title: et.title,
    slug: et.slug,
    description: et.description,
    duration: String(et.durationMinutes),
    locationType: et.locationType,
    locationValue: et.locationValue,
    scheduleId: String(et.scheduleId),
    destinationCalendarId: String(et.destinationCalendarId),
    interval: et.slotIntervalMinutes === null ? "" : String(et.slotIntervalMinutes),
    bufferBefore: String(et.bufferBeforeMinutes),
    bufferAfter: String(et.bufferAfterMinutes),
    notice: String(et.minNoticeMinutes),
    horizon: String(et.maxHorizonDays),
    dailyLimit: et.dailyLimit === null ? "" : String(et.dailyLimit),
    visibility: et.visibility,
    active: et.active,
    blocking: et.blockingCalendarIds.map(String),
  };
}

function defaultEventTypeValues(deps: Deps): EventTypeValues {
  const accounts = new Set(deps.repo.listAccounts().filter((a) => a.status === "connected").map((a) => a.id));
  const calendars = deps.repo.listCalendars();
  const destination = calendars.find((c) => accounts.has(c.accountId) && c.isPrimary && isWritable(c)) ?? calendars.find(isWritable);
  return {
    title: "",
    slug: "",
    description: "",
    duration: "30",
    locationType: "meet",
    locationValue: "",
    scheduleId: String(deps.repo.listSchedules()[0]?.id ?? ""),
    destinationCalendarId: destination ? String(destination.id) : "",
    interval: "",
    bufferBefore: "0",
    bufferAfter: "0",
    notice: "240",
    horizon: "60",
    dailyLimit: "",
    visibility: "public",
    active: true,
    blocking: destination ? [String(destination.id)] : [],
  };
}

function readEventTypeForm(body: Record<string, unknown>): EventTypeValues {
  const lt = field(body, "locationType");
  return {
    title: field(body, "title").trim(),
    slug: field(body, "slug").trim().toLowerCase(),
    description: field(body, "description").trim(),
    duration: field(body, "duration").trim(),
    locationType: (["meet", "phone", "address", "text"].includes(lt) ? lt : "meet") as LocationType,
    locationValue: field(body, "locationValue").trim(),
    scheduleId: field(body, "scheduleId"),
    destinationCalendarId: field(body, "destinationCalendarId"),
    interval: field(body, "interval").trim(),
    bufferBefore: field(body, "bufferBefore").trim(),
    bufferAfter: field(body, "bufferAfter").trim(),
    notice: field(body, "notice").trim(),
    horizon: field(body, "horizon").trim(),
    dailyLimit: field(body, "dailyLimit").trim(),
    visibility: field(body, "visibility") === "unlisted" ? "unlisted" : "public",
    active: field(body, "active") === "1",
    blocking: fields(body, "blocking"),
  };
}

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

function validateEventType(deps: Deps, v: EventTypeValues, id: number | null): { input: EventTypeInput | null; errors: Errors<EventTypeValues> } {
  const errors: Errors<EventTypeValues> = {};
  if (!v.title) errors.title = "Indiquez un titre.";
  else if (v.title.length > 120) errors.title = "120 caractères au maximum.";

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug) || v.slug.length > 60) errors.slug = "Lettres minuscules, chiffres et tirets uniquement, 60 caractères au maximum.";
  else if (RESERVED_SLUGS.has(v.slug)) errors.slug = "Cette adresse est réservée.";
  else {
    const existing = deps.repo.getEventTypeBySlug(v.slug);
    if (existing && existing.id !== id) errors.slug = "Cette adresse est déjà utilisée.";
  }
  if (v.description.length > 2000) errors.description = "2000 caractères au maximum.";

  const durationMinutes = intIn(v.duration, 5, 720);
  if (durationMinutes === null) errors.duration = "Entre 5 et 720 minutes.";

  if (v.locationType !== "meet" && !v.locationValue) {
    errors.locationValue = v.locationType === "phone" ? "Indiquez le numéro." : v.locationType === "address" ? "Indiquez l'adresse." : "Indiquez le lieu.";
  } else if (v.locationValue.length > 300) errors.locationValue = "300 caractères au maximum.";

  const scheduleId = Number(v.scheduleId);
  if (!deps.repo.getSchedule(scheduleId)) errors.scheduleId = "Choisissez un planning.";

  const destination = deps.repo.getCalendar(Number(v.destinationCalendarId));
  if (!destination || !isWritable(destination)) errors.destinationCalendarId = "Choisissez un agenda modifiable.";

  const interval = v.interval === "" ? null : intIn(v.interval, 5, 720);
  if (v.interval !== "" && interval === null) errors.interval = "Valeur invalide.";
  const before = intIn(v.bufferBefore, 0, 720);
  if (before === null) errors.bufferBefore = "Valeur invalide.";
  const after = intIn(v.bufferAfter, 0, 720);
  if (after === null) errors.bufferAfter = "Valeur invalide.";
  const notice = intIn(v.notice, 0, 60 * 24 * 60);
  if (notice === null) errors.notice = "Valeur invalide.";
  const horizon = intIn(v.horizon, 1, 730);
  if (horizon === null) errors.horizon = "Entre 1 et 730 jours.";
  const dailyLimit = v.dailyLimit === "" ? null : intIn(v.dailyLimit, 1, 100);
  if (v.dailyLimit !== "" && dailyLimit === null) errors.dailyLimit = "Entre 1 et 100, ou vide.";

  const blocking = v.blocking.map(Number);
  if (blocking.some((cid) => !deps.repo.getCalendar(cid))) errors.blocking = "Agenda inconnu.";

  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    errors,
    input: {
      slug: v.slug,
      title: v.title,
      description: v.description,
      durationMinutes: durationMinutes!,
      locationType: v.locationType,
      locationValue: v.locationType === "meet" ? "" : v.locationValue,
      scheduleId,
      destinationCalendarId: destination!.id,
      slotIntervalMinutes: interval,
      bufferBeforeMinutes: before!,
      bufferAfterMinutes: after!,
      minNoticeMinutes: notice!,
      maxHorizonDays: horizon!,
      dailyLimit,
      visibility: v.visibility,
      active: v.active,
      blockingCalendarIds: blocking,
    },
  };
}

// ===== Plannings : formulaire =====

function parseRanges(starts: string[], ends: string[]): { ranges: MinuteRange[]; raw: { start: string; end: string }[]; error: string | null } {
  const raw: { start: string; end: string }[] = [];
  const ranges: MinuteRange[] = [];
  let error: string | null = null;
  const n = Math.max(starts.length, ends.length);
  for (let i = 0; i < n; i++) {
    const s = (starts[i] ?? "").trim();
    const e = (ends[i] ?? "").trim();
    if (!s && !e) continue;
    raw.push({ start: s, end: e });
    const start = timeToMinutes(s);
    let end = timeToMinutes(e);
    if (end === 0) end = 1440;
    if (start === null || end === null) {
      error = "Horaire invalide, format HH:MM attendu.";
      continue;
    }
    if (end <= start) {
      error = "La fin d'une plage doit suivre son début.";
      continue;
    }
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.start < ranges[i - 1]!.end) error ??= "Des plages se chevauchent.";
  }
  return { ranges, raw, error };
}

function scheduleValuesFrom(deps: Deps, id: number): ScheduleValues | null {
  const s = deps.repo.getSchedule(id);
  if (!s) return null;
  const weekly: ScheduleValues["weekly"] = {};
  for (let d = 1; d <= 7; d++) {
    weekly[d] = (s.weekly[d] ?? []).map((r) => ({ start: minutesToTime(r.start), end: r.end === 1440 ? "00:00" : minutesToTime(r.end) }));
  }
  return { name: s.name, timeZone: s.timeZone, weekly };
}

function upcomingOverrides(deps: Deps, id: number): { date: string; ranges: MinuteRange[] }[] {
  const s = deps.repo.getSchedule(id);
  if (!s) return [];
  const today = DateTime.fromMillis(deps.now(), { zone: s.timeZone }).toISODate()!;
  return Object.entries(s.overrides)
    .filter(([date]) => date >= today)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, ranges]) => ({ date, ranges }));
}

function renderSchedule(c: Ctx, id: number | null, values: ScheduleValues, errors: Errors<ScheduleValues> & { days?: Record<number, string> }, extra: { overrideError?: string; overrideValues?: { date: string; mode: string } } = {}, status: 200 | 400 = 200) {
  const deps = c.get("deps");
  return c.html(
    <ScheduleFormPage
      meta={adminMeta(c, id === null ? "Nouveau planning" : values.name, "disponibilites")}
      id={id}
      values={values}
      errors={errors}
      overrides={id === null ? [] : upcomingOverrides(deps, id)}
      overrideError={extra.overrideError}
      overrideValues={extra.overrideValues}
      usage={id === null ? [] : deps.repo.eventTypesUsingSchedule(id)}
    />,
    status,
  );
}

// ===== Réglages : image =====

const MAX_AVATAR = 1024 * 1024;

function imageType(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function adminRoutes(app: Hono<Env>): void {
  const admin = new Hono<Env>();
  admin.use("*", requireAdmin);

  admin.get("/", (c) => c.redirect("/admin/reservations", 302));

  // Réservations
  admin.get("/reservations", (c) => {
    const deps = c.get("deps");
    const when = c.req.query("vue") === "passees" ? "past" : "upcoming";
    const page = Math.max(1, Math.min(1000, Number(c.req.query("page")) || 1));
    const perPage = 50;
    const list = deps.repo.listBookings({ when, limit: perPage + 1, offset: (page - 1) * perPage });
    const zones = new Map<number, string>();
    const zoneOf = (eventTypeId: number) => {
      if (!zones.has(eventTypeId)) {
        const et = deps.repo.getEventType(eventTypeId);
        zones.set(eventTypeId, (et && deps.repo.getSchedule(et.scheduleId)?.timeZone) ?? adminZone(deps));
      }
      return zones.get(eventTypeId)!;
    };
    const rows = list.slice(0, perPage).map((b) => ({ ...b, zone: zoneOf(b.eventTypeId) }));
    const showZone = new Set(deps.repo.listSchedules().map((s) => s.timeZone)).size > 1;
    return c.html(<BookingsPage meta={adminMeta(c, "Réservations", "reservations")} when={when} rows={rows} page={page} hasMore={list.length > perPage} showZone={showZone} />);
  });

  const bookingDetail = (c: Ctx, id: number, error?: string) => {
    const deps = c.get("deps");
    const booking = deps.repo.getBooking(id);
    if (!booking || booking.status === "pending") return notFound(c);
    const et = deps.repo.getEventType(booking.eventTypeId);
    const zone = (et && deps.repo.getSchedule(et.scheduleId)?.timeZone) ?? adminZone(deps);
    return c.html(
      <BookingDetailPage
        meta={adminMeta(c, booking.inviteeName, "reservations")}
        booking={booking}
        eventTypeTitle={et?.title ?? booking.title}
        zone={zone}
        calendar={booking.calendarId === null ? null : deps.repo.getCalendar(booking.calendarId)}
        now={deps.now()}
        error={error}
      />,
      error ? 503 : 200,
    );
  };

  admin.get("/reservations/:id", (c) => {
    const id = idParam(c);
    return id === null ? notFound(c) : bookingDetail(c, id);
  });

  admin.post("/reservations/:id/annuler", async (c) => {
    const id = idParam(c);
    const deps = c.get("deps");
    const booking = id === null ? null : deps.repo.getBooking(id);
    if (!booking) return notFound(c);
    const body = await c.req.parseBody({ all: true });
    const reason = field(body, "motif").trim().slice(0, 500);
    try {
      await deps.bookings.cancel(booking, "host", reason || null);
    } catch (err) {
      if (err instanceof BookingStateError) return c.redirect(`/admin/reservations/${booking.id}`, 303);
      const message =
        err instanceof AccountUnavailableError
          ? `${err.message}. Reconnectez-le depuis la page Agendas puis recommencez.`
          : "Google Agenda n'a pas confirmé l'annulation. Réessayez dans quelques minutes.";
      return bookingDetail(c, booking.id, message);
    }
    return c.redirect(`/admin/reservations/${booking.id}?ok=annulee`, 303);
  });

  // Types d'événements
  admin.get("/types", (c) => {
    const deps = c.get("deps");
    const schedules = new Map(deps.repo.listSchedules().map((s) => [s.id, s.name]));
    const items = deps.repo.listEventTypes().map((et) => ({ ...et, scheduleName: schedules.get(et.scheduleId) ?? "" }));
    return c.html(
      <EventTypesPage
        meta={adminMeta(c, "Types d'événements", "types")}
        items={items}
        hasCalendars={deps.repo.listCalendars().some(isWritable)}
        hasSchedules={schedules.size > 0}
        baseUrl={deps.config.baseUrl.toString()}
      />,
    );
  });

  const renderEventType = (c: Ctx, id: number | null, values: EventTypeValues, errors: Errors<EventTypeValues>, status: 200 | 400 = 200) => {
    const deps = c.get("deps");
    return c.html(
      <EventTypeFormPage
        meta={adminMeta(c, id === null ? "Nouveau type" : values.title, "types")}
        id={id}
        values={values}
        errors={errors}
        schedules={deps.repo.listSchedules()}
        accounts={deps.repo.listAccounts()}
        calendars={deps.repo.listCalendars()}
        baseUrl={deps.config.baseUrl.toString()}
        bookingCount={id === null ? 0 : deps.repo.countBookingsForEventType(id)}
      />,
      status,
    );
  };

  admin.get("/types/nouveau", (c) => {
    const deps = c.get("deps");
    if (deps.repo.listSchedules().length === 0 || !deps.repo.listCalendars().some(isWritable)) return c.redirect("/admin/types", 302);
    return renderEventType(c, null, defaultEventTypeValues(deps), {});
  });

  admin.post("/types", async (c) => {
    const deps = c.get("deps");
    const values = readEventTypeForm(await c.req.parseBody({ all: true }));
    const { input, errors } = validateEventType(deps, values, null);
    if (!input) return renderEventType(c, null, values, errors, 400);
    const id = deps.repo.saveEventType(null, input);
    deps.availability.invalidate();
    return c.redirect(`/admin/types/${id}?ok=cree`, 303);
  });

  admin.get("/types/:id", (c) => {
    const id = idParam(c);
    const et = id === null ? null : c.get("deps").repo.getEventType(id);
    if (!et) return notFound(c);
    return renderEventType(c, et.id, eventTypeValues(et), {});
  });

  admin.post("/types/:id", async (c) => {
    const deps = c.get("deps");
    const id = idParam(c);
    const et = id === null ? null : deps.repo.getEventType(id);
    if (!et) return notFound(c);
    const values = readEventTypeForm(await c.req.parseBody({ all: true }));
    const { input, errors } = validateEventType(deps, values, et.id);
    if (!input) return renderEventType(c, et.id, values, errors, 400);
    deps.repo.saveEventType(et.id, input);
    deps.availability.invalidate();
    return c.redirect(`/admin/types/${et.id}?ok=enregistre`, 303);
  });

  admin.post("/types/:id/supprimer", (c) => {
    const deps = c.get("deps");
    const id = idParam(c);
    const et = id === null ? null : deps.repo.getEventType(id);
    if (!et) return notFound(c);
    if (deps.repo.countBookingsForEventType(et.id) > 0) return c.redirect(`/admin/types/${et.id}`, 303);
    deps.repo.deleteEventType(et.id);
    return c.redirect("/admin/types?ok=supprime", 303);
  });

  // Plannings
  admin.get("/disponibilites", (c) => {
    const deps = c.get("deps");
    const items = deps.repo.listSchedules().map((schedule) => ({
      schedule,
      weekly: deps.repo.getSchedule(schedule.id)!.weekly,
      usage: deps.repo.eventTypesUsingSchedule(schedule.id).length,
    }));
    return c.html(<SchedulesPage meta={adminMeta(c, "Disponibilités", "disponibilites")} items={items} />);
  });

  admin.get("/disponibilites/nouveau", (c) => {
    const nine = [
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ];
    return renderSchedule(c, null, {
      name: "",
      timeZone: adminZone(c.get("deps")),
      weekly: { 1: nine, 2: nine, 3: nine, 4: nine, 5: nine, 6: [], 7: [] },
    }, {});
  });

  const saveSchedule = async (c: Ctx, id: number | null) => {
    const deps = c.get("deps");
    const body = await c.req.parseBody({ all: true });
    const values: ScheduleValues = { name: field(body, "name").trim(), timeZone: field(body, "timeZone"), weekly: {} };
    const errors: Errors<ScheduleValues> & { days?: Record<number, string> } = {};
    const weekly: Record<number, MinuteRange[]> = {};
    const dayErrors: Record<number, string> = {};
    for (let d = 1; d <= 7; d++) {
      const parsed = parseRanges(fields(body, `j${d}_debut`), fields(body, `j${d}_fin`));
      values.weekly[d] = parsed.raw;
      weekly[d] = parsed.ranges;
      if (parsed.error) dayErrors[d] = parsed.error;
    }
    if (!values.name) errors.name = "Indiquez un nom.";
    else if (values.name.length > 80) errors.name = "80 caractères au maximum.";
    if (!isValidZone(values.timeZone)) errors.timeZone = "Fuseau inconnu.";
    if (Object.keys(dayErrors).length > 0) errors.days = dayErrors;
    if (errors.name || errors.timeZone || errors.days) return renderSchedule(c, id, values, errors, {}, 400);
    const savedId = deps.repo.saveSchedule(id, { name: values.name, timeZone: values.timeZone, weekly });
    deps.availability.invalidate();
    return c.redirect(`/admin/disponibilites/${savedId}?ok=${id === null ? "cree" : "enregistre"}`, 303);
  };

  admin.post("/disponibilites", (c) => saveSchedule(c, null));

  admin.get("/disponibilites/:id", (c) => {
    const id = idParam(c);
    const values = id === null ? null : scheduleValuesFrom(c.get("deps"), id);
    if (!values || id === null) return notFound(c);
    return renderSchedule(c, id, values, {});
  });

  admin.post("/disponibilites/:id", (c) => {
    const id = idParam(c);
    if (id === null || !c.get("deps").repo.getSchedule(id)) return notFound(c);
    return saveSchedule(c, id);
  });

  admin.post("/disponibilites/:id/exceptions", async (c) => {
    const deps = c.get("deps");
    const id = idParam(c);
    const values = id === null ? null : scheduleValuesFrom(deps, id);
    if (!values || id === null) return notFound(c);
    const body = await c.req.parseBody({ all: true });
    const date = field(body, "date");
    const mode = field(body, "mode") === "hours" ? "hours" : "off";
    const parsedDate = DateTime.fromISO(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parsedDate.isValid) {
      return renderSchedule(c, id, values, {}, { overrideError: "Indiquez une date valide.", overrideValues: { date, mode } }, 400);
    }
    let ranges: MinuteRange[] = [];
    if (mode === "hours") {
      const parsed = parseRanges(fields(body, "exc_debut"), fields(body, "exc_fin"));
      if (parsed.error || parsed.ranges.length === 0) {
        return renderSchedule(c, id, values, {}, { overrideError: parsed.error ?? "Ajoutez au moins une plage.", overrideValues: { date, mode } }, 400);
      }
      ranges = parsed.ranges;
    }
    deps.repo.setOverride(id, date, ranges);
    deps.availability.invalidate();
    return c.redirect(`/admin/disponibilites/${id}?ok=exception`, 303);
  });

  admin.post("/disponibilites/:id/exceptions/:date/supprimer", (c) => {
    const deps = c.get("deps");
    const id = idParam(c);
    const date = c.req.param("date") ?? "";
    if (id === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return notFound(c);
    deps.repo.deleteOverride(id, date);
    deps.availability.invalidate();
    return c.redirect(`/admin/disponibilites/${id}?ok=supprime`, 303);
  });

  admin.post("/disponibilites/:id/supprimer", (c) => {
    const deps = c.get("deps");
    const id = idParam(c);
    if (id === null || !deps.repo.getSchedule(id)) return notFound(c);
    if (deps.repo.eventTypesUsingSchedule(id).length > 0) return c.redirect(`/admin/disponibilites/${id}`, 303);
    deps.repo.deleteSchedule(id);
    return c.redirect("/admin/disponibilites?ok=supprime", 303);
  });

  // Agendas
  admin.get("/agendas", (c) => {
    const deps = c.get("deps");
    const accounts = deps.repo.listAccounts();
    const usage = new Map(accounts.map((a) => [a.id, deps.repo.eventTypesUsingAccount(a.id)]));
    const code = c.req.query("erreur");
    return c.html(
      <CalendarsPage
        meta={adminMeta(c, "Agendas", "agendas")}
        accounts={accounts}
        calendars={deps.repo.listCalendars()}
        usage={usage}
        error={code ? CONNECT_ERRORS[code] : undefined}
        zone={adminZone(deps)}
      />,
    );
  });

  admin.post("/agendas/:id/actualiser", async (c) => {
    const deps = c.get("deps");
    const id = idParam(c);
    if (id === null || !deps.repo.getAccount(id)) return notFound(c);
    try {
      await deps.accounts.sync(id);
    } catch (err) {
      log.warn("actualisation des agendas impossible", { accountId: id, err });
      return c.redirect("/admin/agendas?erreur=actualisation", 303);
    }
    deps.availability.invalidate();
    return c.redirect("/admin/agendas?ok=actualise", 303);
  });

  admin.post("/agendas/:id/retirer", async (c) => {
    const deps = c.get("deps");
    const id = idParam(c);
    if (id === null || !deps.repo.getAccount(id)) return notFound(c);
    if (deps.repo.eventTypesUsingAccount(id).length > 0) return c.redirect("/admin/agendas", 303);
    await deps.accounts.remove(id);
    deps.availability.invalidate();
    return c.redirect("/admin/agendas?ok=retire", 303);
  });

  // Signature de mail
  const renderSignature = (c: Ctx, form?: { eventTypeId: string; maxSlots: string; error: string }) => {
    const deps = c.get("deps");
    const settings = deps.repo.getSettings();
    const eventTypes = deps.repo.listEventTypes().filter((et) => et.active);
    const configured = eventTypes.find((et) => et.id === settings.signatureEventTypeId) ?? null;
    return c.html(
      <SignaturePage
        meta={adminMeta(c, "Signature de mail", "signature")}
        eventTypes={eventTypes}
        eventTypeId={form?.eventTypeId ?? String(configured?.id ?? eventTypes[0]?.id ?? "")}
        maxSlots={form?.maxSlots ?? String(settings.signatureMaxSlots)}
        error={form?.error}
        html={configured ? signatureHtml({ baseUrl: deps.config.baseUrl, slug: configured.slug, accent: settings.accentColor }) : null}
      />,
      form ? 400 : 200,
    );
  };

  admin.get("/signature", (c) => renderSignature(c));

  admin.post("/signature", async (c) => {
    const deps = c.get("deps");
    const body = await c.req.parseBody({ all: true });
    const eventTypeId = field(body, "eventTypeId");
    const maxSlots = field(body, "maxSlots");
    const et = deps.repo.getEventType(Number(eventTypeId));
    const max = intIn(maxSlots, 1, 4);
    if (!et || !et.active || max === null) {
      return renderSignature(c, { eventTypeId, maxSlots, error: "Choisissez un type d'événement actif et un nombre de créneaux entre 1 et 4." });
    }
    deps.repo.updateSignature({ eventTypeId: et.id, maxSlots: max });
    return c.redirect("/admin/signature?ok=enregistre", 303);
  });

  // Aperçu isolé dans un cadre : le bloc utilise des styles en ligne, interdits par la politique des pages de l'admin.
  admin.get("/signature/apercu", (c) => {
    const deps = c.get("deps");
    const settings = deps.repo.getSettings();
    const et = settings.signatureEventTypeId === null ? null : deps.repo.getEventType(settings.signatureEventTypeId);
    if (!et) return c.body(null, 404);
    const name = settings.displayName.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    c.header("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'self'; frame-ancestors 'self'");
    c.header("X-Frame-Options", "SAMEORIGIN");
    return c.html(
      `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><base target="_blank"><title>Aperçu</title></head>` +
        `<body style="margin:16px;background:#ffffff;color:#171716;font-family:'IBM Plex Sans',-apple-system,'Segoe UI',Helvetica,sans-serif;font-size:14px;">` +
        (name ? `<p style="margin:0;">${name}</p>` : "") +
        signatureHtml({ baseUrl: deps.config.baseUrl, slug: et.slug, accent: settings.accentColor }) +
        `</body></html>`,
    );
  });

  // Réglages
  const renderSettings = (c: Ctx, values: SettingsValues, errors: Errors<SettingsValues> & { avatar?: string }, status: 200 | 400 = 200) =>
    c.html(<SettingsPage meta={adminMeta(c, "Réglages", "reglages")} values={values} errors={errors} />, status);

  admin.get("/reglages", (c) => {
    const s = c.get("deps").repo.getSettings();
    return renderSettings(c, { displayName: s.displayName, accentColor: s.accentColor }, {});
  });

  admin.post(
    "/reglages",
    bodyLimit({ maxSize: 2 * MAX_AVATAR, onError: (c) => c.text("Fichier trop volumineux", 413) }),
    async (c) => {
      const deps = c.get("deps");
      const body = await c.req.parseBody({ all: true });
      const values: SettingsValues = { displayName: field(body, "displayName").trim(), accentColor: field(body, "accentColor").trim().toLowerCase() };
      const errors: Errors<SettingsValues> & { avatar?: string } = {};
      if (values.displayName.length > 80) errors.displayName = "80 caractères au maximum.";
      if (!isHexColor(values.accentColor)) errors.accentColor = "Format attendu : #RRGGBB.";
      else {
        const ratio = contrast(values.accentColor, "#ffffff");
        if (ratio < 4.5) errors.accentColor = `Contraste insuffisant avec le blanc (${ratio.toFixed(1).replace(".", ",")}:1). Choisissez une teinte plus foncée.`;
      }
      const file = body.avatar;
      let avatar: { data: Buffer; type: string } | null = null;
      if (file instanceof File && file.size > 0) {
        if (file.size > MAX_AVATAR) errors.avatar = "1 Mo au maximum.";
        else {
          const data = Buffer.from(await file.arrayBuffer());
          const type = imageType(data);
          if (!type) errors.avatar = "Format non reconnu. PNG, JPEG ou WebP.";
          else avatar = { data, type };
        }
      }
      if (Object.keys(errors).length > 0) return renderSettings(c, values, errors, 400);
      deps.repo.updateSettings(values);
      if (avatar) deps.repo.setAvatar(avatar.data, avatar.type);
      else if (field(body, "removeAvatar") === "1") deps.repo.setAvatar(null, null);
      return c.redirect("/admin/reglages?ok=enregistre", 303);
    },
  );

  app.route("/admin", admin);
}
