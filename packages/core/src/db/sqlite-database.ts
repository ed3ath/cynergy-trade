/**
 * SQLite backend for the Database facade — `node:sqlite` (DatabaseSync),
 * built into Node ≥ 22.5: no native module, no server, one file on disk.
 *
 * Journal SQL is written in Postgres dialect; translateSqlite() rewrites the
 * handful of PG-isms at the driver boundary so repositories stay dialect-
 * agnostic. Row shape parity with pg: NUMERIC/REAL columns come back as JS
 * numbers (journal parses them with parseFloat/Number), timestamps are stored
 * as ISO-8601 UTC TEXT (identical fixed width to JS toISOString and to
 * strftime('%f') output, so lexicographic comparison/ordering matches), and
 * big-integer columns (size_tokens, actual_input/output, …) are declared TEXT
 * so arbitrarily large quantities round-trip as exact digit strings.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "./node-sqlite.js";
import type { DbClient, QueryResult, QueryResultRow } from "./database.js";

export type Dialect = "postgres" | "sqlite";

/** Dialect of a DATABASE_URL: `sqlite:`/`file:` scheme or a db file path. */
export function isSqliteUrl(url: string): boolean {
  return /^(sqlite|file):/i.test(url) || /\.(db|sqlite3?)$/i.test(url);
}

/** `sqlite:data/trader.db` → `data/trader.db`.
 *  ponytail: `sqlite:`/`file:` scheme + plain paths only — file: URI
 *  authorities (file://host/path) are not parsed. */
