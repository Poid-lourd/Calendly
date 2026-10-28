import type { Child } from "hono/jsx";
import type { Booking, Calendar, EventType, GoogleAccount, LocationType, MinuteRange, Schedule } from "../../db/types.js";
import { duration, longDate, minutesToTime, shortDate, timeRange, timeZones, WEEKDAYS, zoneLabel, dt } from "../format.js";
import { Document, type HostMeta, avatarUrl, eventPath, hostPath } from "./layout.js";
import { locationLabel } from "./public.js";
import { Csrf, describedBy, Empty, Field, Notice } from "./ui.js";

type Section = "reservations" | "types" | "disponibilites" | "agendas" | "signature" | "reglages";

const NAV: [Section, string, string][] = [
  ["reservations", "Réservations", "/admin/reservations"],
  ["types", "Types d'événements", "/admin/types"],
  ["disponibilites", "Disponibilités", "/admin/disponibilites"],
  ["agendas", "Agendas", "/admin/agendas"],
  ["signature", "Signature", "/admin/signature"],
  ["reglages", "Réglages", "/admin/reglages"],
];

// La personne connectée est l'hôte des pages de l'admin : son nom, sa couleur, son espace.
export interface AdminMeta extends HostMeta {
  email: string;
  section: Section;
  disconnected: GoogleAccount[];
  flash?: string | undefined;
}

