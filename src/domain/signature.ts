import { DateTime } from "luxon";
import type { Repo } from "../db/repo.js";
import type { EventType, User } from "../db/types.js";
import type { Availability } from "./availability.js";
import { groupByLocalDate } from "./slots.js";

const HOUR = 3_600_000;

export interface SignatureSelection {
  // ok : créneaux trouvés ; empty : rien cette semaine ni la suivante ;
  // unavailable : agenda injoignable ; disabled : aucun type d'événement actif configuré.
  status: "ok" | "empty" | "unavailable" | "disabled";
  eventType: EventType | null;
  zone: string;
  week: "current" | "next";
  slots: number[];
}

// Retient au plus `max` créneaux répartis : un par jour d'abord, en alternant matin et après-midi,
// puis d'autres créneaux espacés d'au moins deux heures de ceux déjà retenus le même jour.
export function pickSpread(slots: number[], zone: string, max: number): number[] {
  const days = [...groupByLocalDate([...slots].sort((a, b) => a - b), zone).values()];
  const hour = (s: number) => DateTime.fromMillis(s, { zone }).hour;
  const picked: number[] = [];
  const perDay: number[][] = days.map(() => []);

  days.forEach((list, i) => {
    if (picked.length >= max) return;
    const preferred = i % 2 === 0 ? list.find((s) => hour(s) < 12) : list.find((s) => hour(s) >= 13);
    const choice = preferred ?? list[0]!;
    picked.push(choice);
    perDay[i]!.push(choice);
  });

  let progress = true;
  while (picked.length < max && progress) {
    progress = false;
    for (let i = 0; i < days.length && picked.length < max; i++) {
      const next = days[i]!.find((s) => perDay[i]!.every((p) => Math.abs(p - s) >= 2 * HOUR));
      if (next !== undefined) {
        picked.push(next);
        perDay[i]!.push(next);
        progress = true;
      }
    }
  }
  return picked.sort((a, b) => a - b);
}

// Créneaux montrés dans la signature d'une personne : semaine en cours, sinon semaine suivante, dans le fuseau du planning.
export async function selectSignatureSlots(repo: Repo, availability: Availability, user: User, now: number): Promise<SignatureSelection> {
  const found = user.signatureEventTypeId === null ? null : repo.getEventType(user.signatureEventTypeId);
  const et = found?.userId === user.id ? found : null;
  const schedule = et ? repo.getSchedule(et.scheduleId) : null;
  if (!et || !et.active || !schedule) {
    return { status: "disabled", eventType: null, zone: schedule?.timeZone ?? "Europe/Paris", week: "current", slots: [] };
  }
  const zone = schedule.timeZone;
  const weekStart = DateTime.fromMillis(now, { zone }).startOf("week");
  const windows: ["current" | "next", number, number][] = [
    ["current", now, weekStart.plus({ weeks: 1 }).toMillis()],
    ["next", weekStart.plus({ weeks: 1 }).toMillis(), weekStart.plus({ weeks: 2 }).toMillis()],
  ];
  for (const [week, from, to] of windows) {
    const result = await availability.slots(et, from, to);
    if (!result.ok) return { status: "unavailable", eventType: et, zone, week, slots: [] };
    if (result.slots.length > 0) {
      return { status: "ok", eventType: et, zone, week, slots: pickSpread(result.slots, zone, user.signatureMaxSlots) };
    }
  }
  return { status: "empty", eventType: et, zone, week: "next", slots: [] };
}
