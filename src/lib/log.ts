// Journal JSON sur la sortie standard, une ligne par entrée.
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < order[threshold]) return;
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      entry[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
    }
  }
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
