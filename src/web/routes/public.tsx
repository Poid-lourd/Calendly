import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Booking, EventType, User } from "../../db/types.js";
import { AvailabilityCheckError, BookingStateError, SlotUnavailableError } from "../../domain/bookings.js";
import { selectSignatureSlots } from "../../domain/signature.js";
import { groupByLocalDate } from "../../domain/slots.js";
import { sha256 } from "../../lib/crypto.js";
import { log } from "../../lib/log.js";
import { RESERVED_USER_SLUGS } from "../../lib/slug.js";
import { AccountUnavailableError } from "../../providers/accounts.js";
import { type Ctx, type Env, field } from "../context.js";
import { isValidZone } from "../format.js";
import { clientIp } from "../middleware.js";
import { eventPath, hostPath, type PageMeta } from "../views/layout.js";
import {
  BookingPage,
  DirectoryPage,
  BookingStatusPage,
  CancelPage,
  ErrorPage,
  type FormValues,
  FormPage,
  HomePage,
  PickerInner,
  type PickerProps,
  ReschedulePage,
  RescheduleConfirmPage,
  PrivacyPage,
  ShortlistPage,
} from "../views/public.js";

const MINUTE = 60_000;

// host : personne dont c'est la page, null pour une page commune du site.
export function meta<H extends User | null>(c: Ctx, title: string, host: H, scripts?: PageMeta["scripts"]): PageMeta & { host: H } {
  const deps = c.get("deps");
  return { title, assets: deps.assets, host, csrf: c.get("csrf"), ...(scripts ? { scripts } : {}) };
}

export function errorPage(c: Ctx, status: 400 | 403 | 404 | 409 | 410 | 429 | 500 | 502 | 503, title: string, text: string) {
  return c.html(<ErrorPage meta={meta(c, title, null)} status={status} title={title} text={text} />, status);
}

// Personne désignée par le premier segment de l'URL.
function hostFrom(c: Ctx): User | null {
  const slug = c.req.param("user") ?? "";
  return RESERVED_USER_SLUGS.has(slug) ? null : c.get("deps").repo.getUserBySlug(slug);
}

// Type d'événement actif d'une personne, désigné par /personne/type.
function eventTypeFrom(c: Ctx): { host: User; et: EventType } | null {
  const host = hostFrom(c);
  const et = host ? c.get("deps").repo.getEventTypeBySlug(host.id, c.req.param("slug") ?? "") : null;
  return host && et?.active ? { host, et } : null;
}

export function notFound(c: Ctx) {
  return errorPage(c, 404, "Page introuvable", "Le lien est peut-être incomplet ou le rendez-vous n'est plus proposé.");
}

function tooMany(c: Ctx) {
  c.header("Retry-After", "60");
  return errorPage(c, 429, "Trop de demandes", "Patientez une minute avant de réessayer.");
}

function limited(c: Ctx, bucket: string, limit: number, windowMs: number): boolean {
  const deps = c.get("deps");
  return !deps.limiter.allow(`${bucket}:${clientIp(c, deps.config.trustProxy)}`, limit, windowMs);
}

function resolveTz(c: Ctx, fallback: string, fallbackSource: "cookie" | "default" = "default") {
  const q = c.req.query("tz");
  if (isValidZone(q)) return { tz: q, source: "query" as const };
  const cookie = getCookie(c, "tz");
  if (isValidZone(cookie)) return { tz: cookie, source: "cookie" as const };
  return { tz: fallback, source: fallbackSource };
}

function parseInstant(v: string | undefined): number | null {
  if (!v) return null;
  const d = DateTime.fromISO(v, { zone: "utc" });
  if (!d.isValid) return null;
  const ms = d.toMillis();
  return ms % MINUTE === 0 ? ms : null;
}

