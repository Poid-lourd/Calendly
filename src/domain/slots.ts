import { DateTime } from "luxon";
import type { MinuteRange } from "../db/types.js";

export interface Interval {
  start: number;
  end: number;
}

export interface SlotRules {
  durationMinutes: number;
  // Espacement entre deux débuts de créneau. null : égal à la durée.
  intervalMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  // Dernière date réservable : aujourd'hui + N jours, dans le fuseau du planning.
  maxHorizonDays: number;
  dailyLimit: number | null;
}

export interface SlotInput {
  timeZone: string;
  weekly: Record<number, MinuteRange[]>;
  overrides: Record<string, MinuteRange[]>;
  rules: SlotRules;
  // Périodes occupées (agendas Google et réservations locales), instants UTC en millisecondes.
  // Le créneau, tampons compris, ne doit chevaucher aucune de ces périodes.
  busy: Interval[];
  // Réservations locales élargies de leurs propres tampons : le créneau, hors tampons, ne doit pas les chevaucher.
  blocked?: Interval[];
  // Débuts des réservations actives du type d'événement, pour le plafond quotidien.
  bookedStarts: number[];
  rangeStart: number;
  rangeEnd: number;
  now: number;
}

const MINUTE = 60_000;

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

// Deux intervalles en conflit, en tenant compte des tampons de chacun.
export function conflicts(
  candidate: Interval & { before: number; after: number },
  existing: Interval & { before: number; after: number },
): boolean {
  const a = candidate.start - candidate.before < existing.end && existing.start < candidate.end + candidate.after;
  const b = candidate.start < existing.end + existing.after && existing.start - existing.before < candidate.end;
  return a || b;
}

// Vrai si [start, end) chevauche une période de la liste fusionnée et triée.
function overlaps(merged: Interval[], start: number, end: number): boolean {
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid]!.end <= start) lo = mid + 1;
    else hi = mid;
  }
  const candidate = merged[lo];
  return candidate !== undefined && candidate.start < end;
}

// Instant correspondant à une minute de la journée locale. Luxon gère les heures inexistantes ou doublées.
function atMinute(day: DateTime, minute: number): DateTime {
  if (minute >= 1440) return day.plus({ days: 1 }).startOf("day");
  return day.set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 });
}

export function rangesForDate(
  weekly: Record<number, MinuteRange[]>,
  overrides: Record<string, MinuteRange[]>,
  day: DateTime,
): MinuteRange[] {
  const iso = day.toISODate()!;
  return overrides[iso] ?? weekly[day.weekday] ?? [];
}

// Débuts des créneaux libres (UTC, ms) compris dans [rangeStart, rangeEnd), triés.
export function computeSlots(input: SlotInput): number[] {
  const { rules, timeZone } = input;
  const zone = timeZone;
  const duration = rules.durationMinutes * MINUTE;
  const step = (rules.intervalMinutes ?? rules.durationMinutes) * MINUTE;
  const before = rules.bufferBeforeMinutes * MINUTE;
  const after = rules.bufferAfterMinutes * MINUTE;
  const earliest = input.now + rules.minNoticeMinutes * MINUTE;
  const lastDate = DateTime.fromMillis(input.now, { zone }).startOf("day").plus({ days: rules.maxHorizonDays });
  const busy = mergeIntervals(input.busy);
  const blocked = mergeIntervals(input.blocked ?? []);

  const perDay = new Map<string, number>();
  for (const s of input.bookedStarts) {
    const key = DateTime.fromMillis(s, { zone }).toISODate()!;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  const found = new Set<number>();
  // Une journée de marge : une plage locale peut commencer la veille de rangeStart en UTC.
  let day = DateTime.fromMillis(input.rangeStart, { zone }).startOf("day").minus({ days: 1 });
  const lastDay = DateTime.fromMillis(input.rangeEnd, { zone }).startOf("day");

  while (day <= lastDay && day <= lastDate) {
    const iso = day.toISODate()!;
    const full = rules.dailyLimit !== null && (perDay.get(iso) ?? 0) >= rules.dailyLimit;
    if (!full) {
      for (const range of rangesForDate(input.weekly, input.overrides, day)) {
        const rangeEnd = atMinute(day, range.end).toMillis();
        for (let t = atMinute(day, range.start).toMillis(); t + duration <= rangeEnd; t += step) {
          if (t < input.rangeStart || t >= input.rangeEnd || t < earliest) continue;
          if (overlaps(busy, t - before, t + duration + after) || overlaps(blocked, t, t + duration)) continue;
          found.add(t);
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  return [...found].sort((a, b) => a - b);
}

// Regroupe des instants par date locale dans le fuseau donné.
export function groupByLocalDate(slots: number[], zone: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const s of slots) {
    const key = DateTime.fromMillis(s, { zone }).toISODate()!;
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return map;
}
