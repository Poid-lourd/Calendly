import type { Context } from "hono";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import type { Availability } from "../domain/availability.js";
import type { Bookings } from "../domain/bookings.js";
import type { Accounts } from "../providers/accounts.js";
import type { MockProvider } from "../providers/mock.js";
import type { CalendarProvider } from "../providers/types.js";
import type { RateLimiter } from "./ratelimit.js";
import type { SignatureRenderer } from "./signature.js";

export interface Assets {
  // Chemins publics des fichiers générés (avec hash).
  css: string;
  booking: string;
  admin: string;
  // Dossier servi sous /assets.
  dir: string | null;
}

export interface Deps {
  config: Config;
  repo: Repo;
  provider: CalendarProvider;
  mock: MockProvider | null;
  accounts: Accounts;
  availability: Availability;
  bookings: Bookings;
  limiter: RateLimiter;
  signature: SignatureRenderer;
  assets: Assets;
  now: () => number;
}

export interface Env {
  Variables: {
    deps: Deps;
    csrf: string;
    admin: { email: string } | null;
  };
}

export type Ctx = Context<Env>;

// Valeur textuelle d'un champ de formulaire (première occurrence).
export function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  const first = Array.isArray(v) ? (v[0] as unknown) : v;
  return typeof first === "string" ? first : "";
}

// Toutes les valeurs textuelles d'un champ répété.
export function fields(body: Record<string, unknown>, name: string): string[] {
  const v = body[name];
  const list = Array.isArray(v) ? (v as unknown[]) : v === undefined ? [] : [v];
  return list.filter((x): x is string => typeof x === "string");
}