async function buildPicker(
  c: Ctx,
  et: EventType,
  opts: { baseHref: string; slotHref: (tz: string) => (start: number) => string; exclude?: Booking; tzFallback: string; tzSource: "cookie" | "default" },
): Promise<PickerProps | null> {
  const deps = c.get("deps");
  const schedule = deps.repo.getSchedule(et.scheduleId);
  if (!schedule) return null;
  const { tz, source } = resolveTz(c, opts.tzFallback, opts.tzSource);
  const now = deps.now();
  const currentMonth = DateTime.fromMillis(now, { zone: tz }).startOf("month");
  const lastDay = DateTime.fromMillis(now, { zone: schedule.timeZone }).startOf("day").plus({ days: et.maxHorizonDays });
  const lastMonth = DateTime.fromMillis(lastDay.toMillis(), { zone: tz }).startOf("month");

  const dayParam = c.req.query("jour");
  const monthParam = c.req.query("mois") ?? (dayParam ? dayParam.slice(0, 7) : undefined);
  let month = currentMonth;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const parsed = DateTime.fromFormat(monthParam, "yyyy-MM", { zone: tz });
    if (parsed.isValid && parsed >= currentMonth && parsed <= lastMonth) month = parsed.startOf("month");
  }
  const monthEnd = month.plus({ months: 1 });
  const result = await deps.availability.slots(et, month.toMillis(), monthEnd.toMillis(), opts.exclude ? { exclude: opts.exclude } : {});
  // En reprogrammation, l'horaire actuel n'est pas proposé.
  const slots = result.ok ? result.slots.filter((s) => s !== opts.exclude?.startAt) : [];
  const days = groupByLocalDate(slots, tz);
  const selectedDay = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) && dayParam.startsWith(month.toFormat("yyyy-MM")) ? dayParam : null;

  return {
    baseHref: opts.baseHref,
    month,
    tz,
    tzSource: source,
    today: DateTime.fromMillis(now, { zone: tz }).toISODate()!,
    days,
    selectedDay,
    prevMonth: month > currentMonth ? month.minus({ months: 1 }).toFormat("yyyy-MM") : null,
    nextMonth: month < lastMonth ? month.plus({ months: 1 }).toFormat("yyyy-MM") : null,
    status: result.ok ? "ok" : "unavailable",
    durationMinutes: et.durationMinutes,
    slotHref: opts.slotHref(tz),
  };
}

const noControl = /^\P{Cc}*$/u;

const bookingSchema = z.object({
  nom: z.string().trim().min(1, "Indiquez votre nom.").max(100, "100 caractères au maximum.").regex(noControl, "Caractères non autorisés."),
  email: z
    .string()
    .trim()
    .min(1, "Indiquez votre adresse email.")
    .max(254, "Adresse trop longue.")
    .pipe(z.email("Adresse email invalide.")),
  note: z.string().trim().max(1000, "1000 caractères au maximum."),
});

// Réservation désignée par son lien de gestion, avec la personne qui reçoit le rendez-vous.
function bookingByToken(c: Ctx): { booking: Booking; token: string; host: User } | null {
  const token = c.req.param("token") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const repo = c.get("deps").repo;
  const booking = repo.getBookingByTokenHash(sha256(token));
  const et = booking ? repo.getEventType(booking.eventTypeId) : null;
  const host = et ? repo.getUser(et.userId) : null;
  return booking && host ? { booking, token, host } : null;
}

function providerFailure(err: unknown): { title: string; text: string } {
  if (err instanceof AvailabilityCheckError || err instanceof AccountUnavailableError) {
    return { title: "Agenda indisponible", text: "La disponibilité ne peut pas être vérifiée pour le moment. Réessayez dans quelques minutes." };
  }
  return { title: "Google Agenda ne répond pas", text: "L'opération n'a pas abouti. Réessayez dans quelques minutes." };
}