export function AdminPage(props: AdminMeta & { children: Child }) {
  return (
    <Document {...props} scripts={["admin"]} robots="noindex" bodyClass="admin">
      <header class="admin-bar">
        <div class="admin-bar__inner">
          <a class="brand" href="/admin">
            {props.host.displayName || "Rendez-vous"}
          </a>
          <div class="admin-user">
            <span class="email">{props.email}</span>
            <a href={hostPath(props.host)}>Ma page</a>
            <form class="inline-form" method="post" action="/admin/deconnexion">
              <Csrf token={props.csrf} />
              <button class="link-btn" type="submit">
                Se déconnecter
              </button>
            </form>
          </div>
          <nav class="admin-nav" aria-label="Administration">
            {NAV.map(([key, label, href]) => (
              <a href={href} aria-current={props.section === key ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main id="contenu" class="admin-main">
        <div class="stack">
          {props.disconnected.length > 0 && props.section !== "agendas" ? (
            <Notice kind="error" title="Compte Google déconnecté">
              {props.disconnected.map((a) => a.email).join(", ")}. Les types d'événements qui en dépendent ne proposent plus de créneaux.{" "}
              <a href="/admin/agendas">Reconnecter</a>
            </Notice>
          ) : null}
          {props.flash ? <Notice>{props.flash}</Notice> : null}
          <div>{props.children}</div>
        </div>
      </main>
    </Document>
  );
}

function PageHead(props: { title: string; text?: string; actions?: Child }) {
  return (
    <div class="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.text ? <p>{props.text}</p> : null}
      </div>
      {props.actions ? <div class="actions">{props.actions}</div> : null}
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ===== Réservations =====

export type BookingRow = Booking & { eventTypeTitle: string; zone: string };

export function BookingsPage(props: { meta: AdminMeta; when: "upcoming" | "past"; rows: BookingRow[]; page: number; hasMore: boolean; showZone: boolean }) {
  const { rows } = props;
  const base = props.when === "upcoming" ? "/admin/reservations" : "/admin/reservations?vue=passees";
  const pageHref = (p: number) => `${base}${base.includes("?") ? "&" : "?"}page=${p}`;
  return (
    <AdminPage {...props.meta}>
      <PageHead title="Réservations" />
      <nav class="tabs" aria-label="Période">
        <a href="/admin/reservations" aria-current={props.when === "upcoming" ? "page" : undefined}>
          À venir
        </a>
        <a href="/admin/reservations?vue=passees" aria-current={props.when === "past" ? "page" : undefined}>
          Passées
        </a>
      </nav>
      {rows.length === 0 ? (
        <Empty
          title={props.when === "upcoming" ? "Aucune réservation à venir." : "Aucune réservation passée."}
          actions={
            props.when === "upcoming" ? (
              <a class="btn" href="/">
                Voir la page publique
              </a>
            ) : undefined
          }
        >
          {props.when === "upcoming" ? "Les rendez-vous pris sur vos pages publiques apparaîtront ici." : undefined}
        </Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Invité</th>
              <th scope="col">Type</th>
              <th scope="col">Statut</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr class={b.status === "cancelled" ? "is-cancelled" : undefined}>
                <td>
                  <a href={`/admin/reservations/${b.id}`}>{capitalize(shortDate(b.startAt, b.zone))}</a>
                  <span class="sub">
                    {timeRange(b.startAt, b.endAt, b.zone)}
                    {props.showZone ? ` · ${b.zone}` : ""}
                  </span>
                </td>
                <td>
                  {b.inviteeName}
                  <span class="sub">{b.inviteeEmail}</span>
                </td>
                <td>{b.eventTypeTitle}</td>
                <td class={b.status === "cancelled" ? "status-cancelled" : undefined}>{b.status === "cancelled" ? "Annulée" : "Confirmée"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.page > 1 || props.hasMore ? (
        <div class="pager">
          {props.page > 1 ? <a href={pageHref(props.page - 1)}>Page précédente</a> : <span />}
          {props.hasMore ? <a href={pageHref(props.page + 1)}>Page suivante</a> : null}
        </div>
      ) : null}
    </AdminPage>
  );
}

export function BookingDetailPage(props: { meta: AdminMeta; booking: Booking; eventTypeTitle: string; zone: string; calendar: Calendar | null; now: number; error?: string | undefined }) {
  const b = props.booking;
  const canCancel = b.status === "confirmed";
  return (
    <AdminPage {...props.meta}>
      <p>
        <a class="back" href={b.endAt < props.now ? "/admin/reservations?vue=passees" : "/admin/reservations"}>
          Réservations
        </a>
      </p>
      <PageHead title={b.inviteeName} text={b.status === "cancelled" ? "Réservation annulée" : b.endAt < props.now ? "Rendez-vous passé" : "Réservation confirmée"} />
      <div class="stack admin-form">
        <dl class="meta meta--rows">
          <div>
            <dt>Type</dt>
            <dd>{props.eventTypeTitle}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{capitalize(longDate(b.startAt, props.zone))}</dd>
          </div>
          <div>
            <dt>Heure</dt>
            <dd>
              {timeRange(b.startAt, b.endAt, props.zone)} <span class="muted">({props.zone})</span>
            </dd>
          </div>
          <div>
            <dt>Invité</dt>
            <dd>
              {b.inviteeName}, <a href={`mailto:${b.inviteeEmail}`}>{b.inviteeEmail}</a>
            </dd>
          </div>
          <div>
            <dt>Fuseau de l'invité</dt>
            <dd>{zoneLabel(b.inviteeTimeZone, b.startAt)}</dd>
          </div>
          <div>
            <dt>Note</dt>
            <dd class="pre-line">{b.inviteeNote || "Aucune"}</dd>
          </div>
          <div>
            <dt>Lieu</dt>
            <dd>
              {b.locationType === "meet" && b.meetUrl ? (
                <a href={b.meetUrl} rel="noopener noreferrer">
                  {b.meetUrl.replace("https://", "")}
                </a>
              ) : (
                locationLabel(b.locationType, b.locationValue)
              )}
            </dd>
          </div>
          <div>
            <dt>Agenda</dt>
            <dd>{props.calendar ? props.calendar.summary : "Compte retiré"}</dd>
          </div>
          <div>
            <dt>Réservée le</dt>
            <dd>{dt(b.createdAt, props.zone).toFormat("d LLL yyyy, HH:mm")}</dd>
          </div>
          {b.rescheduledAt ? (
            <div>
              <dt>Reprogrammée le</dt>
              <dd>{dt(b.rescheduledAt, props.zone).toFormat("d LLL yyyy, HH:mm")}</dd>
            </div>
          ) : null}
          {b.status === "cancelled" ? (
            <div>
              <dt>Annulation</dt>
              <dd>
                {b.cancelledBy === "host" ? "Par vous" : "Par l'invité"}
                {b.cancelledAt ? `, le ${dt(b.cancelledAt, props.zone).toFormat("d LLL yyyy à HH:mm")}` : ""}
                {b.cancelReason ? `. Motif : ${b.cancelReason}` : ""}
              </dd>
            </div>
          ) : null}
        </dl>
        {canCancel ? (
          <form class="section form admin-form" method="post" action={`/admin/reservations/${b.id}/annuler`}>
            <h2>Annuler la réservation</h2>
            {props.error ? <Notice kind="error" title="Annulation impossible">{props.error}</Notice> : null}
            <Csrf token={props.meta.csrf} />
            <Field id="motif" label="Motif" optional hint="Ajouté à l'événement. Google prévient l'invité de l'annulation.">
              <textarea class="textarea" id="motif" name="motif" maxlength={500} aria-describedby="motif-aide"></textarea>
            </Field>
            <div>
              <button class="btn btn--danger" type="submit">
                Annuler la réservation
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </AdminPage>
  );
}

// ===== Types d'événements =====

export function EventTypesPage(props: { meta: AdminMeta; items: (EventType & { scheduleName: string })[]; hasCalendars: boolean; hasSchedules: boolean; baseUrl: string }) {
  const ready = props.hasCalendars && props.hasSchedules;
  return (
    <AdminPage {...props.meta}>
      <PageHead
        title="Types d'événements"
        actions={
          ready ? (
            <a class="btn btn--primary" href="/admin/types/nouveau">
              Nouveau type
            </a>
          ) : undefined
        }
      />
      {!ready ? (
        <Empty
          title={!props.hasCalendars ? "Aucun agenda connecté." : "Aucun planning de disponibilité."}
          actions={
            !props.hasCalendars ? (
              <a class="btn btn--primary" href="/admin/agendas">
                Connecter un compte Google
              </a>
            ) : (
              <a class="btn btn--primary" href="/admin/disponibilites/nouveau">
                Créer un planning
              </a>
            )
          }
        >
          {!props.hasCalendars
            ? "Un type d'événement a besoin d'un agenda de destination."
            : "Un type d'événement s'appuie sur un planning de disponibilité."}
        </Empty>
      ) : props.items.length === 0 ? (
        <Empty title="Aucun type d'événement." actions={<a class="btn" href="/admin/types/nouveau">Créer un type</a>}>
          Chaque type a sa propre page de réservation.
        </Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Titre</th>
              <th scope="col">Durée</th>
              <th scope="col">Planning</th>
              <th scope="col">Visibilité</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((et) => (
              <tr class={et.active ? undefined : "is-cancelled"}>
                <td>
                  <a href={`/admin/types/${et.id}`}>{et.title}</a>
                  <span class="sub">{eventPath(props.meta.host, et)}</span>
                </td>
                <td>{duration(et.durationMinutes)}</td>
                <td>{et.scheduleName}</td>
                <td>
                  {!et.active ? "Inactif" : et.visibility === "public" ? "Public" : "Non listé"}
                  {et.active ? (
                    <span class="sub">
                      <a href={eventPath(props.meta.host, et)}>Ouvrir la page</a>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminPage>
  );
}

export interface EventTypeValues {
  title: string;
  slug: string;
  description: string;
  duration: string;
  locationType: LocationType;
  locationValue: string;
  scheduleId: string;
  destinationCalendarId: string;
  interval: string;
  bufferBefore: string;
  bufferAfter: string;
  notice: string;
  horizon: string;
  dailyLimit: string;
  visibility: "public" | "unlisted";
  active: boolean;
  blocking: string[];
}

export type Errors<T> = Partial<Record<keyof T, string>>;

function Options(props: { values: [string, string][]; selected: string }) {
  const known = props.values.some(([v]) => v === props.selected);
  const list = known || props.selected === "" ? props.values : [...props.values, [props.selected, `${props.selected} min`] as [string, string]];
  return (
    <>
      {list.map(([v, label]) => (
        <option value={v} selected={v === props.selected}>
          {label}
        </option>
      ))}
    </>
  );
}

const INTERVALS: [string, string][] = [["", "Égal à la durée"], ...["5", "10", "15", "20", "30", "45", "60", "90", "120"].map((v): [string, string] => [v, duration(Number(v))])];
const BUFFERS: [string, string][] = ["0", "5", "10", "15", "20", "30", "45", "60", "90", "120"].map((v) => [v, v === "0" ? "Aucun" : duration(Number(v))]);
const NOTICES: [string, string][] = [
  ["0", "Aucun"],
  ["15", "15 min"],
  ["30", "30 min"],
  ["60", "1 h"],
  ["120", "2 h"],
  ["240", "4 h"],
  ["480", "8 h"],
  ["720", "12 h"],
  ["1440", "24 h"],
  ["2880", "48 h"],
  ["4320", "3 jours"],
  ["10080", "1 semaine"],
];

const ROLE_LABELS: Record<string, string> = {
  owner: "Propriétaire",
  writer: "Modification",
  reader: "Lecture",
  freeBusyReader: "Disponibilités seulement",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function isWritable(c: Calendar): boolean {
  return c.accessRole === "owner" || c.accessRole === "writer";
}

export function EventTypeFormPage(props: {
  meta: AdminMeta;
  id: number | null;
  values: EventTypeValues;
  errors: Errors<EventTypeValues>;
  schedules: Schedule[];
  accounts: GoogleAccount[];
  calendars: Calendar[];
  baseUrl: string;
  bookingCount: number;
}) {
  const { values: v, errors: e } = props;
  const action = props.id === null ? "/admin/types" : `/admin/types/${props.id}`;
  const prefix = `${props.baseUrl.replace(/\/$/, "").replace(/^https?:\/\//, "")}${hostPath(props.meta.host)}/`;
  const hasErrors = Object.keys(e).length > 0;
  return (
    <AdminPage {...props.meta}>
      <p>
        <a class="back" href="/admin/types">
          Types d'événements
        </a>
      </p>
      <PageHead title={props.id === null ? "Nouveau type d'événement" : v.title || "Type d'événement"} />
      <form class="stack admin-form" method="post" action={action} novalidate>
        {hasErrors ? <Notice kind="error" title="Enregistrement impossible">Corrigez les champs signalés.</Notice> : null}
        <Csrf token={props.meta.csrf} />
        <section class="section">
          <h2>Général</h2>
          <div class="form-grid">
            <Field id="title" label="Titre" error={e.title}>
              <input class="input" id="title" name="title" value={v.title} required maxlength={120} aria-invalid={e.title ? "true" : undefined} aria-describedby={describedBy("title", false, e.title)} />
            </Field>
            <Field id="slug" label="Adresse de la page" error={e.slug} hint="Lettres minuscules, chiffres et tirets.">
              <div class="slug-row">
                <span class="slug-prefix" aria-hidden="true">
                  {prefix}
                </span>
                <input class="input" id="slug" name="slug" value={v.slug} required maxlength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" aria-invalid={e.slug ? "true" : undefined} aria-describedby={describedBy("slug", true, e.slug)} />
              </div>
            </Field>
            <Field id="description" label="Description" optional error={e.description}>
              <textarea class="textarea" id="description" name="description" maxlength={2000} aria-describedby={describedBy("description", false, e.description)}>
                {v.description}
              </textarea>
            </Field>
            <Field id="duration" label="Durée (minutes)" error={e.duration} class="field--narrow">
              <input class="input" id="duration" name="duration" type="number" min={5} max={720} step={5} inputmode="numeric" value={v.duration} required aria-invalid={e.duration ? "true" : undefined} aria-describedby={describedBy("duration", false, e.duration)} />
            </Field>
          </div>
        </section>

        <section class="section">
          <h2>Lieu</h2>
          <fieldset>
            <legend>Type de lieu</legend>
            <div class="choices">
              {(
                [
                  ["meet", "Google Meet", "Lien créé automatiquement avec l'événement."],
                  ["phone", "Téléphone", "Numéro à appeler, indiqué dans l'invitation."],
                  ["address", "Adresse", "Rendez-vous en personne."],
                  ["text", "Texte libre", "Toute autre indication."],
                ] as [LocationType, string, string][]
              ).map(([value, label, hint]) => (
                <label class="check">
                  <input type="radio" name="locationType" value={value} checked={v.locationType === value} data-location-type />
                  <span>
                    {label}
                    <span class="hint">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field id="locationValue" label="Précision du lieu" error={e.locationValue} hint="Numéro, adresse ou texte. Ignoré pour Google Meet.">
            <input class="input" id="locationValue" name="locationValue" value={v.locationValue} maxlength={300} aria-invalid={e.locationValue ? "true" : undefined} aria-describedby={describedBy("locationValue", true, e.locationValue)} />
          </Field>
        </section>

        <section class="section">
          <h2>Disponibilités</h2>
          <div class="form-grid form-grid--2">
            <Field id="scheduleId" label="Planning" error={e.scheduleId}>
              <select class="select" id="scheduleId" name="scheduleId" aria-invalid={e.scheduleId ? "true" : undefined}>
                {props.schedules.map((s) => (
                  <option value={String(s.id)} selected={String(s.id) === v.scheduleId}>
                    {s.name} ({s.timeZone})
                  </option>
                ))}
              </select>
            </Field>
            <Field id="interval" label="Intervalle entre créneaux" error={e.interval}>
              <select class="select" id="interval" name="interval">
                <Options values={INTERVALS} selected={v.interval} />
              </select>
            </Field>
            <Field id="bufferBefore" label="Tampon avant" error={e.bufferBefore}>
              <select class="select" id="bufferBefore" name="bufferBefore">
                <Options values={BUFFERS} selected={v.bufferBefore} />
              </select>
            </Field>
            <Field id="bufferAfter" label="Tampon après" error={e.bufferAfter}>
              <select class="select" id="bufferAfter" name="bufferAfter">
                <Options values={BUFFERS} selected={v.bufferAfter} />
              </select>
            </Field>
            <Field id="notice" label="Préavis minimum" error={e.notice}>
              <select class="select" id="notice" name="notice">
                <Options values={NOTICES} selected={v.notice} />
              </select>
            </Field>
            <Field id="horizon" label="Horizon (jours)" error={e.horizon} hint="Réservable jusqu'à ce nombre de jours à l'avance.">
              <input class="input" id="horizon" name="horizon" type="number" min={1} max={730} inputmode="numeric" value={v.horizon} aria-invalid={e.horizon ? "true" : undefined} aria-describedby={describedBy("horizon", true, e.horizon)} />
            </Field>
            <Field id="dailyLimit" label="Plafond quotidien" optional error={e.dailyLimit} hint="Nombre maximum de réservations par jour pour ce type.">
              <input class="input" id="dailyLimit" name="dailyLimit" type="number" min={1} max={100} inputmode="numeric" value={v.dailyLimit} aria-invalid={e.dailyLimit ? "true" : undefined} aria-describedby={describedBy("dailyLimit", true, e.dailyLimit)} />
            </Field>
          </div>
        </section>

        <section class="section">
          <h2>Agendas</h2>
          <Field id="destinationCalendarId" label="Agenda de destination" error={e.destinationCalendarId} hint="L'événement y est créé et l'invitation envoyée depuis ce compte. Toujours pris en compte pour les disponibilités.">
            <select class="select" id="destinationCalendarId" name="destinationCalendarId" aria-invalid={e.destinationCalendarId ? "true" : undefined} aria-describedby={describedBy("destinationCalendarId", true, e.destinationCalendarId)}>
              {props.accounts.map((a) => (
                <optgroup label={a.email}>
                  {props.calendars
                    .filter((c) => c.accountId === a.id && isWritable(c))
                    .map((c) => (
                      <option value={String(c.id)} selected={String(c.id) === v.destinationCalendarId}>
                        {c.summary}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <fieldset aria-describedby={e.blocking ? "blocking-erreur" : undefined}>
            <legend>Agendas bloquants</legend>
            <p class="hint">Un événement dans l'un de ces agendas rend le créneau indisponible.</p>
            {props.accounts.map((a) => (
              <div class="cal-group">
                <p class="cal-group-title">{a.email}</p>
                <div class="choices">
                  {props.calendars
                    .filter((c) => c.accountId === a.id)
                    .map((c) => (
                      <label class="check">
                        <input type="checkbox" name="blocking" value={String(c.id)} checked={v.blocking.includes(String(c.id))} />
                        <span>
                          {c.summary}
                          <span class="hint">{roleLabel(c.accessRole)}{c.present ? "" : ", introuvable lors de la dernière actualisation"}</span>
                        </span>
                      </label>
                    ))}
                </div>
              </div>
            ))}
            {e.blocking ? (
              <p class="field-error" id="blocking-erreur">
                {e.blocking}
              </p>
            ) : null}
          </fieldset>
        </section>

        <section class="section">
          <h2>Publication</h2>
          <fieldset>
            <legend>Visibilité</legend>
            <div class="choices">
              <label class="check">
                <input type="radio" name="visibility" value="public" checked={v.visibility === "public"} />
                <span>
                  Public
                  <span class="hint">Listé sur la page d'accueil.</span>
                </span>
              </label>
              <label class="check">
                <input type="radio" name="visibility" value="unlisted" checked={v.visibility === "unlisted"} />
                <span>
                  Non listé
                  <span class="hint">Accessible uniquement avec le lien.</span>
                </span>
              </label>
            </div>
          </fieldset>
          <label class="check">
            <input type="checkbox" name="active" value="1" checked={v.active} />
            <span>
              Actif
              <span class="hint">Un type inactif n'accepte plus de réservation.</span>
            </span>
          </label>
        </section>

        <div class="form-foot">
          <button class="btn btn--primary" type="submit">
            Enregistrer
          </button>
          <a class="btn" href="/admin/types">
            Annuler
          </a>
        </div>
      </form>
      {props.id !== null ? (
        <section class="section section--spaced admin-form">
          <h2>Supprimer</h2>
          {props.bookingCount > 0 ? (
            <p class="muted">Ce type a des réservations et ne peut pas être supprimé. Désactivez-le pour ne plus le proposer.</p>
          ) : (
            <form method="post" action={`/admin/types/${props.id}/supprimer`} data-confirm="Supprimer définitivement ce type d'événement ?">
              <Csrf token={props.meta.csrf} />
              <button class="btn btn--danger" type="submit">
                Supprimer ce type
              </button>
            </form>
          )}
        </section>
      ) : null}
    </AdminPage>
  );
}

// ===== Plannings =====

function rangeLabel(r: MinuteRange): string {
  const hours = `${minutesToTime(r.start)}–${minutesToTime(r.end)}`;
  return r.maxSlots === undefined ? hours : `${hours} (${r.maxSlots} créneau${r.maxSlots > 1 ? "x" : ""})`;
}

function summarizeWeek(weekly: Record<number, MinuteRange[]>): string[] {
  const lines: string[] = [];
  for (let d = 1; d <= 7; d++) {
    const ranges = weekly[d] ?? [];
    if (ranges.length === 0) continue;
    lines.push(`${WEEKDAYS[d - 1]!.slice(0, 3)}. ${ranges.map(rangeLabel).join(", ")}`);
  }
  return lines;
}

export function SchedulesPage(props: { meta: AdminMeta; items: { schedule: Schedule; weekly: Record<number, MinuteRange[]>; usage: number }[] }) {
  return (
    <AdminPage {...props.meta}>
      <PageHead
        title="Disponibilités"
        text="Plannings hebdomadaires utilisés par les types d'événements."
        actions={
          <a class="btn btn--primary" href="/admin/disponibilites/nouveau">
            Nouveau planning
          </a>
        }
      />
      {props.items.length === 0 ? (
        <Empty title="Aucun planning." actions={<a class="btn" href="/admin/disponibilites/nouveau">Créer un planning</a>}>
          Un planning définit vos plages horaires de la semaine et ses exceptions.
        </Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">Semaine</th>
              <th scope="col">Utilisé par</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map(({ schedule, weekly, usage }) => {
              const lines = summarizeWeek(weekly);
              return (
                <tr>
                  <td>
                    <a href={`/admin/disponibilites/${schedule.id}`}>{schedule.name}</a>
                    <span class="sub">{schedule.timeZone}</span>
                  </td>
                  <td>
                    {lines.length === 0 ? (
                      <span class="muted">Aucune plage</span>
                    ) : (
                      lines.map((l) => <span class="sub">{l}</span>)
                    )}
                  </td>
                  <td>{usage === 0 ? <span class="muted">Aucun type</span> : `${usage} type${usage > 1 ? "s" : ""}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </AdminPage>
  );
}

export interface ScheduleValues {
  name: string;
  timeZone: string;
  // Plages saisies, par jour ISO (1 à 7), au format HH:MM, avec le nombre de créneaux (vide : tous).
  weekly: Record<number, { start: string; end: string; count: string }[]>;
}

function RangeRow(props: { prefix: string; start: string; end: string; count: string; label: string }) {
  return (
    <div class="range" data-range>
      <input class="input" type="text" inputmode="numeric" maxlength={5} placeholder="09:00" pattern="[0-2][0-9]:[0-5][0-9]" name={`${props.prefix}_debut`} value={props.start} aria-label={`${props.label}, début`} />
      <span class="range-sep" aria-hidden="true">
        à
      </span>
      <input class="input" type="text" inputmode="numeric" maxlength={5} placeholder="18:00" pattern="[0-2][0-9]:[0-5][0-9]" name={`${props.prefix}_fin`} value={props.end} aria-label={`${props.label}, fin`} />
      <span class="range-count">
        <input class="input input--count" type="text" inputmode="numeric" maxlength={2} placeholder="tous" pattern="[0-9]{1,2}" name={`${props.prefix}_nb`} value={props.count} aria-label={`${props.label}, nombre de créneaux, vide pour tous`} />
        <span class="range-sep" aria-hidden="true">
          créneaux
        </span>
      </span>
      <button class="link-btn" type="button" data-remove-range aria-label={`Retirer cette plage, ${props.label}`}>
        Retirer
      </button>
    </div>
  );
}

function RangesEditor(props: { prefix: string; ranges: { start: string; end: string; count: string }[]; label: string; emptyText: string }) {
  return (
    <div class="ranges" data-ranges data-prefix={props.prefix} data-label={props.label} data-empty-text={props.emptyText}>
      {props.ranges.length === 0 ? (
        <p class="range-off" data-empty>
          {props.emptyText}
        </p>
      ) : null}
      {props.ranges.map((r) => (
        <RangeRow prefix={props.prefix} start={r.start} end={r.end} count={r.count} label={props.label} />
      ))}
      <div>
        <button class="link-btn" type="button" data-add-range>
          Ajouter une plage
        </button>
      </div>
    </div>
  );
}

export function ScheduleFormPage(props: {
  meta: AdminMeta;
  id: number | null;
  values: ScheduleValues;
  errors: Errors<ScheduleValues> & { days?: Record<number, string> };
  overrides: { date: string; ranges: MinuteRange[] }[];
  overrideError?: string | undefined;
  overrideValues?: { date: string; mode: string } | undefined;
  usage: { id: number; title: string }[];
}) {
  const { values: v, errors: e } = props;
  const action = props.id === null ? "/admin/disponibilites" : `/admin/disponibilites/${props.id}`;
  const hasErrors = Boolean(e.name || e.timeZone || (e.days && Object.keys(e.days).length));
  return (
    <AdminPage {...props.meta}>
      <p>
        <a class="back" href="/admin/disponibilites">
          Disponibilités
        </a>
      </p>
      <PageHead title={props.id === null ? "Nouveau planning" : v.name || "Planning"} />
      <div class="stack admin-form">
        <form class="stack" method="post" action={action} novalidate>
          {hasErrors ? <Notice kind="error" title="Enregistrement impossible">Corrigez les champs signalés.</Notice> : null}
          <Csrf token={props.meta.csrf} />
          <section class="section">
            <div class="form-grid form-grid--2">
              <Field id="name" label="Nom" error={e.name}>
                <input class="input" id="name" name="name" value={v.name} required maxlength={80} aria-invalid={e.name ? "true" : undefined} aria-describedby={describedBy("name", false, e.name)} />
              </Field>
              <Field id="timeZone" label="Fuseau horaire" error={e.timeZone}>
                <select class="select" id="timeZone" name="timeZone" aria-invalid={e.timeZone ? "true" : undefined}>
                  {timeZones().map((z) => (
                    <option value={z} selected={z === v.timeZone}>
                      {zoneLabel(z)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </section>
          <section class="section">
            <div class="section-head">
              <h2>Semaine type</h2>
              <p>Plusieurs plages possibles par jour. Une fin à 00:00 signifie minuit.</p>
            </div>
            <p class="muted">
              Avec un nombre de créneaux, la plage n'en propose que ce nombre, pris parmi les horaires libres de vos agendas et espacés au mieux. Chaque
              réservation dans la plage en consomme un. Sans nombre, tous les horaires libres de la plage sont proposés.
            </p>
            <div class="week">
              {WEEKDAYS.map((name, i) => {
                const day = i + 1;
                const err = e.days?.[day];
                return (
                  <div class="week-day">
                    <p class="week-day__name">{capitalize(name)}</p>
                    <div>
                      <RangesEditor prefix={`j${day}`} ranges={v.weekly[day] ?? []} label={capitalize(name)} emptyText="Indisponible" />
                      {err ? <p class="field-error">{err}</p> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <div class="form-foot">
            <button class="btn btn--primary" type="submit">
              Enregistrer
            </button>
            <a class="btn" href="/admin/disponibilites">
              Annuler
            </a>
          </div>
        </form>

        {props.id !== null ? (
          <section class="section">
            <div class="section-head">
              <h2>Exceptions</h2>
              <p>Remplacent la semaine type pour une date précise.</p>
            </div>
            {props.overrides.length === 0 ? (
              <p class="muted">Aucune exception à venir.</p>
            ) : (
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Horaires</th>
                    <th scope="col">
                      <span class="visually-hidden">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {props.overrides.map((o) => (
                    <tr>
                      <td>{capitalize(dt(Date.parse(`${o.date}T12:00:00Z`), "UTC").toFormat("cccc d LLLL yyyy"))}</td>
                      <td>{o.ranges.length === 0 ? "Indisponible" : o.ranges.map(rangeLabel).join(", ")}</td>
                      <td>
                        <form method="post" action={`/admin/disponibilites/${props.id}/exceptions/${o.date}/supprimer`}>
                          <Csrf token={props.meta.csrf} />
                          <button class="link-btn" type="submit">
                            Supprimer
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <form class="form panel panel--pad" method="post" action={`/admin/disponibilites/${props.id}/exceptions`} novalidate>
              <h3>Ajouter une exception</h3>
              {props.overrideError ? <Notice kind="error" title="Exception non enregistrée">{props.overrideError}</Notice> : null}
              <Csrf token={props.meta.csrf} />
              <Field id="exc-date" label="Date" class="field--narrow">
                <input class="input" id="exc-date" name="date" type="date" required value={props.overrideValues?.date ?? ""} />
              </Field>
              <fieldset>
                <legend>Ce jour-là</legend>
                <div class="choices">
                  <label class="check">
                    <input type="radio" name="mode" value="off" checked={(props.overrideValues?.mode ?? "off") === "off"} />
                    <span>Indisponible toute la journée</span>
                  </label>
                  <label class="check">
                    <input type="radio" name="mode" value="hours" checked={props.overrideValues?.mode === "hours"} />
                    <span>Horaires spécifiques</span>
                  </label>
                </div>
              </fieldset>
              <RangesEditor prefix="exc" ranges={[{ start: "09:00", end: "12:00", count: "" }]} label="Exception" emptyText="Aucune plage" />
              <div>
                <button class="btn" type="submit">
                  Ajouter l'exception
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {props.id !== null ? (
          <section class="section">
            <h2>Supprimer</h2>
            {props.usage.length > 0 ? (
              <p class="muted">Utilisé par {props.usage.map((u) => u.title).join(", ")}. Changez leur planning avant de le supprimer.</p>
            ) : (
              <form method="post" action={`/admin/disponibilites/${props.id}/supprimer`} data-confirm="Supprimer définitivement ce planning ?">
                <Csrf token={props.meta.csrf} />
                <button class="btn btn--danger" type="submit">
                  Supprimer ce planning
                </button>
              </form>
            )}
          </section>
        ) : null}
      </div>
    </AdminPage>
  );
}

// ===== Agendas =====

export function CalendarsPage(props: {
  meta: AdminMeta;
  accounts: GoogleAccount[];
  calendars: Calendar[];
  usage: Map<number, { id: number; title: string }[]>;
  error?: string | undefined;
  zone: string;
}) {
  return (
    <AdminPage {...props.meta}>
      <PageHead
        title="Agendas"
        text="Comptes Google connectés et agendas accessibles, partagés compris."
        actions={
          <a class="btn btn--primary" href="/admin/agendas/connecter">
            Connecter un compte Google
          </a>
        }
      />
      <div class="stack">
        {props.error ? <Notice kind="error" title="Connexion du compte impossible">{props.error}</Notice> : null}
        {props.accounts.length === 0 ? (
          <Empty title="Aucun compte connecté.">
            Connectez le ou les comptes qui donnent accès à vos agendas. Un même compte peut porter plusieurs agendas, dont des agendas partagés.
          </Empty>
        ) : (
          props.accounts.map((a) => {
            const cals = props.calendars.filter((c) => c.accountId === a.id);
            const used = props.usage.get(a.id) ?? [];
            const connected = a.status === "connected";
            return (
              <section class="section account">
                <div class="account-head">
                  <h2>{a.email}</h2>
                  <p class={connected ? "muted" : "status-error"}>{connected ? "Connecté" : "Déconnecté"}</p>
                </div>
                {!connected ? (
                  <Notice kind="error" title="Autorisation à renouveler">
                    {(a.lastError ?? "Le jeton n'est plus valide").replace(/\.$/, "")}. Reconnectez ce compte avec la même adresse.
                  </Notice>
                ) : null}
                {cals.length === 0 ? (
                  <p class="muted">Aucun agenda trouvé.</p>
                ) : (
                  <table class="table">
                    <thead>
                      <tr>
                        <th scope="col">Agenda</th>
                        <th scope="col">Accès</th>
                        <th scope="col">Fuseau</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cals.map((c) => (
                        <tr class={c.present ? undefined : "is-cancelled"}>
                          <td>
                            {c.summary}
                            {c.isPrimary ? " (principal)" : ""}
                            <span class="sub">{c.externalId}</span>
                            {c.present ? null : <span class="sub">Introuvable lors de la dernière actualisation</span>}
                          </td>
                          <td>{roleLabel(c.accessRole)}</td>
                          <td>{c.timeZone ?? "Non précisé"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p class="hint">
                  {a.syncedAt ? `Liste actualisée le ${dt(a.syncedAt, props.zone).toFormat("d LLL yyyy à HH:mm")}.` : "Liste jamais actualisée."}
                  {used.length > 0 ? ` Utilisé par ${used.map((u) => u.title).join(", ")}.` : ""}
                </p>
                <div class="actions">
                  {connected ? (
                    <form method="post" action={`/admin/agendas/${a.id}/actualiser`}>
                      <Csrf token={props.meta.csrf} />
                      <button class="btn" type="submit">
                        Actualiser la liste
                      </button>
                    </form>
                  ) : (
                    <a class="btn btn--primary" href="/admin/agendas/connecter">
                      Reconnecter
                    </a>
                  )}
                  {used.length === 0 ? (
                    <form method="post" action={`/admin/agendas/${a.id}/retirer`} data-confirm={`Retirer le compte ${a.email} ?`}>
                      <Csrf token={props.meta.csrf} />
                      <button class="btn btn--danger" type="submit">
                        Retirer le compte
                      </button>
                    </form>
                  ) : null}
                </div>
              </section>
            );
          })
        )}
      </div>
    </AdminPage>
  );
}

// ===== Réglages =====

export interface SettingsValues {
  displayName: string;
  accentColor: string;
  slug: string;
}

export function SettingsPage(props: { meta: AdminMeta; values: SettingsValues; errors: Errors<SettingsValues> & { avatar?: string }; baseUrl: string }) {
  const { values: v, errors: e } = props;
  const hasErrors = Object.keys(e).length > 0;
  const avatar = avatarUrl(props.meta.host);
  const prefix = `${props.baseUrl.replace(/\/$/, "").replace(/^https?:\/\//, "")}/`;
  return (
    <AdminPage {...props.meta}>
      <PageHead title="Réglages" text="Adresse et apparence de votre page publique." />
      <form class="stack admin-form" method="post" action="/admin/reglages" enctype="multipart/form-data" novalidate>
        {hasErrors ? <Notice kind="error" title="Enregistrement impossible">Corrigez les champs signalés.</Notice> : null}
        <Csrf token={props.meta.csrf} />
        <section class="section">
          <div class="form-grid">
            <Field id="displayName" label="Nom affiché" error={e.displayName} hint="Votre nom ou celui de votre activité.">
              <input class="input" id="displayName" name="displayName" value={v.displayName} maxlength={80} aria-invalid={e.displayName ? "true" : undefined} aria-describedby={describedBy("displayName", true, e.displayName)} />
            </Field>
            <Field id="slug" label="Adresse de votre page" error={e.slug} hint="Lettres minuscules, chiffres et tirets. La changer casse les liens déjà envoyés.">
              <div class="slug-row">
                <span class="slug-prefix" aria-hidden="true">
                  {prefix}
                </span>
                <input class="input" id="slug" name="slug" value={v.slug} required maxlength={40} pattern="[a-z0-9]+(-[a-z0-9]+)*" aria-invalid={e.slug ? "true" : undefined} aria-describedby={describedBy("slug", true, e.slug)} />
              </div>
            </Field>
            <Field id="avatar" label="Photo ou logo" optional error={e.avatar} hint="PNG, JPEG ou WebP, 1 Mo au maximum. Affichée en carré.">
              <div class="avatar-row">
                {avatar ? <img class="avatar avatar--lg" src={avatar} alt="Image actuelle" width={56} height={56} /> : null}
                <span class="file-pick">
                  <input class="file-input" id="avatar" name="avatar" type="file" accept="image/png,image/jpeg,image/webp" aria-invalid={e.avatar ? "true" : undefined} aria-describedby={describedBy("avatar", true, e.avatar)} data-file-input />
                  <span class="btn" aria-hidden="true">
                    Choisir une image
                  </span>
                  <span class="file-name muted" data-file-name aria-hidden="true">
                    Aucun fichier choisi
                  </span>
                </span>
              </div>
            </Field>
            {avatar ? (
              <label class="check">
                <input type="checkbox" name="removeAvatar" value="1" />
                <span>Retirer l'image actuelle</span>
              </label>
            ) : null}
            <Field id="accentColor" label="Couleur d'accent" error={e.accentColor} hint="Boutons principaux et sélection. Contraste minimum 4,5:1 avec le blanc.">
              <div class="color-row">
                <input type="color" value={v.accentColor} aria-label="Sélecteur de couleur" data-color-picker />
                <input class="input" id="accentColor" name="accentColor" value={v.accentColor} maxlength={7} pattern="#[0-9a-fA-F]{6}" data-color-text aria-invalid={e.accentColor ? "true" : undefined} aria-describedby={describedBy("accentColor", true, e.accentColor)} />
              </div>
            </Field>
          </div>
        </section>
        <div class="form-foot">
          <button class="btn btn--primary" type="submit">
            Enregistrer
          </button>
        </div>
      </form>
    </AdminPage>
  );
}

// ===== Signature de mail =====

export function SignaturePage(props: {
  meta: AdminMeta;
  eventTypes: EventType[];
  eventTypeId: string;
  maxSlots: string;
  error?: string | undefined;
  html: string | null;
}) {
  return (
    <AdminPage {...props.meta}>
      <PageHead
        title="Signature de mail"
        text="Bloc à ajouter à votre signature. Les créneaux affichés sont recalculés à chaque ouverture du message."
      />
      {props.eventTypes.length === 0 ? (
        <Empty title="Aucun type d'événement actif." actions={<a class="btn" href="/admin/types">Types d'événements</a>}>
          La signature propose les créneaux d'un type d'événement actif.
        </Empty>
      ) : (
        <div class="stack admin-form">
          <form class="section form" method="post" action="/admin/signature" novalidate>
            <h2>Créneaux proposés</h2>
            {props.error ? <Notice kind="error" title="Enregistrement impossible">{props.error}</Notice> : null}
            <Csrf token={props.meta.csrf} />
            <div class="form-grid form-grid--2">
              <Field id="eventTypeId" label="Type d'événement">
                <select class="select" id="eventTypeId" name="eventTypeId">
                  {props.eventTypes.map((et) => (
                    <option value={String(et.id)} selected={String(et.id) === props.eventTypeId}>
                      {et.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="maxSlots" label="Créneaux montrés" hint="Répartis sur la semaine, un par jour en priorité.">
                <select class="select" id="maxSlots" name="maxSlots" aria-describedby="maxSlots-aide">
                  {["1", "2", "3", "4"].map((n) => (
                    <option value={n} selected={n === props.maxSlots}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div>
              <button class="btn btn--primary" type="submit">
                Enregistrer
              </button>
            </div>
          </form>

          {props.html ? (
            <>
              <section class="section">
                <h2>Aperçu</h2>
                <iframe class="signature-frame" src="/admin/signature/apercu" title="Aperçu de la signature"></iframe>
                <p class="hint">
                  L'image donne les prochains créneaux libres au moment où le destinataire ouvre le message. Le titre et le lien restent lisibles si sa messagerie bloque les images.
                </p>
              </section>

              <section class="section">
                <h2>Ajouter à Infomaniak Mail</h2>
                <ol class="steps">
                  <li>Copiez le bloc ci-dessous.</li>
                  <li>Dans Infomaniak Mail, ouvrez Paramètres, puis Signatures, et choisissez votre adresse.</li>
                  <li>Créez une signature, passez en édition du code source HTML et collez le code après votre signature habituelle.</li>
                  <li>À la rédaction, choisissez cette signature dans le menu déroulant des signatures.</li>
                </ol>
                <Field id="signatureCode" label="Code HTML">
                  <textarea class="textarea code-area" id="signatureCode" readonly data-signature-code>
                    {props.html}
                  </textarea>
                </Field>
                <div class="actions">
                  <button class="btn" type="button" data-copy-code>
                    Copier le code HTML
                  </button>
                  <button class="btn" type="button" data-copy-rich>
                    Copier la signature mise en forme
                  </button>
                  <span class="hint" role="status" data-copy-status></span>
                </div>
              </section>
            </>
          ) : null}
        </div>
      )}
    </AdminPage>
  );
}
