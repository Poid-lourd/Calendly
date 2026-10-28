import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export type DB = Database.Database;

// owner : adresse à qui rattacher les données d'une installation antérieure aux espaces par personne.
export function openDatabase(file: string, opts: { owner?: string | null } = {}): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db, { owner: opts.owner ?? null });
  return db;
}