export function publicRoutes(app: Hono<Env>): void {
  app.get("/", (c) => c.html(<DirectoryPage meta={meta(c, "Prendre rendez-vous", null)} hosts={c.get("deps").repo.listHosts()} />));

  app.get("/confidentialite", (c) => {
    const deps = c.get("deps");
    return c.html(
      <PrivacyPage
        meta={meta(c, "Politique de confidentialité", null)}
        contact={deps.config.adminEmails[0] ?? null}
        baseUrl={deps.config.baseUrl.origin}
      />,
    );
  });

  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /admin\nDisallow: /b/\nDisallow: /auth/\n"));

  // Étape 4 et gestion : récapitulatif, annulation, reprogrammation.
  app.get("/b/:token", (c) => {
    const found = bookingByToken(c);
    if (!found) return notFound(c);
    const tzQuery = c.req.query("tz");
    const tz = isValidZone(tzQuery) ? tzQuery : found.booking.inviteeTimeZone;
    const state = c.req.query("nouveau") === "1" ? "new" : c.req.query("deplace") === "1" ? "rescheduled" : "view";
    return c.html(
      <BookingStatusPage
        meta={{ ...meta(c, "Votre rendez-vous", found.host), robots: "noindex" }}
        booking={found.booking}
        token={found.token}
        tz={tz}
        state={state}
        now={c.get("deps").now()}
      />,
    );
  });

  app.get("/b/:token/annuler", (c) => {
    const found = bookingByToken(c);
    if (!found) return notFound(c);
    const { booking, token } = found;
    if (booking.status !== "confirmed" || booking.endAt <= c.get("deps").now()) return c.redirect(`/b/${token}`, 302);
    return c.html(
      <CancelPage meta={{ ...meta(c, "Annuler", found.host), robots: "noindex" }} booking={booking} token={token} tz={booking.inviteeTimeZone} reason="" />,
    );
  });

  app.post("/b/:token/annuler", async (c) => {
    const found = bookingByToken(c);
    if (!found) return notFound(c);
    if (limited(c, "manage", 20, 10 * MINUTE)) return tooMany(c);
    const { booking, token } = found;
    const body = await c.req.parseBody({ all: true });
    const reason = field(body, "motif").trim().slice(0, 500).replace(/(?![\n\t])\p{Cc}/gu, "");
    try {
      await c.get("deps").bookings.cancel(booking, "invitee", reason || null);
    } catch (err) {
      if (err instanceof BookingStateError) return c.redirect(`/b/${token}`, 303);
      const failure = providerFailure(err);
      return c.html(
        <CancelPage
          meta={{ ...meta(c, "Annuler", found.host), robots: "noindex" }}
          booking={booking}
          token={token}
          tz={booking.inviteeTimeZone}
          reason={reason}
          error={failure.text}
        />,
        503,
      );
    }
    return c.redirect(`/b/${token}`, 303);
  });

  app.get("/b/:token/reprogrammer", async (c) => {
    const found = bookingByToken(c);
    if (!found) return notFound(c);
    const { booking, token } = found;
    const deps = c.get("deps");
    if (booking.status !== "confirmed" || booking.endAt <= deps.now()) return c.redirect(`/b/${token}`, 302);
    const et = deps.repo.getEventType(booking.eventTypeId);
    if (!et || !et.active) {
      return errorPage(c, 410, "Reprogrammation impossible", "Ce type de rendez-vous n'est plus proposé. Annulez puis contactez l'organisateur.");
    }
    if (limited(c, "picker", 120, MINUTE)) return tooMany(c);
    const base = `/b/${token}/reprogrammer`;
    const picker = await buildPicker(c, et, {
      baseHref: base,
      slotHref: (tz) => (start) => `${base}/confirmer?${new URLSearchParams({ debut: new Date(start).toISOString(), tz }).toString()}`,
      exclude: booking,
      tzFallback: booking.inviteeTimeZone,
      tzSource: "cookie",
    });
    if (!picker) return notFound(c);
    c.header("Vary", "X-Partial");
    if (c.req.header("x-partial") === "1") return c.html(<PickerInner {...picker} />);
    return c.html(
      <ReschedulePage meta={{ ...meta(c, "Reprogrammer", found.host, ["booking"]), robots: "noindex" }} booking={booking} et={et} token={token} picker={picker} />,
    );
  });

  app.get("/b/:token/reprogrammer/confirmer", (c) => {
    const found = bookingByToken(c);
    if (!found) return notFound(c);
    const { booking, token } = found;
    const deps = c.get("deps");
    const et = deps.repo.getEventType(booking.eventTypeId);
    const start = parseInstant(c.req.query("debut"));
    const tz = c.req.query("tz");
    if (!et || booking.status !== "confirmed" || start === null || !isValidZone(tz)) return c.redirect(`/b/${token}`, 302);
    return c.html(
      <RescheduleConfirmPage
        meta={{ ...meta(c, "Reprogrammer", found.host), robots: "noindex" }}
        booking={booking}
        token={token}
        start={start}
        end={start + et.durationMinutes * MINUTE}
        tz={tz}
      />,
    );
  });

  app.post("/b/:token/reprogrammer", async (c) => {
    const found = bookingByToken(c);
    if (!found) return notFound(c);
    if (limited(c, "manage", 20, 10 * MINUTE)) return tooMany(c);
    const { booking, token } = found;
    const deps = c.get("deps");
    const body = await c.req.parseBody({ all: true });
    const start = parseInstant(field(body, "debut"));
    const tz = field(body, "tz");
    const et = deps.repo.getEventType(booking.eventTypeId);
    if (start === null || !isValidZone(tz) || !et) return c.redirect(`/b/${token}`, 303);
    try {
      await deps.bookings.reschedule(booking, start);
      return c.redirect(`/b/${token}?deplace=1&tz=${encodeURIComponent(tz)}`, 303);
    } catch (err) {
      let error: { title: string; text: string };
      if (err instanceof SlotUnavailableError) {
        error = { title: "Horaire indisponible", text: "Cet horaire vient d'être pris ou n'est plus proposé. Choisissez-en un autre." };
      } else if (err instanceof BookingStateError) {
        error = { title: "Reprogrammation impossible", text: err.message };
      } else {
        error = providerFailure(err);
      }
      return c.html(
        <RescheduleConfirmPage
          meta={{ ...meta(c, "Reprogrammer", found.host), robots: "noindex" }}
          booking={booking}
          token={token}
          start={start}
          end={start + et.durationMinutes * MINUTE}
          tz={tz}
          error={error}
        />,
        err instanceof SlotUnavailableError || err instanceof BookingStateError ? 409 : 503,
      );
    }
  });

  // Page d'une personne : ses types d'événements publics.
  app.get("/:user", (c) => {
    const host = hostFrom(c);
    if (!host) return notFound(c);
    const eventTypes = c.get("deps").repo.listPublicEventTypes(host.id);
    return c.html(<HomePage meta={meta(c, host.displayName || "Prendre rendez-vous", host)} eventTypes={eventTypes} />);
  });

  // Quelques créneaux de la semaine, page ouverte depuis la signature de mail.
  app.get("/:user/creneaux", async (c) => {
    const deps = c.get("deps");
    const host = hostFrom(c);
    if (!host) return notFound(c);
    if (limited(c, "picker", 120, MINUTE)) return tooMany(c);
    const selection = await selectSignatureSlots(deps.repo, deps.availability, host, deps.now());
    if (selection.status === "disabled" || !selection.eventType) return c.redirect(hostPath(host), 302);
    const { tz, source } = resolveTz(c, selection.zone);
    return c.html(
      <ShortlistPage
        meta={meta(c, "Réserver un échange", host, ["booking"])}
        et={selection.eventType}
        status={selection.status}
        week={selection.week}
        slots={selection.slots}
        tz={tz}
        tzSource={source}
      />,
    );
  });

  // Créneau n de la signature de mail : formulaire de réservation du créneau affiché à cette place.
  // La sélection est recalculée au clic ; le formulaire rappelle l'horaire avant confirmation.
  app.get("/:user/signature/:n{[1-4]}", async (c) => {
    const deps = c.get("deps");
    const host = hostFrom(c);
    if (!host) return notFound(c);
    if (limited(c, "picker", 120, MINUTE)) return tooMany(c);
    const selection = await selectSignatureSlots(deps.repo, deps.availability, host, deps.now());
    if (selection.status === "disabled" || !selection.eventType) return c.redirect(hostPath(host), 302);
    const slot = selection.status === "ok" ? selection.slots[Number(c.req.param("n")) - 1] : undefined;
    if (slot === undefined) return c.redirect(`${hostPath(host)}/creneaux`, 302);
    const { tz } = resolveTz(c, selection.zone);
    const params = new URLSearchParams({ debut: new Date(slot).toISOString(), tz });
    return c.redirect(`${eventPath(host, selection.eventType)}/reserver?${params.toString()}`, 302);
  });

  // Étapes 1 et 2 : jour puis horaire.
  app.get("/:user/:slug", async (c) => {
    const found = eventTypeFrom(c);
    if (!found) return notFound(c);
    const { host, et } = found;
    const deps = c.get("deps");
    if (limited(c, "picker", 120, MINUTE)) return tooMany(c);
    const schedule = deps.repo.getSchedule(et.scheduleId)!;
    const path = eventPath(host, et);
    const picker = await buildPicker(c, et, {
      baseHref: path,
      slotHref: (tz) => (start) => `${path}/reserver?${new URLSearchParams({ debut: new Date(start).toISOString(), tz }).toString()}`,
      tzFallback: schedule.timeZone,
      tzSource: "default",
    });
    if (!picker) return notFound(c);
    c.header("Vary", "X-Partial");
    if (c.req.header("x-partial") === "1") return c.html(<PickerInner {...picker} />);
    return c.html(<BookingPage meta={meta(c, et.title, host, ["booking"])} et={et} picker={picker} />);
  });

  // Étape 3 : coordonnées.
  app.get("/:user/:slug/reserver", (c) => {
    const deps = c.get("deps");
    const found = eventTypeFrom(c);
    if (!found) return notFound(c);
    const { host, et } = found;
    const path = eventPath(host, et);
    const start = parseInstant(c.req.query("debut"));
    const tz = c.req.query("tz");
    if (start === null || !isValidZone(tz) || start < deps.now()) return c.redirect(path, 302);
    const day = DateTime.fromMillis(start, { zone: tz });
    const backHref = `${path}?${new URLSearchParams({ mois: day.toFormat("yyyy-MM"), jour: day.toISODate()!, tz }).toString()}`;
    return c.html(
      <FormPage meta={meta(c, et.title, host)} et={et} start={start} tz={tz} values={{ nom: "", email: "", note: "" }} errors={{}} backHref={backHref} />,
    );
  });

  app.post("/:user/:slug/reserver", async (c) => {
    const deps = c.get("deps");
    const found = eventTypeFrom(c);
    if (!found) return notFound(c);
    const { host, et } = found;
    const path = eventPath(host, et);
    if (limited(c, "booking", 10, 10 * MINUTE)) return tooMany(c);
    const body = await c.req.parseBody({ all: true });
    const start = parseInstant(field(body, "debut"));
    const tz = field(body, "tz");
    if (start === null || !isValidZone(tz)) return c.redirect(path, 303);
    const values: FormValues = { nom: field(body, "nom"), email: field(body, "email"), note: field(body, "note") };
    const day = DateTime.fromMillis(start, { zone: tz });
    const backHref = `${path}?${new URLSearchParams({ mois: day.toFormat("yyyy-MM"), jour: day.toISODate()!, tz }).toString()}`;
    const render = (status: 400 | 409 | 503, errors: Partial<Record<keyof FormValues, string>>, formError?: { title: string; text: string }) =>
      c.html(
        <FormPage meta={meta(c, et.title, host)} et={et} start={start} tz={tz} values={values} errors={errors} formError={formError} backHref={backHref} />,
        status,
      );

    if (field(body, "site_web") !== "") {
      log.warn("réservation rejetée par le pot de miel", { eventTypeId: et.id });
      return render(400, {}, { title: "Demande refusée", text: "Votre demande n'a pas pu être traitée." });
    }
    const parsed = bookingSchema.safeParse(values);
    if (!parsed.success) {
      const errors: Partial<Record<keyof FormValues, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormValues;
        errors[key] ??= issue.message;
      }
      return render(400, errors, { title: "Formulaire incomplet", text: "Corrigez les champs signalés." });
    }
    try {
      const { token } = await deps.bookings.create({
        eventType: et,
        start,
        name: parsed.data.nom,
        email: parsed.data.email.toLowerCase(),
        note: parsed.data.note,
        timeZone: tz,
      });
      return c.redirect(`/b/${token}?nouveau=1`, 303);
    } catch (err) {
      if (err instanceof SlotUnavailableError) {
        return render(409, {}, { title: "Horaire indisponible", text: "Cet horaire vient d'être pris ou n'est plus proposé. Choisissez-en un autre." });
      }
      if (err instanceof BookingStateError) return notFound(c);
      return render(503, {}, providerFailure(err));
    }
  });

}
