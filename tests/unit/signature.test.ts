import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { pickSpread, selectSignatureSlots } from "../../src/domain/signature.js";
import { woffToSfnt } from "../../src/lib/woff.js";
import { SignatureRenderer, signatureHtml, signatureSvg } from "../../src/web/signature.js";
import { createContext, fontFiles } from "../helpers.js";

const PARIS = "Europe/Paris";
const at = (iso: string) => DateTime.fromISO(iso, { zone: PARIS }).toMillis();
const label = (ms: number) => DateTime.fromMillis(ms, { zone: PARIS }).toFormat("ccc HH:mm");

// Semaine du lundi 4 janvier 2027, créneaux de 30 minutes de 9 h à 12 h et de 14 h à 17 h.
function week(days = 5): number[] {
  const out: number[] = [];
  for (let d = 0; d < days; d++) {
    const day = DateTime.fromISO("2027-01-04T00:00", { zone: PARIS }).plus({ days: d });
    for (const [from, to] of [
      [9, 12],
      [14, 17],
    ] as const) {
      for (let m = from * 60; m < to * 60; m += 30) out.push(day.plus({ minutes: m }).toMillis());
    }
  }
  return out;
}

describe("choix des créneaux de la signature", () => {
  it("un créneau par jour, en alternant matin et après-midi", () => {
    expect(pickSpread(week(), PARIS, 4).map(label)).toEqual(["Mon 09:00", "Tue 14:00", "Wed 09:00", "Thu 14:00"]);
  });

  it("respecte le nombre maximum", () => {
    expect(pickSpread(week(), PARIS, 1).length).toBe(1);
    expect(pickSpread(week(), PARIS, 3).length).toBe(3);
  });

  it("complète avec des créneaux espacés quand il reste peu de jours", () => {
    const picked = pickSpread(week(1), PARIS, 3).map(label);
    expect(picked).toEqual(["Mon 09:00", "Mon 11:00", "Mon 14:00"]);
  });

  it("prend le premier créneau du jour à défaut de la demi-journée préférée", () => {
    const afternoonOnly = [at("2027-01-04T15:00"), at("2027-01-05T10:00")];
    expect(pickSpread(afternoonOnly, PARIS, 2).map(label)).toEqual(["Mon 15:00", "Tue 10:00"]);
  });

  it("ne renvoie rien sans créneau", () => {
    expect(pickSpread([], PARIS, 3)).toEqual([]);
  });
});

describe("sélection selon la semaine", () => {
  it("semaine en cours, puis semaine suivante quand elle est vide", async () => {
    const ctx = await createContext({ clock: { now: at("2027-01-04T08:00") } });
    const current = await selectSignatureSlots(ctx.repo, ctx.availability, ctx.clock.now);
    expect(current.status).toBe("ok");
    expect(current.week).toBe("current");
    expect(current.slots.length).toBe(3);
    expect(current.slots.every((s) => s < at("2027-01-11T00:00"))).toBe(true);

    ctx.clock.now = at("2027-01-09T10:00");
    const weekend = await selectSignatureSlots(ctx.repo, ctx.availability, ctx.clock.now);
    expect(weekend.week).toBe("next");
    expect(weekend.slots.every((s) => s >= at("2027-01-11T00:00") && s < at("2027-01-18T00:00"))).toBe(true);
  });

  it("désactivée sans type d'événement actif", async () => {
    const ctx = await createContext();
    ctx.repo.updateSignature({ eventTypeId: null, maxSlots: 3 });
    expect((await selectSignatureSlots(ctx.repo, ctx.availability, ctx.clock.now)).status).toBe("disabled");
  });

  it("indisponible si le compte Google est déconnecté", async () => {
    const ctx = await createContext();
    ctx.repo.markAccountDisconnected(ctx.repo.listAccounts()[0]!.id, "invalid_grant");
    expect((await selectSignatureSlots(ctx.repo, ctx.availability, ctx.clock.now)).status).toBe("unavailable");
  });
});

describe("image et bloc HTML", () => {
  it("convertit une police WOFF en TrueType", () => {
    const sfnt = woffToSfnt(readFileSync(fontFiles()[0]!));
    expect(sfnt.readUInt32BE(0)).toBe(0x00010000);
    const tags = Array.from({ length: sfnt.readUInt16BE(4) }, (_, i) => sfnt.toString("latin1", 12 + i * 16, 16 + i * 16));
    expect(tags).toEqual(expect.arrayContaining(["cmap", "glyf", "head", "hmtx"]));
  });

  it("écrit les créneaux dans l'image, dans le fuseau du planning", () => {
    const svg = signatureSvg(
      { status: "ok", eventType: null, zone: PARIS, week: "current", slots: [at("2027-01-05T14:00")] },
      at("2027-01-04T08:00"),
    );
    expect(svg).toContain("Cette semaine");
    expect(svg).toContain("Mar. 5 janv.");
    expect(svg).toContain("14:00");
    expect(svg).toContain("Heure de Paris (UTC+01:00)");
  });

  it("produit une image PNG avec du texte", () => {
    const renderer = new SignatureRenderer(fontFiles());
    const png = renderer.render(
      { status: "ok", eventType: null, zone: PARIS, week: "next", slots: [at("2027-01-05T14:00"), at("2027-01-06T09:00")] },
      at("2027-01-04T08:00"),
    );
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(960);
    expect(png.readUInt32BE(20)).toBe(224);
    expect(png.length).toBeGreaterThan(3000);
  });

  it("bloc HTML compatible messagerie, URL absolues", () => {
    const html = signatureHtml({ baseUrl: new URL("https://rdv.exemple.fr"), slug: "echange-30-min", accent: "#0d6b52" });
    expect(html).toContain('href="https://rdv.exemple.fr/creneaux"');
    expect(html).toContain('src="https://rdv.exemple.fr/signature.png"');
    expect(html).toContain('href="https://rdv.exemple.fr/echange-30-min"');
    expect(html).toContain("<table");
    expect(html).not.toMatch(/<style|<script|class=/);
  });
});
