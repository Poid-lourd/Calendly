import type { Database } from "better-sqlite3";
import { log } from "../lib/log.js";
import { RESERVED_USER_SLUGS, slugFromEmail } from "../lib/slug.js";

export interface MigrationContext {
  // Adresse à qui rattacher les données d'une installation antérieure aux espaces par personne.
  owner: string | null;
}

interface Migration {
  id: number;
  name: string;
  sql?: string;
  run?: (db: Database, ctx: MigrationContext) => void;
  // Reconstruction de table : contraintes de clés étrangères suspendues, puis vérifiées avant validation.
  foreignKeysOff?: boolean;
}

// Espaces par personne : les réglages deviennent ceux de chaque personne, comptes Google, plannings et types
// d'événements lui sont rattachés. La table event_types est reconstruite pour une adresse unique par personne.
function multiUser(db: Database, ctx: MigrationContext): void {
  const now = Date.now();
  db.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  accent_color TEXT NOT NULL DEFAULT '#0d6b52',
  avatar BLOB,
  avatar_type TEXT,
  avatar_updated_at INTEGER,
  signature_event_type_id INTEGER REFERENCES event_types(id) ON DELETE SET NULL,
  signature_max_slots INTEGER NOT NULL DEFAULT 3 CHECK (signature_max_slots BETWEEN 1 AND 4),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE google_accounts ADD COLUMN user_id INTEGER REFERENCES users(id);
ALTER TABLE schedules ADD COLUMN user_id INTEGER REFERENCES users(id);
`);

  const legacy = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM google_accounts) OR EXISTS (SELECT 1 FROM schedules) OR EXISTS (SELECT 1 FROM event_types)
         OR EXISTS (SELECT 1 FROM settings WHERE display_name != '' OR avatar IS NOT NULL) AS v`,
    )
    .get() as { v: number };
  let ownerId: number | null = null;
  if (legacy.v) {
    const email = ctx.owner?.trim().toLowerCase();
    if (!email) throw new Error("Données existantes sans propriétaire : renseignez au moins une adresse dans ADMIN_EMAILS.");
    const base = slugFromEmail(email);
    const slug = RESERVED_USER_SLUGS.has(base) ? `${base}-1` : base;
    ownerId = Number(
      db
        .prepare(
          `INSERT INTO users (email, slug, display_name, accent_color, avatar, avatar_type, avatar_updated_at,
             signature_event_type_id, signature_max_slots, created_at, updated_at)
           SELECT ?, ?, display_name, accent_color, avatar, avatar_type, avatar_updated_at, signature_event_type_id,
             signature_max_slots, ?, ? FROM settings WHERE id = 1`,
        )
        .run(email, slug, now, now).lastInsertRowid,
    );
    db.prepare("UPDATE google_accounts SET user_id = ?").run(ownerId);
    db.prepare("UPDATE schedules SET user_id = ?").run(ownerId);
    log.info("données existantes rattachées", { email, slug });
  }

  db.exec(`
CREATE TABLE event_types_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  location_type TEXT NOT NULL CHECK (location_type IN ('meet', 'phone', 'address', 'text')),
  location_value TEXT NOT NULL DEFAULT '',
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
  destination_calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
  slot_interval_minutes INTEGER,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  min_notice_minutes INTEGER NOT NULL DEFAULT 0,
  max_horizon_days INTEGER NOT NULL DEFAULT 60,
  daily_limit INTEGER,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted')),
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, slug)
);
`);
  const columns = `id, slug, title, description, duration_minutes, location_type, location_value, schedule_id, destination_calendar_id,
    slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes, max_horizon_days, daily_limit,
    visibility, active, position, created_at, updated_at`;
  db.prepare(`INSERT INTO event_types_new (user_id, ${columns}) SELECT ?, ${columns} FROM event_types`).run(ownerId);
  db.exec(`
DROP TABLE event_types;
ALTER TABLE event_types_new RENAME TO event_types;
DROP TABLE settings;
`);
}

