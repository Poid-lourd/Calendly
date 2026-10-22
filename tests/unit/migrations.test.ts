import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { migrate } from "../../src/db/migrations.js";

describe("migrations", () => {
  it("s'appliquent une seule fois", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const n = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(n.n).toBeGreaterThan(0);
    expect(db.prepare("SELECT id FROM settings").all()).toEqual([{ id: 1 }]);
  });
});
