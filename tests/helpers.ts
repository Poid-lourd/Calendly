import { randomBytes } from "node:crypto";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import type { EventType, User } from "../src/db/types.js";
import { Availability } from "../src/domain/availability.js";
import { Bookings } from "../src/domain/bookings.js";
import { Accounts } from "../src/providers/accounts.js";
import { MockProvider } from "../src/providers/mock.js";
import { seedDemo } from "../src/seed.js";

export const TEST_KEY = randomBytes(32);

// Adresse de connexion de l'espace qui reçoit les données de démonstration.
export const DEMO_OWNER = "admin@exemple.test";

export interface Clock {
  now: number;
}

export async function createContext(opts: { file?: string; latencyMs?: number; clock?: Clock; seed?: boolean } = {}) {
  const clock = opts.clock ?? { now: Date.parse("2027-01-04T07:00:00Z") };
  const now = () => clock.now;
  const db = openDatabase(opts.file ?? ":memory:");
  const repo = new Repo(db, now);
  const provider = new MockProvider(db, { latencyMs: opts.latencyMs ?? 0, now });
  const accounts = new Accounts(repo, provider, TEST_KEY);
  const availability = new Availability(repo, accounts, now);
  const bookings = new Bookings(repo, accounts, availability, new URL("http://localhost:3000"), now);
  if (opts.seed !== false) await seedDemo(repo, accounts, DEMO_OWNER);
  return { clock, db, repo, provider, accounts, availability, bookings };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

// Personne des données de démonstration, relue pour refléter les dernières modifications.
export function demoUser(ctx: Context): User {
  return ctx.repo.getUserByEmail(DEMO_OWNER)!;
}

export function eventType(ctx: Context, slug: string): EventType {
  return ctx.repo.getEventTypeBySlug(demoUser(ctx).id, slug)!;
}

export async function firstSlots(ctx: Context, slug: string, days = 14): Promise<number[]> {
  const et = eventType(ctx, slug);
  const res = await ctx.availability.slots(et, ctx.clock.now, ctx.clock.now + days * 86_400_000, { fresh: true });
  if (!res.ok) throw new Error(res.message);
  return res.slots;
}

// Polices WOFF du paquet Fontsource, comme celles copiées par le build.
export function fontFiles(): string[] {
  const dir = path.resolve("node_modules/@fontsource/ibm-plex-sans/files");
  return [400, 500, 600].flatMap((w) => ["latin", "latin-ext"].map((s) => path.join(dir, `ibm-plex-sans-${s}-${w}-normal.woff`)));
}
