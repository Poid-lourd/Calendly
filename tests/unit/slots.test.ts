import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { MinuteRange } from "../../src/db/types.js";
import { computeSlots, groupByLocalDate, mergeIntervals, type SlotInput, type SlotRules } from "../../src/domain/slots.js";

const H = (h: number, m = 0) => h * 60 + m;
const utc = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).toMillis();
const local = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toMillis();
const fmt = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd HH:mm");
const iso = (ms: number) => DateTime.fromMillis(ms, { zone: "utc" }).toISO({ suppressMilliseconds: true });

const rules = (over: Partial<SlotRules> = {}): SlotRules => ({
  durationMinutes: 30,
  intervalMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxHorizonDays: 365,
  dailyLimit: null,
  ...over,
});

const weekdays = (ranges: MinuteRange[]): Record<number, MinuteRange[]> => ({
  1: ranges,
  2: ranges,
  3: ranges,
  4: ranges,
  5: ranges,
  6: [],
  7: [],
});

// Lundi 4 janvier 2027, Paris en UTC+1.
const MONDAY = "2027-01-04";
const PARIS = "Europe/Paris";

function run(over: Partial<SlotInput> & { rules?: SlotRules }): number[] {
  return computeSlots({
    timeZone: PARIS,
    weekly: weekdays([{ start: H(9), end: H(12) }]),
    overrides: {},
    rules: rules(),
    busy: [],
    bookedStarts: [],
    rangeStart: local(`${MONDAY}T00:00`, PARIS),
    rangeEnd: local(`${MONDAY}T23:59`, PARIS),
    now: utc("2027-01-01T00:00:00Z"),
    ...over,
  });
}

const parisTimes = (slots: number[]) => slots.map((s) => fmt(s, PARIS).slice(11));

