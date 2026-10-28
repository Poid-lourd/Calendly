import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { migrate, migrations } from "../../src/db/migrations.js";
import { Repo } from "../../src/db/repo.js";

// Base dans l'état d'une installation antérieure aux espaces par personne (migrations 1 à 3).
function legacyDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  for (const m of migrations.filter((m) => m.id <= 3)) {
    db.exec(m.sql!);
    db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 0)").run(m.id, m.name);
  }
  db.exec(`
UPDATE settings SET display_name = 'Pierre-Louis', accent_color = '#123456';
INSERT INTO google_accounts (id, subject, email, scopes, status, connected_at, updated_at) VALUES (1, 's', 'moi@gmail.com', '', 'connected', 0, 0);
INSERT INTO calendars (id, account_id, external_id, summary, access_role, is_primary, updated_at) VALUES (1, 1, 'moi@gmail.com', 'moi', 'owner', 1, 0);
INSERT INTO schedules (id, name, time_zone, created_at, updated_at) VALUES (1, 'Semaine', 'Europe/Zurich', 0, 0);
INSERT INTO event_types (id, slug, title, duration_minutes, location_type, schedule_id, destination_calendar_id, visibility, created_at, updated_at)
  VALUES (1, 'echange', 'Échange', 30, 'meet', 1, 1, 'public', 0, 0);
INSERT INTO event_type_calendars (event_type_id, calendar_id) VALUES (1, 1);
UPDATE settings SET signature_event_type_id = 1;
INSERT INTO bookings (id, event_type_id, calendar_id, start_at, end_at, title, location_type, invitee_name, invitee_email, invitee_time_zone,
  status, token_hash, external_event_id, created_at, updated_at)
  VALUES (1, 1, 1, 1000, 2000, 'Échange', 'meet', 'Jeanne', 'j@exemple.fr', 'Europe/Paris', 'confirmed', 'h', 'e', 0, 0);
`);
  return db;
}

describe("migrations", () => {
  it("s'appliquent une seule fois", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const n = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(n.n).toBe(migrations.length);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("rattachent une installation existante à la première adresse autorisée", () => {
    const db = legacyDatabase();
    migrate(db, { owner: "Moi@Gmail.com" });
    const repo = new Repo(db);
    const user = repo.getUserByEmail("moi@gmail.com")!;
    expect(user).toMatchObject({ slug: "moi", displayName: "Pierre-Louis", accentColor: "#123456", signatureEventTypeId: 1 });
    expect(repo.listAccounts(user.id).map((a) => a.email)).toEqual(["moi@gmail.com"]);
    expect(repo.listSchedules(user.id).map((s) => s.name)).toEqual(["Semaine"]);
    const et = repo.getEventTypeBySlug(user.id, "echange")!;
    expect(et).toMatchObject({ id: 1, userId: user.id, blockingCalendarIds: [1] });
    expect(repo.getBooking(1)?.eventTypeId).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refusent de reprendre des données sans propriétaire", () => {
    const db = legacyDatabase();
    expect(() => migrate(db)).toThrow(/ADMIN_EMAILS/);
    // Rien n'est appliqué : la base reste dans son état antérieur.
    expect(db.prepare("SELECT MAX(id) AS id FROM schema_migrations").get()).toEqual({ id: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
