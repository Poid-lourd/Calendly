import { DateTime } from "luxon";
import type { Repo } from "../db/repo.js";
import type { Booking, Calendar, EventType } from "../db/types.js";
import { log } from "../lib/log.js";
import { AccountUnavailableError, type Accounts } from "../providers/accounts.js";
import { computeSlots, type Interval } from "./slots.js";

export type AvailabilityResult =
  | { ok: true; slots: number[] }
  | { ok: false; reason: "account" | "provider" | "config"; message: string };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CACHE_TTL = 30_000;

// Agendas à interroger pour un type d'événement : agendas bloquants et agenda de destination.
export function calendarsFor(repo: Repo, et: EventType): Calendar[] | null {
  const ids = new Set([...et.blockingCalendarIds, et.destinationCalendarId]);
  const out: Calendar[] = [];
  for (const id of ids) {
    const cal = repo.getCalendar(id);
    if (!cal) return null;
    out.push(cal);
  }
  return out;
}

export class Availability {
  private readonly cache = new Map<string, { expires: number; busy: Interval[] }>();

  constructor(
    private readonly repo: Repo,
    private readonly accounts: Accounts,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  private async remoteBusy(calendars: Calendar[], from: number, to: number, fresh: boolean): Promise<Interval[]> {
    const byAccount = new Map<number, Calendar[]>();
    for (const c of calendars) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
    const results = await Promise.all(
      [...byAccount.entries()].map(async ([accountId, cals]) => {
        const ids = cals.map((c) => c.externalId).sort();
        const key = `${accountId}|${ids.join(",")}|${from}|${to}`;
        const hit = this.cache.get(key);
        if (!fresh && hit && hit.expires > this.now()) return hit.busy;
        const map = await this.accounts.with(accountId, (creds) => this.accounts.provider.freeBusy(creds, ids, from, to));
        const busy = [...map.values()].flat();
        this.cache.set(key, { expires: this.now() + CACHE_TTL, busy });
        return busy;
      }),
    );
    return results.flat();
  }

  // Créneaux libres de [rangeStart, rangeEnd). fresh ignore le cache, exclude retire une réservation existante (reprogrammation).
  async slots(
    et: EventType,
    rangeStart: number,
    rangeEnd: number,
    opts: { fresh?: boolean; exclude?: Booking } = {},
  ): Promise<AvailabilityResult> {
    const schedule = this.repo.getSchedule(et.scheduleId);
    const calendars = calendarsFor(this.repo, et);
    if (!schedule || !calendars) return { ok: false, reason: "config", message: "Type d'événement incomplet" };

    const now = this.now();
    const horizonEnd = DateTime.fromMillis(now, { zone: schedule.timeZone })
      .startOf("day")
      .plus({ days: et.maxHorizonDays + 1 })
      .toMillis();
    const start = Math.max(rangeStart, now + et.minNoticeMinutes * MINUTE);
    const end = Math.min(rangeEnd, horizonEnd);
    if (start >= end) return { ok: true, slots: [] };

    // Journées entières : une plage à nombre de créneaux limité se choisit sur toute sa durée, même hors de [start, end).
    const zone = schedule.timeZone;
    const busyFrom = DateTime.fromMillis(start, { zone }).startOf("day").toMillis() - et.bufferBeforeMinutes * MINUTE;
    const busyTo = DateTime.fromMillis(end, { zone }).endOf("day").toMillis() + (et.durationMinutes + et.bufferAfterMinutes) * MINUTE;
    let remote: Interval[];
    try {
      remote = await this.remoteBusy(calendars, busyFrom, busyTo, opts.fresh ?? false);
    } catch (err) {
      if (err instanceof AccountUnavailableError) {
        return { ok: false, reason: "account", message: err.message };
      }
      log.error("disponibilités indisponibles", { eventTypeId: et.id, err });
      return { ok: false, reason: "provider", message: err instanceof Error ? err.message : String(err) };
    }

    const exclude = opts.exclude;
    if (exclude) {
      // L'événement Google de la réservation reprogrammée apparaît dans freebusy : on retire sa période exacte.
      let removed = false;
      remote = remote.filter((b) => {
        if (!removed && b.start === exclude.startAt && b.end === exclude.endAt) {
          removed = true;
          return false;
        }
        return true;
      });
    }

    const local = this.repo.localBusy(
      calendars.map((c) => c.id),
      busyFrom - DAY,
      busyTo + DAY,
      exclude?.id ?? null,
    );
    const bookedStarts =
      et.dailyLimit === null ? [] : this.repo.activeStartsForEventType(et.id, start - 2 * DAY, end + 2 * DAY, exclude?.id ?? null);
    const scheduleBookedStarts = this.repo.activeStartsForSchedule(schedule.id, busyFrom, busyTo, exclude?.id ?? null);

    return {
      ok: true,
      slots: computeSlots({
        timeZone: schedule.timeZone,
        weekly: schedule.weekly,
        overrides: schedule.overrides,
        rules: {
          durationMinutes: et.durationMinutes,
          intervalMinutes: et.slotIntervalMinutes,
          bufferBeforeMinutes: et.bufferBeforeMinutes,
          bufferAfterMinutes: et.bufferAfterMinutes,
          minNoticeMinutes: et.minNoticeMinutes,
          maxHorizonDays: et.maxHorizonDays,
          dailyLimit: et.dailyLimit,
        },
        busy: [...remote, ...local.map((l) => ({ start: l.start, end: l.end }))],
        blocked: local.map((l) => ({ start: l.start - l.before, end: l.end + l.after })),
        bookedStarts,
        scheduleBookedStarts,
        rangeStart: start,
        rangeEnd: end,
        now,
      }),
    };
  }
}
