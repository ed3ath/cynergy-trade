#!/usr/bin/env tsx
/**
 * Database migration runner.
 * Applies SQL migration files in order, tracking applied migrations in a table.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, "../migrations");
const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgresql://trader:trader@localhost:5432/trader";

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL      PRIMARY KEY,
      filename    TEXT        NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>("SELECT filename FROM _migrations ORDER BY id");
  return new Set(rows.map((r) => r.filename));
}

async function runMigrations(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    console.log("Connected to database.");

    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip  ${file}`);
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`  apply ${file} ...`);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`  done  ${file}`);
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    console.log(`\nApplied ${count} migration(s). Database is up to date.`);
  } finally {
    await client.end();
  }
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