describe("plages hebdomadaires", () => {
  it("découpe une plage selon la durée", () => {
    const slots = run({});
    expect(parisTimes(slots)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
    expect(iso(slots[0]!)).toBe("2027-01-04T08:00:00Z");
  });

  it("gère plusieurs plages dans la même journée", () => {
    const slots = run({
      weekly: weekdays([
        { start: H(9), end: H(10) },
        { start: H(14), end: H(15, 30) },
      ]),
    });
    expect(parisTimes(slots)).toEqual(["09:00", "09:30", "14:00", "14:30", "15:00"]);
  });

  it("utilise l'intervalle entre créneaux, la durée doit tenir dans la plage", () => {
    const slots = run({ rules: rules({ durationMinutes: 60, intervalMinutes: 30 }) });
    expect(parisTimes(slots)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    const short = run({ weekly: weekdays([{ start: H(9), end: H(10) }]), rules: rules({ durationMinutes: 45, intervalMinutes: 15 }) });
    expect(parisTimes(short)).toEqual(["09:00", "09:15"]);
  });

  it("ne duplique pas les créneaux de plages qui se chevauchent", () => {
    const slots = run({
      weekly: weekdays([
        { start: H(9), end: H(10) },
        { start: H(9, 30), end: H(10, 30) },
      ]),
    });
    expect(parisTimes(slots)).toEqual(["09:00", "09:30", "10:00"]);
  });

  it("accepte une plage jusqu'à minuit", () => {
    const slots = run({ weekly: weekdays([{ start: H(23), end: 1440 }]) });
    expect(parisTimes(slots)).toEqual(["23:00", "23:30"]);
  });

  it("ne propose rien le week-end sans plage", () => {
    expect(run({ rangeStart: local("2027-01-09T00:00", PARIS), rangeEnd: local("2027-01-11T00:00", PARIS) })).toEqual([]);
  });
});

describe("tampons", () => {
  it("écarte les créneaux dont le tampon touche une période occupée", () => {
    const slots = run({
      rules: rules({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }),
      busy: [{ start: local(`${MONDAY}T10:00`, PARIS), end: local(`${MONDAY}T10:30`, PARIS) }],
    });
    // 09:30 se termine à 10:00, tampon après jusqu'à 10:15. 10:30 a un tampon avant dès 10:15.
    expect(parisTimes(slots)).toEqual(["09:00", "11:00", "11:30"]);
  });

  it("accepte un créneau adjacent sans tampon", () => {
    const slots = run({ busy: [{ start: local(`${MONDAY}T10:00`, PARIS), end: local(`${MONDAY}T10:30`, PARIS) }] });
    expect(parisTimes(slots)).toEqual(["09:00", "09:30", "10:30", "11:00", "11:30"]);
  });

  it("tampon avant seul", () => {
    const slots = run({
      rules: rules({ bufferBeforeMinutes: 30 }),
      busy: [{ start: local(`${MONDAY}T08:00`, PARIS), end: local(`${MONDAY}T09:00`, PARIS) }],
    });
    expect(parisTimes(slots)[0]).toBe("09:30");
  });
});

describe("préavis et horizon", () => {
  it("respecte le préavis minimum", () => {
    const slots = run({ now: local(`${MONDAY}T09:10`, PARIS), rules: rules({ minNoticeMinutes: 60 }) });
    expect(parisTimes(slots)).toEqual(["10:30", "11:00", "11:30"]);
  });

  it("ne propose jamais un créneau passé", () => {
    const slots = run({ now: local(`${MONDAY}T11:00`, PARIS) });
    expect(parisTimes(slots)).toEqual(["11:00", "11:30"]);
  });

  it("s'arrête à l'horizon maximum, compté en jours calendaires du planning", () => {
    const slots = run({
      now: local(`${MONDAY}T08:00`, PARIS),
      rules: rules({ maxHorizonDays: 2 }),
      rangeEnd: local("2027-01-09T00:00", PARIS),
    });
    const days = [...groupByLocalDate(slots, PARIS).keys()];
    expect(days).toEqual(["2027-01-04", "2027-01-05", "2027-01-06"]);
  });

  it("horizon nul : uniquement aujourd'hui", () => {
    const slots = run({
      now: local(`${MONDAY}T08:00`, PARIS),
      rules: rules({ maxHorizonDays: 0 }),
      rangeEnd: local("2027-01-09T00:00", PARIS),
    });
    expect([...groupByLocalDate(slots, PARIS).keys()]).toEqual([MONDAY]);
  });
});

describe("plafond quotidien", () => {
  it("bloque la journée une fois le plafond atteint", () => {
    const slots = run({
      rules: rules({ dailyLimit: 2 }),
      bookedStarts: [local(`${MONDAY}T09:00`, PARIS), local(`${MONDAY}T11:00`, PARIS)],
      rangeEnd: local("2027-01-06T00:00", PARIS),
    });
    expect([...groupByLocalDate(slots, PARIS).keys()]).toEqual(["2027-01-05"]);
  });

  it("laisse la journée ouverte sous le plafond", () => {
    const slots = run({ rules: rules({ dailyLimit: 2 }), bookedStarts: [local(`${MONDAY}T09:00`, PARIS)] });
    expect(slots.length).toBe(6);
  });

  it("compte les réservations par date du fuseau du planning", () => {
    // Lundi 00:30 à Paris correspond à dimanche 23:30 UTC, la réservation compte pour lundi.
    const slots = run({
      rules: rules({ dailyLimit: 1 }),
      bookedStarts: [local(`${MONDAY}T00:30`, PARIS)],
    });
    expect(slots).toEqual([]);
  });
});

describe("exceptions par date", () => {
  it("une exception vide rend la journée indisponible", () => {
    expect(run({ overrides: { [MONDAY]: [] } })).toEqual([]);
  });

  it("une exception remplace les plages de la semaine", () => {
    const slots = run({ overrides: { [MONDAY]: [{ start: H(15), end: H(16) }] } });
    expect(parisTimes(slots)).toEqual(["15:00", "15:30"]);
  });

  it("une exception ouvre un jour habituellement fermé", () => {
    const saturday = "2027-01-09";
    const slots = run({
      overrides: { [saturday]: [{ start: H(10), end: H(11) }] },
      rangeStart: local(`${saturday}T00:00`, PARIS),
      rangeEnd: local(`${saturday}T23:59`, PARIS),
    });
    expect(slots.map((s) => fmt(s, PARIS))).toEqual(["2027-01-09 10:00", "2027-01-09 10:30"]);
  });
});

describe("plusieurs agendas bloquants", () => {
  it("cumule les périodes occupées de chaque agenda", () => {
    const personal = [{ start: local(`${MONDAY}T09:00`, PARIS), end: local(`${MONDAY}T09:30`, PARIS) }];
    const company = [
      { start: local(`${MONDAY}T10:15`, PARIS), end: local(`${MONDAY}T10:45`, PARIS) },
      { start: local(`${MONDAY}T11:30`, PARIS), end: local(`${MONDAY}T13:00`, PARIS) },
    ];
    const slots = run({ busy: [...personal, ...company] });
    expect(parisTimes(slots)).toEqual(["09:30", "11:00"]);
  });

  it("fusionne les périodes qui se chevauchent ou se touchent", () => {
    expect(
      mergeIntervals([
        { start: 5, end: 10 },
        { start: 0, end: 3 },
        { start: 3, end: 4 },
        { start: 8, end: 12 },
        { start: 20, end: 20 },
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 12 },
    ]);
  });
});

describe("changements d'heure", () => {
  it("Europe/Paris, passage à l'heure d'été : l'heure 02:00 n'existe pas", () => {
    // Dimanche 28 mars 2027, 02:00 devient 03:00.
    const day = "2027-03-28";
    const slots = run({
      weekly: { 7: [{ start: H(0), end: H(6) }] },
      rules: rules({ durationMinutes: 60 }),
      rangeStart: local(`${day}T00:00`, PARIS),
      rangeEnd: local(`${day}T23:00`, PARIS),
    });
    expect(parisTimes(slots)).toEqual(["00:00", "01:00", "03:00", "04:00", "05:00"]);
    expect(slots.map(iso)).toEqual([
      "2027-03-27T23:00:00Z",
      "2027-03-28T00:00:00Z",
      "2027-03-28T01:00:00Z",
      "2027-03-28T02:00:00Z",
      "2027-03-28T03:00:00Z",
    ]);
  });

  it("Europe/Paris, 09:00 locale reste 09:00 de part et d'autre du changement", () => {
    const slots = run({
      weekly: weekdays([{ start: H(9), end: H(9, 30) }]),
      rangeStart: local("2027-03-26T00:00", PARIS),
      rangeEnd: local("2027-03-30T00:00", PARIS),
    });
    expect(slots.map(iso)).toEqual(["2027-03-26T08:00:00Z", "2027-03-29T07:00:00Z"]);
  });

  it("America/New_York, retour à l'heure d'hiver : 01:00 existe deux fois", () => {
    const NY = "America/New_York";
    // Dimanche 1er novembre 2026, 02:00 EDT devient 01:00 EST.
    const slots = computeSlots({
      timeZone: NY,
      weekly: { 7: [{ start: H(0), end: H(4) }] },
      overrides: {},
      rules: rules({ durationMinutes: 60 }),
      busy: [],
      bookedStarts: [],
      rangeStart: local("2026-11-01T00:00", NY),
      rangeEnd: local("2026-11-02T00:00", NY),
      now: utc("2026-10-01T00:00:00Z"),
    });
    expect(slots.map(iso)).toEqual([
      "2026-11-01T04:00:00Z",
      "2026-11-01T05:00:00Z",
      "2026-11-01T06:00:00Z",
      "2026-11-01T07:00:00Z",
      "2026-11-01T08:00:00Z",
    ]);
    expect(slots.map((s) => fmt(s, NY).slice(11))).toEqual(["00:00", "01:00", "01:00", "02:00", "03:00"]);
  });

  it("America/New_York, 09:00 locale avant et après le changement", () => {
    const NY = "America/New_York";
    const slots = computeSlots({
      timeZone: NY,
      weekly: weekdays([{ start: H(9), end: H(9, 30) }]),
      overrides: {},
      rules: rules(),
      busy: [],
      bookedStarts: [],
      rangeStart: local("2026-10-30T00:00", NY),
      rangeEnd: local("2026-11-03T00:00", NY),
      now: utc("2026-10-01T00:00:00Z"),
    });
    expect(slots.map(iso)).toEqual(["2026-10-30T13:00:00Z", "2026-11-02T14:00:00Z"]);
  });

  it("les deux fuseaux ne changent pas d'heure le même jour", () => {
    // Le 30 octobre 2026, Paris est déjà à l'heure d'hiver (UTC+1) et New York encore à l'heure d'été (UTC-4).
    const slots = run({
      weekly: weekdays([{ start: H(15), end: H(15, 30) }]),
      rangeStart: local("2026-10-30T00:00", PARIS),
      rangeEnd: local("2026-10-31T00:00", PARIS),
      now: utc("2026-10-01T00:00:00Z"),
    });
    expect(slots.map(iso)).toEqual(["2026-10-30T14:00:00Z"]);
    expect(fmt(slots[0]!, "America/New_York")).toBe("2026-10-30 10:00");
  });
});

describe("visiteur dans un autre fuseau", () => {
  it("affiche les créneaux à la date et à l'heure du visiteur", () => {
    const TOKYO = "Asia/Tokyo";
    const slots = run({ weekly: weekdays([{ start: H(22), end: 1440 }]) });
    const grouped = groupByLocalDate(slots, TOKYO);
    expect([...grouped.keys()]).toEqual(["2027-01-05"]);
    expect(grouped.get("2027-01-05")!.map((s) => fmt(s, TOKYO).slice(11))).toEqual(["06:00", "06:30", "07:00", "07:30"]);
  });

  it("la journée demandée par le visiteur inclut des créneaux de la veille du planning", () => {
    const TOKYO = "Asia/Tokyo";
    // Mardi 5 janvier à Tokyo couvre lundi 16:00 à mardi 16:00 à Paris.
    const slots = run({
      weekly: weekdays([
        { start: H(9), end: H(10) },
        { start: H(22), end: 1440 },
      ]),
      rangeStart: local("2027-01-05T00:00", TOKYO),
      rangeEnd: local("2027-01-06T00:00", TOKYO),
    });
    expect(slots.map((s) => fmt(s, PARIS))).toEqual([
      "2027-01-04 22:00",
      "2027-01-04 22:30",
      "2027-01-04 23:00",
      "2027-01-04 23:30",
      "2027-01-05 09:00",
      "2027-01-05 09:30",
    ]);
  });

  it("visiteur à New York pendant que seul Paris a changé d'heure", () => {
    const NY = "America/New_York";
    // Lundi 2 novembre 2026 : New York vient de passer à l'heure d'hiver la veille, Paris une semaine plus tôt.
    const slots = run({
      weekly: weekdays([{ start: H(9), end: H(9, 30) }]),
      rangeStart: local("2026-11-02T00:00", NY),
      rangeEnd: local("2026-11-03T00:00", NY),
      now: utc("2026-10-01T00:00:00Z"),
    });
    expect(slots.map((s) => fmt(s, NY))).toEqual(["2026-11-02 03:00"]);
  });
});

describe("tampons des réservations existantes", () => {
  it("le tampon après d'une réservation bloque le créneau qui la suit", () => {
    const booked = { start: local(`${MONDAY}T10:00`, PARIS), end: local(`${MONDAY}T10:30`, PARIS) };
    const slots = run({ busy: [booked], blocked: [{ start: booked.start, end: booked.end + 10 * 60_000 }] });
    expect(parisTimes(slots)).toEqual(["09:00", "09:30", "11:00", "11:30"]);
  });

  it("conflits symétriques entre tampons", async () => {
    const { conflicts } = await import("../../src/domain/slots.js");
    const m = 60_000;
    const existing = { start: 60 * m, end: 90 * m, before: 0, after: 10 * m };
    expect(conflicts({ start: 90 * m, end: 120 * m, before: 0, after: 0 }, existing)).toBe(true);
    expect(conflicts({ start: 100 * m, end: 130 * m, before: 0, after: 0 }, existing)).toBe(false);
    expect(conflicts({ start: 30 * m, end: 60 * m, before: 0, after: 1 * m }, existing)).toBe(true);
    expect(conflicts({ start: 30 * m, end: 60 * m, before: 0, after: 0 }, existing)).toBe(false);
  });
});

describe("nombre de créneaux par plage", () => {
  const limited = (maxSlots: number) => ({ 1: [{ start: H(13), end: H(15), maxSlots }] });
  const at = (time: string) => local(`${MONDAY}T${time}`, PARIS);

  it("propose le nombre demandé, espacé dans la plage", () => {
    expect(parisTimes(run({ weekly: limited(2) }))).toEqual(["13:00", "14:00"]);
    expect(parisTimes(run({ weekly: limited(1) }))).toEqual(["13:00"]);
  });

  it("remplace un horaire occupé par un horaire libre de la même plage", () => {
    const slots = run({ weekly: limited(2), busy: [{ start: at("13:00"), end: at("13:30") }] });
    expect(parisTimes(slots)).toEqual(["13:30", "14:30"]);
  });

  it("complète avec les horaires restants quand l'agenda est chargé", () => {
    const busy = [
      { start: at("13:00"), end: at("13:30") },
      { start: at("14:30"), end: at("15:00") },
    ];
    expect(parisTimes(run({ weekly: limited(2), busy }))).toEqual(["13:30", "14:00"]);
  });

  it("une réservation de la plage consomme un créneau sans être remplacée", () => {
    const booked = { busy: [{ start: at("13:00"), end: at("13:30") }], scheduleBookedStarts: [at("13:00")] };
    expect(parisTimes(run({ weekly: limited(2), ...booked }))).toEqual(["14:00"]);
    const full = { busy: [...booked.busy, { start: at("14:00"), end: at("14:30") }], scheduleBookedStarts: [at("13:00"), at("14:00")] };
    expect(run({ weekly: limited(2), ...full })).toEqual([]);
  });

  it("le choix ne dépend ni de la période demandée ni de l'heure de la demande", () => {
    // Vérification d'une réservation : période d'une milliseconde.
    expect(parisTimes(run({ weekly: limited(2), rangeStart: at("14:00"), rangeEnd: at("14:00") + 1 }))).toEqual(["14:00"]);
    expect(run({ weekly: limited(2), rangeStart: at("13:30"), rangeEnd: at("13:30") + 1 })).toEqual([]);
    // À 13:10, 13:00 est passé : il n'est pas remplacé par 13:30.
    expect(parisTimes(run({ weekly: limited(2), now: at("13:10") }))).toEqual(["14:00"]);
  });

  it("s'applique aux exceptions", () => {
    const slots = run({ overrides: { [MONDAY]: [{ start: H(9), end: H(12), maxSlots: 3 }] } });
    expect(parisTimes(slots)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("laisse les plages sans nombre proposer tous les horaires libres", () => {
    const slots = run({ weekly: { 1: [{ start: H(9), end: H(10) }, { start: H(13), end: H(15), maxSlots: 1 }] } });
    expect(parisTimes(slots)).toEqual(["09:00", "09:30", "13:00"]);
  });
});