export function sqliteFilePath(url: string): string {
  return url.replace(/^(sqlite|file):/i, "").replace(/^\/{2}/, "");
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Rewrite Postgres-only constructs to SQLite. Input SQL must not be mutated
 *  elsewhere — this is the single translation point. */
export function translateSqlite(sql: string): string {
  let out = sql;
  // NOW() - ($n || ' minutes')::interval → computed datetime modifier; the
  // bound param is a numeric string ("30" → '-30 minutes').
  out = out.replace(
    /NOW\(\)\s*-\s*\(\s*(\$\d+)\s*\|\|\s*' minutes'\s*\)::interval/gi,
    (_m, param: string) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ${param} || ' minutes')`,
  );
  // to_char(expr, 'YYYY-MM-DD') → strftime (both yield the ISO date part).
  out = out.replace(/to_char\(([^,]+),\s*'YYYY-MM-DD'\)/gi, (_m, expr: string) => `strftime('%Y-%m-%d', ${expr})`);
  // NOW() → current UTC timestamp, same fixed width as Date.toISOString().
  out = out.replace(/\bNOW\(\)/g, NOW_SQL);
  // PG casts ($n::timestamptz, expr::chain_type, …) — SQLite casts are
  // no-ops for our column affinities; strip them.
  out = out.replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, "");
  // SELECT … FOR UPDATE — single connection, writes are serialized by the
  // driver queue; journal-level guards already serialize position writes.
  out = out.replace(/\s+FOR\s+UPDATE\b/gi, "");
  // LIMIT $n with a null param → "datatype mismatch" in SQLite; COALESCE
  // restores Postgres semantics (null = unlimited).
  out = out.replace(/\bLIMIT\s+(\$\d+)/gi, (_m, param: string) => `LIMIT COALESCE(${param}, 9223372036854775807)`);
  // PG-only DISTINCT ON (x) x → plain DISTINCT (same result when the select
  // list is that column — backtest holders/security preload).
  out = out.replace(
    /SELECT\s+DISTINCT\s+ON\s*\(\s*([a-zA-Z_][\w]*)\s*\)\s*\1\b/gi,
    "SELECT DISTINCT $1",
  );
  return out;
}

function coerceParam(value: unknown): string | number | Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  // bigint → exact digit string: TEXT columns keep every digit, NUMERIC
  // columns apply affinity. (Binding bigint natively fails beyond int64.)
  if (typeof value === "bigint") return value.toString();
  // PG TEXT[] columns are JSON text here.
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  // Callers stringify their own JSON; belt and braces for stray objects.
  return JSON.stringify(value) ?? null;
}

/** node:sqlite binds named params by exact key set: extra keys throw, missing
 *  keys silently bind NULL — so build the object from the SQL's own $n refs. */
function collectParams(sql: string, params: unknown[]): Record<string, string | number | Uint8Array | null> {
  const named: Record<string, string | number | Uint8Array | null> = {};
  for (const match of sql.matchAll(/\$(\d+)/g)) {
    const n = String(Number(match[1]));
    if (n in named) continue;
    named[n] = coerceParam(params[Number(match[1]) - 1]);
  }
  return named;
}

/** Comment/string-aware check for statement-terminating semicolons.
 *  ponytail: `--` inside a string literal would confuse it; no journal SQL
 *  contains one. Multi-statement SQL (migrations) never carries params. */
function hasMultipleStatements(sql: string): boolean {
  const stripped = sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
  return /;\s*\S/.test(stripped);
}

function isBlank(sql: string): boolean {
  return sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''").trim().length === 0;
}

/** Statement classes that produce rows (all()); everything else uses run()
 *  so rowCount reflects `changes` — Postgres parity for ON CONFLICT DO NOTHING
 *  (returns [] via RETURNING on conflict → rowCount 0). */
function returnsRows(sql: string): boolean {
  return /^\s*(?:SELECT|WITH|PRAGMA|VALUES)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

/**
 * Serialised single-connection backend: SQLite has one writer, and a query
 * issued while another caller's transaction is open must not silently join
 * (and roll back with) that transaction — so every query and transaction
 * runs through one FIFO queue. Inside a transaction, `client.query` executes
 * directly (it is already the queue's current task).
 */
export class SqliteDatabase {
  // Type-only (erased at runtime) — the value comes from ./node-sqlite.js.
  private handle: import("node:sqlite").DatabaseSync | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  open(): void {
    if (this.handle) return;
    mkdirSync(dirname(this.filePath) || ".", { recursive: true });
    const handle = new DatabaseSync(this.filePath, { enableForeignKeyConstraints: true });
    handle.exec("PRAGMA foreign_keys = ON");
    if (this.filePath !== ":memory:") {
      // Crash-safe journal file; best-effort (fs without WAL support → skip).
      try { handle.exec("PRAGMA journal_mode = WAL"); } catch { /* ponytail: keep default journal */ }
    }
    this.handle = handle;
  }

  close(): void {
    this.handle?.close();
    this.handle = null;
  }

  get connected(): boolean {
    return this.handle !== null;
  }

  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.enqueue(() => this.execute<T>(sql, params));
  }

  async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const run = this.enqueue(async () => {
      const handle = this.require();
      const client: DbClient = {
        query: <R extends QueryResultRow>(sql: string, p?: unknown[]): Promise<QueryResult<R>> =>
          Promise.resolve(this.execute<R>(sql, p)),
      };
      handle.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(client);
        handle.exec("COMMIT");
        return result;
      } catch (err) {
        try { handle.exec("ROLLBACK"); } catch { /* connection already gone */ }
        throw err;
      }
    });
    // A rejection must not wedge the queue for later tasks.
    void run.catch(() => undefined);
    return run;
  }

  private enqueue<R>(task: () => R | Promise<R>): Promise<R> {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private require(): import("node:sqlite").DatabaseSync {
    if (!this.handle) throw new Error("Database not connected — call connect() first");
    return this.handle;
  }

  private execute<T extends QueryResultRow>(sql: string, params?: unknown[]): QueryResult<T> {
    const handle = this.require();
    const translated = translateSqlite(sql);
    if (isBlank(translated)) return { rows: [], rowCount: 0 };
    const wantsParams = (params?.length ?? 0) > 0 && Object.keys(collectParams(translated, params!)).length > 0;

    if (hasMultipleStatements(translated)) {
      if (wantsParams) throw new Error("SQLite: multi-statement SQL cannot carry parameters");
      handle.exec(translated);
      return { rows: [], rowCount: 0 };
    }

    const stmt = handle.prepare(translated);
    if (wantsParams) {
      const named = collectParams(translated, params!);
      if (returnsRows(translated)) {
        const rows = stmt.all(named) as T[];
        return { rows, rowCount: rows.length };
      }
      const res = stmt.run(named);
      return { rows: [], rowCount: Number(res.changes) };
    }
    if (returnsRows(translated)) {
      const rows = stmt.all() as T[];
      return { rows, rowCount: rows.length };
    }
    const res = stmt.run();
    return { rows: [], rowCount: Number(res.changes) };
  }
}
