// Sauvegarde à chaud de la base SQLite (API de sauvegarde en ligne, compatible WAL).
// Usage : node scripts/backup.mjs [fichier-destination]
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const source = path.join(dataDir, "app.db");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const target = path.resolve(process.argv[2] ?? path.join(dataDir, "backups", `app-${stamp}.db`));
mkdirSync(path.dirname(target), { recursive: true });

const db = new Database(source, { readonly: true, fileMustExist: true });
await db.backup(target);
db.close();

const copy = new Database(target, { readonly: true });
const check = copy.pragma("integrity_check", { simple: true });
copy.close();
if (check !== "ok") {
  console.error(`Sauvegarde corrompue : ${String(check)}`);
  process.exit(1);
}
console.log(target);
