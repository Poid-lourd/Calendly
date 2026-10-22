import { DateTime, IANAZone } from "luxon";

const LOCALE = "fr";

let zoneList: string[] | null = null;

// Fuseaux IANA reconnus par le moteur JavaScript (ICU complet dans Node).
export function timeZones(): string[] {
  zoneList ??= Intl.supportedValuesOf("timeZone");
  return zoneList;
}

export function isValidZone(zone: string | undefined | null): zone is string {
  return typeof zone === "string" && zone.length <= 64 && IANAZone.isValidZone(zone);
}

export function zoneLabel(zone: string, at: number = Date.now()): string {
  const offset = DateTime.fromMillis(at, { zone }).toFormat("ZZ").replace("-", "−");
  return `${zone.replaceAll("_", " ")} (UTC${offset})`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function dt(ms: number, zone: string): DateTime {
  return DateTime.fromMillis(ms, { zone }).setLocale(LOCALE);
}

// « jeudi 23 octobre 2026 »
export function longDate(ms: number, zone: string): string {
  return dt(ms, zone).toFormat("cccc d LLLL yyyy");
}

// « jeudi 23 octobre »
export function dayLabel(ms: number, zone: string): string {
  return dt(ms, zone).toFormat("cccc d LLLL");
}

// « jeu. 23 oct. »
export function shortDate(ms: number, zone: string): string {
  return dt(ms, zone).toFormat("ccc d LLL");
}

export function time(ms: number, zone: string): string {
  return dt(ms, zone).toFormat("HH:mm");
}

export function timeRange(start: number, end: number, zone: string): string {
  return `${time(start, zone)}–${time(end, zone)}`;
}

export function monthLabel(month: DateTime): string {
  return capitalize(month.setLocale(LOCALE).toFormat("LLLL yyyy"));
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

export function minutesToTime(m: number): string {
  if (m >= 1440) return "24:00";
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// « 09:00 » → 540. « 24:00 » accepté comme fin de journée.
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h === 24 && m === 0) return 1440;
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export const WEEKDAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;
export const WEEKDAYS_SHORT = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."] as const;
