/**
 * Idempotent migration runner — shared by trader boot and the CLI script.
 * Applies *.sql from a directory in order, tracked in _migrations.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@autonomous-trader/shared";
import type { Database } from "./database.js";

const log = createLogger({ component: "migrations" });

export async function runMigrations(db: Database, migrationsDir: string): Promise<number> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL      PRIMARY KEY,
      filename    TEXT        NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await db.query<{ filename: string }>(
    "SELECT filename FROM _migrations ORDER BY id",
  );
  const applied = new Set(rows.map((r) => r.filename));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), "utf-8");
    await db.transaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
    });
    log.info("Migration applied", { file });
    count++;
  }
  return count;
}
