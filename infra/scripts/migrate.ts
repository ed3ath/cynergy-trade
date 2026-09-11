#!/usr/bin/env tsx
/** CLI migration runner — same implementation the trader uses at boot. */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Database, runMigrations } from "@autonomous-trader/core";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, "../migrations");
const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgresql://trader:trader@localhost:5432/trader";

const db = new Database(DATABASE_URL);
try {
  await db.connect();
  const n = await runMigrations(db, MIGRATIONS_DIR);
  console.log(`Applied ${n} migration(s). Database is up to date.`);
} finally {
  await db.close();
}
