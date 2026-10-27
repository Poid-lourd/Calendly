import type { DateTime } from "luxon";
import type { Booking, EventType, LocationType, Settings } from "../../db/types.js";
import {
  dayLabel,
  duration,
  longDate,
  monthLabel,
  timeRange,
  timeZones,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  zoneLabel,
  time as formatTime,
} from "../format.js";
import { HostLine, type PageMeta, PublicPage, avatarUrl } from "./layout.js";
import { ChevronLeft, ChevronRight, Csrf, describedBy, Empty, Field, Notice } from "./ui.js";

export function locationLabel(type: LocationType, value: string): string {
  switch (type) {
    case "meet":
      return "Google Meet";
    case "phone":
      return value ? `Téléphone, ${value}` : "Téléphone";
    case "address":
    case "text":
      return value;
  }
}

// Accueil : liste des types d'événements publics.
export function HomePage(props: { meta: PageMeta; eventTypes: EventType[] }) {
  const { settings } = props.meta;
  const url = avatarUrl(settings);
  return (
    <PublicPage {...props.meta}>
      <div class="home">
        <header class="home-head">
          {url ? <img class="avatar avatar--lg" src={url} alt="" width={56} height={56} /> : null}
          <div>
            <h1>{settings.displayName || "Prendre rendez-vous"}</h1>
            {settings.displayName ? <p class="muted">Choisissez un type de rendez-vous.</p> : null}
          </div>
        </header>
        {props.eventTypes.length === 0 ? (
          <Empty title="Aucun rendez-vous proposé pour le moment.">Revenez plus tard ou contactez directement votre interlocuteur.</Empty>
        ) : (
          <ul class="event-list">
            {props.eventTypes.map((et) => (
              <li>
                <a class="event-link" href={`/${et.slug}`}>
                  <span class="event-title">{et.title}</span>
                  <span class="event-meta">
                    {duration(et.durationMinutes)} · {locationLabel(et.locationType, et.locationValue)}
                  </span>
                  {et.description ? <span class="event-desc">{firstLine(et.description)}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PublicPage>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

// Colonne gauche : informations sur le rendez-vous.
export function EventInfo(props: { settings: Settings; title: string; durationMinutes: number; location: string; description?: string; children?: unknown }) {
  return (
    <aside class="booking__info" aria-label="Rendez-vous">
      <HostLine settings={props.settings} />
      <h1 class="info-title">{props.title}</h1>
      <dl class="meta">
        <div>
          <dt>Durée</dt>
          <dd>{duration(props.durationMinutes)}</dd>
        </div>
        <div>
          <dt>Lieu</dt>
          <dd>{props.location}</dd>
        </div>
      </dl>
      {props.description ? <p class="info-desc">{props.description}</p> : null}
      {props.children ?? null}
    </aside>
  );
}

export interface PickerProps {
  baseHref: string;
  month: DateTime;
  tz: string;
  tzSource: "query" | "cookie" | "default";
  today: string;
  days: Map<string, number[]>;
  selectedDay: string | null;
  prevMonth: string | null;
  nextMonth: string | null;
  status: "ok" | "unavailable";
  durationMinutes: number;
  slotHref: (start: number) => string;
}

function pickerHref(p: PickerProps, params: { mois: string; jour?: string }): string {
  const q = new URLSearchParams({ mois: params.mois, ...(params.jour ? { jour: params.jour } : {}), tz: p.tz });
  return `${p.baseHref}?${q.toString()}`;
}

function CalendarGrid(p: PickerProps) {
  const first = p.month.startOf("month");
  const lead = first.weekday - 1;
  const total = first.daysInMonth ?? 30;
  const cells: (DateTime | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 0; d < total; d++) cells.push(first.plus({ days: d }));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (DateTime | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <table class="cal" role="grid" aria-labelledby="cal-titre" data-calendar>
      <thead>
        <tr>
          {WEEKDAYS_SHORT.map((d, i) => (
            <th scope="col" abbr={WEEKDAYS[i]}>
              {d.replace(".", "")}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr>
            {week.map((day) => {
              if (!day) return <td class="day--out" role="gridcell"></td>;
              const iso = day.toISODate()!;
              const available = p.days.has(iso);
              const selected = p.selectedDay === iso;
              const today = p.today === iso;
              const label = `${day.setLocale("fr").toFormat("cccc d LLLL")}${today ? ", aujourd'hui" : ""}`;
              const cls = today ? "day day--today" : "day";
              return (
                <td role="gridcell" aria-selected={selected ? "true" : undefined} aria-disabled={available ? undefined : "true"}>
                  {available ? (
                    <a
                      class={cls}
                      href={pickerHref(p, { mois: p.month.toFormat("yyyy-MM"), jour: iso })}
                      data-date={iso}
                      data-nav
                      aria-label={`${label}, ${p.days.get(iso)!.length} horaire${p.days.get(iso)!.length > 1 ? "s" : ""}`}
                      aria-current={today ? "date" : undefined}
                    >
                      {day.day}
                    </a>
                  ) : (
                    <span class={cls} data-date={iso} aria-label={`${label}, aucun horaire`}>
                      {day.day}
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimeZoneForm(p: PickerProps) {
  const zones = timeZones().includes(p.tz) ? timeZones() : [p.tz, ...timeZones()];
  return (
    <form class="tz" method="get" action={p.baseHref} data-tz-form>
      <input type="hidden" name="mois" value={p.month.toFormat("yyyy-MM")} />
      {p.selectedDay ? <input type="hidden" name="jour" value={p.selectedDay} /> : null}
      <div class="field">
        <label class="label" for="tz">
          Fuseau horaire
        </label>
        <div class="tz-row">
          <select class="select" id="tz" name="tz">
            {zones.map((z) => (
              <option value={z} selected={z === p.tz}>
                {zoneLabel(z)}
              </option>
            ))}
          </select>
          <button class="btn" type="submit" data-no-js>
            Appliquer
          </button>
        </div>
      </div>
    </form>
  );
}

function SlotsPanel(p: PickerProps) {
  if (p.status === "unavailable") {
    return (
      <section class="slots-panel" aria-labelledby="horaires-titre">
        <h3 id="horaires-titre" class="slots-head" tabindex={-1}>
          Horaires
        </h3>
        <div class="slots-empty">
          <p>Aucun horaire à afficher.</p>
        </div>
      </section>
    );
  }
  const slots = p.selectedDay ? p.days.get(p.selectedDay) : undefined;
  if (!p.selectedDay || !slots) {
    const none = p.days.size === 0;
    return (
      <section class="slots-panel" aria-labelledby="horaires-titre">
        <h3 id="horaires-titre" class="slots-head" tabindex={-1}>
          Horaires
        </h3>
        <div class="slots-empty">
          {none ? (
            <>
              <p>Aucun horaire disponible en {p.month.setLocale("fr").toFormat("LLLL")}.</p>
              {p.nextMonth ? (
                <p>
                  <a href={pickerHref(p, { mois: p.nextMonth })} data-nav>
                    Voir le mois suivant
                  </a>
                </p>
              ) : null}
            </>
          ) : (
            <p>{p.selectedDay ? "Aucun horaire ce jour-là." : "Choisissez un jour dans le calendrier."}</p>
          )}
        </div>
      </section>
    );
  }
  const dayMs = slots[0]!;
  return (
    <section class="slots-panel" aria-labelledby="horaires-titre">
      <div class="slots-head">
        <h3 id="horaires-titre" tabindex={-1}>
          {capitalize(dayLabel(dayMs, p.tz))}
        </h3>
        <p class="slots-sub">
          {slots.length} horaire{slots.length > 1 ? "s" : ""} de {duration(p.durationMinutes)}
        </p>
      </div>
      <ul class="slots">
        {slots.map((s) => (
          <li>
            <a class="slot" href={p.slotHref(s)} aria-label={`${formatTime(s, p.tz)}, ${dayLabel(s, p.tz)}`}>
              {formatTime(s, p.tz)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Contenu remplaçable du sélecteur (rendu complet ou partiel).
export function PickerInner(p: PickerProps) {
  const monthIso = p.month.toFormat("yyyy-MM");
  return (
    <>
      <div class="cal-col">
        {p.status === "unavailable" ? (
          <div class="picker-notice">
            <Notice kind="error" title="Disponibilités momentanément indisponibles">
              L'agenda ne répond pas. Réessayez dans quelques minutes.
            </Notice>
          </div>
        ) : null}
        <div class="cal-head">
          <p class="cal-title" id="cal-titre" aria-live="polite">
            {monthLabel(p.month)}
          </p>
          <div class="cal-nav">
            {p.prevMonth ? (
              <a class="icon-btn" href={pickerHref(p, { mois: p.prevMonth })} data-nav aria-label="Mois précédent">
                <ChevronLeft />
              </a>
            ) : (
              <span class="icon-btn" aria-disabled="true" role="img" aria-label="Mois précédent indisponible">
                <ChevronLeft />
              </span>
            )}
            {p.nextMonth ? (
              <a class="icon-btn" href={pickerHref(p, { mois: p.nextMonth })} data-nav aria-label="Mois suivant">
                <ChevronRight />
              </a>
            ) : (
              <span class="icon-btn" aria-disabled="true" role="img" aria-label="Mois suivant indisponible">
                <ChevronRight />
              </span>
            )}
          </div>
        </div>
        <CalendarGrid {...p} />
        <TimeZoneForm {...p} />
        <p class="status-line" role="status" data-status></p>
      </div>
      <SlotsPanel {...p} />
      <input type="hidden" data-month value={monthIso} />
    </>
  );
}

export function Picker(p: PickerProps) {
  return (
    <div
      class="picker"
      id="picker"
      data-picker
      data-tz={p.tz}
      data-tz-source={p.tzSource}
      data-base={p.baseHref}
    >
      <PickerInner {...p} />
    </div>
  );
}

export function BookingPage(props: { meta: PageMeta; et: EventType; picker: PickerProps }) {
  const { et } = props;
  return (
    <PublicPage {...props.meta}>
      <div class="booking">
        <EventInfo
          settings={props.meta.settings}
          title={et.title}
          durationMinutes={et.durationMinutes}
          location={locationLabel(et.locationType, et.locationValue)}
          description={et.description}
        />
        <section class="booking__main" aria-labelledby="etape">
          <h2 class="step-title" id="etape">
            Choisissez un jour et un horaire
          </h2>
          <Picker {...props.picker} />
        </section>
      </div>
    </PublicPage>
  );
}

export interface FormValues {
  nom: string;
  email: string;
  note: string;
}

export function FormPage(props: {
  meta: PageMeta;
  et: EventType;
  start: number;
  tz: string;
  values: FormValues;
  errors: Partial<Record<keyof FormValues, string>>;
  formError?: { title: string; text: string } | undefined;
  backHref: string;
}) {
  const { et, start, tz, values, errors } = props;
  const end = start + et.durationMinutes * 60_000;
  return (
    <PublicPage {...props.meta}>
      <div class="booking">
        <EventInfo
          settings={props.meta.settings}
          title={et.title}
          durationMinutes={et.durationMinutes}
          location={locationLabel(et.locationType, et.locationValue)}
        >
          <div class="chosen">
            <strong>{capitalize(longDate(start, tz))}</strong>
            <span>{timeRange(start, end, tz)}</span>
            <span class="muted small">{zoneLabel(tz, start)}</span>
          </div>
          <a class="back" href={props.backHref}>
            Changer d'horaire
          </a>
        </EventInfo>
        <section class="booking__main" aria-labelledby="etape">
          <h2 class="step-title" id="etape">
            Vos coordonnées
          </h2>
          <form class="form" method="post" action={`/${et.slug}/reserver`} novalidate>
            {props.formError ? (
              <Notice kind="error" title={props.formError.title}>
                {props.formError.text}
              </Notice>
            ) : null}
            <Csrf token={props.meta.csrf} />
            <input type="hidden" name="debut" value={new Date(start).toISOString()} />
            <input type="hidden" name="tz" value={tz} />
            <Field id="nom" label="Nom" error={errors.nom}>
              <input
                class="input"
                id="nom"
                name="nom"
                type="text"
                autocomplete="name"
                required
                maxlength={100}
                value={values.nom}
                autofocus={Boolean(errors.nom)}
                aria-invalid={errors.nom ? "true" : undefined}
                aria-describedby={describedBy("nom", false, errors.nom)}
              />
            </Field>
            <Field id="email" label="Email" error={errors.email} hint="L'invitation Google Agenda sera envoyée à cette adresse.">
              <input
                class="input"
                id="email"
                name="email"
                type="email"
                autocomplete="email"
                inputmode="email"
                required
                maxlength={254}
                value={values.email}
                autofocus={!errors.nom && Boolean(errors.email)}
                aria-invalid={errors.email ? "true" : undefined}
                aria-describedby={describedBy("email", true, errors.email)}
              />
            </Field>
            <Field id="note" label="Note" optional error={errors.note} hint="Contexte utile pour préparer le rendez-vous.">
              <textarea
                class="textarea"
                id="note"
                name="note"
                maxlength={1000}
                aria-invalid={errors.note ? "true" : undefined}
                aria-describedby={describedBy("note", true, errors.note)}
              >
                {values.note}
              </textarea>
            </Field>
            <div class="honeypot" aria-hidden="true">
              <label for="site_web">Ne pas remplir</label>
              <input id="site_web" name="site_web" type="text" tabindex={-1} autocomplete="off" />
            </div>
            <div>
              <button class="btn btn--primary btn--block" type="submit">
                Confirmer la réservation
              </button>
            </div>
          </form>
        </section>
      </div>
    </PublicPage>
  );
}

function BookingRecap(props: { booking: Booking; tz: string; settings: Settings }) {
  const b = props.booking;
  return (
    <dl class="meta recap">
      <div>
        <dt>Rendez-vous</dt>
        <dd>{b.title}</dd>
      </div>
      <div>
        <dt>Date</dt>
        <dd>{capitalize(longDate(b.startAt, props.tz))}</dd>
      </div>
      <div>
        <dt>Heure</dt>
        <dd>{timeRange(b.startAt, b.endAt, props.tz)}</dd>
      </div>
      <div>
        <dt>Fuseau horaire</dt>
        <dd>{zoneLabel(props.tz, b.startAt)}</dd>
      </div>
      <div>
        <dt>Lieu</dt>
        <dd>
          {b.locationType === "meet" ? (
            b.meetUrl ? (
              <a href={b.meetUrl} rel="noopener noreferrer">
                {b.meetUrl.replace("https://", "")}
              </a>
            ) : (
              "Google Meet, lien dans l'invitation"
            )
          ) : (
            locationLabel(b.locationType, b.locationValue)
          )}
        </dd>
      </div>
      <div>
        <dt>Invité</dt>
        <dd>
          {b.inviteeName}, {b.inviteeEmail}
        </dd>
      </div>
    </dl>
  );
}

export function BookingStatusPage(props: {
  meta: PageMeta;
  booking: Booking;
  token: string;
  tz: string;
  state: "new" | "rescheduled" | "view";
  now: number;
}) {
  const b = props.booking;
  const past = b.endAt <= props.now;
  let title = "Votre rendez-vous";
  let lead: string | null = null;
  if (b.status === "cancelled") {
    title = "Rendez-vous annulé";
    lead = b.cancelledBy === "host" ? "L'organisateur a annulé ce rendez-vous." : "Vous avez annulé ce rendez-vous.";
  } else if (props.state === "new") {
    title = "Réservation confirmée";
    lead = `Une invitation Google Agenda a été envoyée à ${b.inviteeEmail}.`;
  } else if (props.state === "rescheduled") {
    title = "Rendez-vous déplacé";
    lead = `L'invitation a été mise à jour pour ${b.inviteeEmail}.`;
  } else if (past) {
    lead = "Ce rendez-vous est passé.";
  }
  return (
    <PublicPage {...props.meta}>
      <div class="booking booking--narrow">
        <div class="booking__main">
          <div class="confirm-head">
            <HostLine settings={props.meta.settings} />
            <h1>{title}</h1>
            {lead ? <p class="muted">{lead}</p> : null}
            {b.status === "cancelled" && b.cancelReason ? <p class="muted">Motif : {b.cancelReason}</p> : null}
          </div>
          <BookingRecap booking={b} tz={props.tz} settings={props.meta.settings} />
          {b.status === "confirmed" && !past ? (
            <div class="actions">
              <a class="btn" href={`/b/${props.token}/reprogrammer`}>
                Reprogrammer
              </a>
              <a class="btn btn--danger" href={`/b/${props.token}/annuler`}>
                Annuler le rendez-vous
              </a>
            </div>
          ) : null}
          {b.status === "cancelled" ? (
            <div class="actions">
              <a class="btn" href="/">
                Prendre un autre rendez-vous
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </PublicPage>
  );
}

export function CancelPage(props: { meta: PageMeta; booking: Booking; token: string; tz: string; error?: string | undefined; reason: string }) {
  const b = props.booking;
  return (
    <PublicPage {...props.meta}>
      <div class="booking booking--narrow">
        <div class="booking__main">
          <div class="confirm-head">
            <HostLine settings={props.meta.settings} />
            <h1>Annuler le rendez-vous</h1>
            <p class="muted">
              {b.title}, {longDate(b.startAt, props.tz)} à {formatTime(b.startAt, props.tz)}.
            </p>
          </div>
          <form class="form" method="post" action={`/b/${props.token}/annuler`}>
            {props.error ? <Notice kind="error" title="Annulation impossible">{props.error}</Notice> : null}
            <Csrf token={props.meta.csrf} />
            <Field id="motif" label="Motif" optional hint="Transmis à l'organisateur.">
              <textarea class="textarea" id="motif" name="motif" maxlength={500} aria-describedby="motif-aide">
                {props.reason}
              </textarea>
            </Field>
            <div class="actions">
              <button class="btn btn--primary" type="submit">
                Confirmer l'annulation
              </button>
              <a class="btn" href={`/b/${props.token}`}>
                Garder le rendez-vous
              </a>
            </div>
          </form>
        </div>
      </div>
    </PublicPage>
  );
}

export function ReschedulePage(props: { meta: PageMeta; booking: Booking; et: EventType; token: string; picker: PickerProps }) {
  const b = props.booking;
  const tz = props.picker.tz;
  return (
    <PublicPage {...props.meta}>
      <div class="booking">
        <EventInfo
          settings={props.meta.settings}
          title={b.title}
          durationMinutes={props.et.durationMinutes}
          location={locationLabel(b.locationType, b.locationValue)}
        >
          <div class="chosen">
            <span class="muted small">Horaire actuel</span>
            <strong>{capitalize(longDate(b.startAt, tz))}</strong>
            <span>{timeRange(b.startAt, b.endAt, tz)}</span>
          </div>
          <a class="back" href={`/b/${props.token}`}>
            Retour au rendez-vous
          </a>
        </EventInfo>
        <section class="booking__main" aria-labelledby="etape">
          <h2 class="step-title" id="etape">
            Choisissez un nouvel horaire
          </h2>
          <Picker {...props.picker} />
        </section>
      </div>
    </PublicPage>
  );
}

export function RescheduleConfirmPage(props: {
  meta: PageMeta;
  booking: Booking;
  token: string;
  start: number;
  end: number;
  tz: string;
  error?: { title: string; text: string } | undefined;
}) {
  const b = props.booking;
  const tz = props.tz;
  return (
    <PublicPage {...props.meta}>
      <div class="booking booking--narrow">
        <div class="booking__main">
          <div class="confirm-head">
            <HostLine settings={props.meta.settings} />
            <h1>Confirmer le nouvel horaire</h1>
            <p class="muted">{b.title}</p>
          </div>
          <dl class="meta compare">
            <div>
              <dt>Ancien horaire</dt>
              <dd class="was">
                {capitalize(longDate(b.startAt, tz))}, {timeRange(b.startAt, b.endAt, tz)}
              </dd>
            </div>
            <div>
              <dt>Nouvel horaire</dt>
              <dd>
                <strong>{capitalize(longDate(props.start, tz))}</strong>, {timeRange(props.start, props.end, tz)}
              </dd>
            </div>
            <div>
              <dt>Fuseau horaire</dt>
              <dd>{zoneLabel(tz, props.start)}</dd>
            </div>
          </dl>
          <form class="form" method="post" action={`/b/${props.token}/reprogrammer`}>
            {props.error ? (
              <Notice kind="error" title={props.error.title}>
                {props.error.text}
              </Notice>
            ) : null}
            <Csrf token={props.meta.csrf} />
            <input type="hidden" name="debut" value={new Date(props.start).toISOString()} />
            <input type="hidden" name="tz" value={tz} />
            <div class="actions">
              <button class="btn btn--primary" type="submit">
                Confirmer
              </button>
              <a class="btn" href={`/b/${props.token}/reprogrammer?tz=${encodeURIComponent(tz)}`}>
                Choisir un autre horaire
              </a>
            </div>
          </form>
        </div>
      </div>
    </PublicPage>
  );
}

// Page ouverte depuis la signature de mail : quelques créneaux de la semaine, puis le calendrier complet.
export function ShortlistPage(props: {
  meta: PageMeta;
  et: EventType;
  status: "ok" | "empty" | "unavailable";
  week: "current" | "next";
  slots: number[];
  tz: string;
  tzSource: "query" | "cookie" | "default";
}) {
  const { et, tz } = props;
  const zones = timeZones().includes(tz) ? timeZones() : [tz, ...timeZones()];
  const fullHref = `/${et.slug}?${new URLSearchParams({ tz }).toString()}`;
  return (
    <PublicPage {...props.meta}>
      <div class="booking booking--narrow">
        <div class="booking__main" data-tz-auto data-tz={tz} data-tz-source={props.tzSource}>
          <div class="confirm-head">
            <HostLine settings={props.meta.settings} />
            <h1>Réserver un échange</h1>
            <p class="muted">
              {et.title} · {duration(et.durationMinutes)} · {locationLabel(et.locationType, et.locationValue)}
            </p>
          </div>
          {props.status === "unavailable" ? (
            <Notice kind="error" title="Disponibilités momentanément indisponibles">
              L'agenda ne répond pas. Réessayez dans quelques minutes.
            </Notice>
          ) : props.status === "empty" ? (
            <Empty title="Aucun créneau libre cette semaine ni la suivante.">Le calendrier complet montre les semaines à venir.</Empty>
          ) : (
            <section class="shortlist" aria-labelledby="semaine">
              <h2 id="semaine" class="shortlist-title">
                {props.week === "current" ? "Cette semaine" : "Semaine prochaine"}
              </h2>
              <ul class="shortlist-list">
                {props.slots.map((s) => (
                  <li>
                    <a
                      class="shortlist-slot"
                      href={`/${et.slug}/reserver?${new URLSearchParams({ debut: new Date(s).toISOString(), tz }).toString()}`}
                    >
                      <span>{capitalize(dayLabel(s, tz))}</span>
                      <strong>{formatTime(s, tz)}</strong>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <form class="tz tz--compact" method="get" action="/creneaux" data-tz-form>
            <div class="field">
              <label class="label" for="tz">
                Fuseau horaire
              </label>
              <div class="tz-row">
                <select class="select" id="tz" name="tz" data-autosubmit>
                  {zones.map((z) => (
                    <option value={z} selected={z === tz}>
                      {zoneLabel(z)}
                    </option>
                  ))}
                </select>
                <button class="btn" type="submit" data-no-js>
                  Appliquer
                </button>
              </div>
            </div>
          </form>
          <div class="actions shortlist-more">
            <a class={props.status === "ok" ? "btn" : "btn btn--primary"} href={fullHref}>
              Voir toutes les disponibilités
            </a>
          </div>
        </div>
      </div>
    </PublicPage>
  );
}

// Politique de confidentialité, exigée par Google pour publier l'application OAuth.
export function PrivacyPage(props: { meta: PageMeta; contact: string | null; baseUrl: string }) {
  const name = props.meta.settings.displayName || "le responsable de ce site";
  return (
    <PublicPage {...props.meta}>
      <article class="prose">
        <h1>Politique de confidentialité</h1>
        <p class="muted">Service de prise de rendez-vous {props.baseUrl}, exploité par {name}.</p>

        <h2>Données collectées</h2>
        <p>Lors d'une réservation : nom, adresse email, note facultative, fuseau horaire et horaire choisi.</p>
        <p>
          Pour l'administrateur du service : adresse email du compte Google utilisé pour se connecter, et jetons d'accès aux
          agendas Google qu'il a connectés.
        </p>

        <h2>Utilisation</h2>
        <p>
          Ces données servent uniquement à organiser le rendez-vous : vérifier les disponibilités, créer l'événement dans Google
          Agenda, envoyer l'invitation par Google, permettre l'annulation et la reprogrammation par lien.
        </p>
        <p>Elles ne sont ni vendues, ni partagées avec des tiers, ni utilisées à des fins publicitaires ou statistiques.</p>

        <h2>Données Google</h2>
        <p>
          Le service accède aux agendas Google de l'administrateur avec son accord : liste des agendas, disponibilités, création
          et modification des événements de rendez-vous. Ces données ne sont lues que pour calculer les créneaux libres et gérer
          les rendez-vous ; elles ne sont pas conservées au-delà de ce besoin, sauf l'identifiant et la liste des agendas.
        </p>
        <p>
          L'utilisation et le transfert des informations reçues des API Google respectent la{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener noreferrer">
            Google API Services User Data Policy
          </a>
          , y compris les exigences d'utilisation limitée (Limited Use).
        </p>

        <h2>Conservation et sécurité</h2>
        <p>
          Les données sont stockées sur le serveur du service. Les jetons d'accès Google sont chiffrés. Les réservations sont
          conservées tant que l'administrateur ne les supprime pas.
        </p>

        <h2>Cookies</h2>
        <p>
          Cookies techniques uniquement : protection des formulaires, fuseau horaire choisi, session de l'administrateur. Aucun
          cookie publicitaire ni outil de mesure d'audience.
        </p>

        <h2>Vos droits</h2>
        <p>
          Vous pouvez demander l'accès, la rectification ou la suppression de vos données
          {props.contact ? (
            <>
              {" "}
              en écrivant à <a href={`mailto:${props.contact}`}>{props.contact}</a>
            </>
          ) : (
            " auprès de l'organisateur du rendez-vous"
          )}
          . L'administrateur peut retirer l'accès à ses agendas à tout moment depuis son compte Google.
        </p>
      </article>
    </PublicPage>
  );
}

export function ErrorPage(props: { meta: PageMeta; status: number; title: string; text: string; action?: { href: string; label: string } }) {
  return (
    <PublicPage {...props.meta} robots="noindex">
      <div class="narrow">
        <div class="narrow-box">
          <p class="code">Erreur {props.status}</p>
          <h1>{props.title}</h1>
          <p class="muted">{props.text}</p>
          <div class="actions">
            <a class="btn" href={props.action?.href ?? "/"}>
              {props.action?.label ?? "Retour à l'accueil"}
            </a>
          </div>
        </div>
      </div>
    </PublicPage>
  );
}
