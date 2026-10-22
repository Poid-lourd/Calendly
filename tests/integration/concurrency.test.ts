import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SlotUnavailableError } from "../../src/domain/bookings.js";
import { createContext, firstSlots } from "../helpers.js";

const invitee = (i: number) => ({ name: `Invité ${i}`, email: `invite${i}@exemple.fr`, note: "", timeZone: "Europe/Paris" });

function confirmedCount(ctx: Awaited<ReturnType<typeof createContext>>): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").get() as { n: number }).n;
}

describe("aucune double réservation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rdv-concurrence-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("25 demandes simultanées sur le même créneau : une seule aboutit", async () => {
    // La latence simulée de l'agenda force l'entrelacement des requêtes entre la vérification et l'écriture.
    const ctx = await createContext({ latencyMs: 20 });
    const et = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const [start] = await firstSlots(ctx, et.slug);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => ctx.bookings.create({ eventType: et, start: start!, ...invitee(i) })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(rejected.every((r) => r.reason instanceof SlotUnavailableError)).toBe(true);
    expect(confirmedCount(ctx)).toBe(1);
    expect(ctx.provider.listEvents().length).toBe(1);
  });

  it("créneaux qui se chevauchent sans être identiques : une seule aboutit", async () => {
    const ctx = await createContext({ latencyMs: 20 });
    const base = ctx.repo.getEventTypeBySlug("point-projet")!;
    ctx.repo.saveEventType(base.id, { ...base, slotIntervalMinutes: 15, dailyLimit: null });
    const et = ctx.repo.getEventTypeBySlug("point-projet")!;
    const slots = await firstSlots(ctx, et.slug);
    const start = slots.find((s) => slots.includes(s + 15 * 60_000) && slots.includes(s + 30 * 60_000))!;
    const starts = [start, start + 15 * 60_000, start + 30 * 60_000];
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) => ctx.bookings.create({ eventType: et, start: starts[i % 3]!, ...invitee(i) })),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(confirmedCount(ctx)).toBe(1);
  });

  it("deux types d'événements partageant un agenda : une seule aboutit", async () => {
    const ctx = await createContext({ latencyMs: 20 });
    const a = ctx.repo.getEventTypeBySlug("point-projet")!;
    const b = ctx.repo.getEventTypeBySlug("echange-30-min")!;
    const slotsA = await firstSlots(ctx, a.slug);
    const slotsB = new Set(await firstSlots(ctx, b.slug));
    const start = slotsA.find((s) => slotsB.has(s))!;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => ctx.bookings.create({ eventType: i % 2 ? a : b, start, ...invitee(i) })),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  });

  it("deux connexions SQLite distinctes, comme deux processus : une seule aboutit", async () => {
    const file = path.join(dir, "partage.db");
    const clock = { now: Date.parse("2027-01-04T07:00:00Z") };
    const first = await createContext({ file, latencyMs: 20, clock });
    const second = await createContext({ file, latencyMs: 20, clock, seed: false });
    const et = first.repo.getEventTypeBySlug("echange-30-min")!;
    const [start] = await firstSlots(first, et.slug);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? first : second).bookings.create({ eventType: et, start: start!, ...invitee(i) }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(confirmedCount(first)).toBe(1);
    first.db.close();
    second.db.close();
  });
});