// Les migrations sont appliquées dans l'ordre au démarrage. Ne jamais modifier une migration publiée.
export const migrations: Migration[] = [
  {
    id: 1,
    name: "schema initial",
    sql: `
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT '',
  accent_color TEXT NOT NULL DEFAULT '#0d6b52',
  avatar BLOB,
  avatar_type TEXT,
  avatar_updated_at INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO settings (id, updated_at) VALUES (1, 0);

CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'connect')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE google_accounts (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  refresh_token_enc TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
  last_error TEXT,
  connected_at INTEGER NOT NULL,
  synced_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE calendars (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  time_zone TEXT,
  access_role TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  present INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, external_id)
);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE schedule_rules (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (end_minute > start_minute)
);
CREATE INDEX schedule_rules_schedule ON schedule_rules(schedule_id);

CREATE TABLE schedule_overrides (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_minute INTEGER,
  end_minute INTEGER,
  CHECK ((start_minute IS NULL AND end_minute IS NULL) OR (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute))
);
CREATE INDEX schedule_overrides_schedule_date ON schedule_overrides(schedule_id, date);

CREATE TABLE event_types (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  location_type TEXT NOT NULL CHECK (location_type IN ('meet', 'phone', 'address', 'text')),
  location_value TEXT NOT NULL DEFAULT '',
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
  destination_calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
  slot_interval_minutes INTEGER,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  min_notice_minutes INTEGER NOT NULL DEFAULT 0,
  max_horizon_days INTEGER NOT NULL DEFAULT 60,
  daily_limit INTEGER,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted')),
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE event_type_calendars (
  event_type_id INTEGER NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
  PRIMARY KEY (event_type_id, calendar_id)
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY,
  event_type_id INTEGER NOT NULL REFERENCES event_types(id) ON DELETE RESTRICT,
  calendar_id INTEGER REFERENCES calendars(id) ON DELETE SET NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  pending_start_at INTEGER,
  pending_end_at INTEGER,
  title TEXT NOT NULL,
  location_type TEXT NOT NULL,
  location_value TEXT NOT NULL DEFAULT '',
  invitee_name TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_note TEXT NOT NULL DEFAULT '',
  invitee_time_zone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  token_hash TEXT NOT NULL UNIQUE,
  external_event_id TEXT NOT NULL,
  meet_url TEXT,
  cancel_reason TEXT,
  cancelled_by TEXT CHECK (cancelled_by IN ('invitee', 'host')),
  cancelled_at INTEGER,
  rescheduled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (end_at > start_at)
);
CREATE INDEX bookings_start ON bookings(start_at);
CREATE INDEX bookings_calendar_start ON bookings(calendar_id, start_at);
CREATE INDEX bookings_event_type_start ON bookings(event_type_id, start_at);

CREATE TABLE mock_events (
  id INTEGER PRIMARY KEY,
  calendar_external_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  attendees TEXT NOT NULL DEFAULT '[]',
  meet_url TEXT,
  updates_sent INTEGER NOT NULL DEFAULT 0,
  UNIQUE (calendar_external_id, event_id)
);
`,
  },
  {
    id: 2,
    name: "signature de mail",
    sql: `
ALTER TABLE settings ADD COLUMN signature_event_type_id INTEGER REFERENCES event_types(id) ON DELETE SET NULL;
ALTER TABLE settings ADD COLUMN signature_max_slots INTEGER NOT NULL DEFAULT 3 CHECK (signature_max_slots BETWEEN 1 AND 4);
`,
  },
  {
    id: 3,
    name: "nombre de créneaux par plage",
    sql: `
ALTER TABLE schedule_rules ADD COLUMN max_slots INTEGER CHECK (max_slots BETWEEN 1 AND 20);
ALTER TABLE schedule_overrides ADD COLUMN max_slots INTEGER CHECK (max_slots BETWEEN 1 AND 20);
`,
  },
  {
    id: 4,
    name: "espaces par personne",
    run: multiUser,
    foreignKeysOff: true,
  },
];

export function migrate(db: Database, ctx: MigrationContext = { owner: null }): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((r) => (r as { id: number }).id),
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    // PRAGMA foreign_keys est sans effet dans une transaction : il se règle avant.
    if (m.foreignKeysOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        if (m.sql) db.exec(m.sql);
        m.run?.(db, ctx);
        if (m.foreignKeysOff) {
          const problems = db.pragma("foreign_key_check") as unknown[];
          if (problems.length > 0) throw new Error(`Migration ${m.id} : ${problems.length} référence(s) invalide(s)`);
        }
        db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
      }).immediate();
    } finally {
      if (m.foreignKeysOff) db.pragma("foreign_keys = ON");
    }
    log.info("migration appliquée", { id: m.id, name: m.name });
  }
}
