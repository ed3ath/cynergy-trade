/**
 * Database access — one facade, two dialects:
 *  - Postgres: pg Pool (unchanged behaviour; DATABASE_URL=postgresql://…)
 *  - SQLite: node:sqlite, zero-dependency single file (sqlite:… / *.db)
 * Single connection/pool per process. All repositories share it.
 */
import pg from "pg";
import { createLogger, type Logger } from "@autonomous-trader/shared";
import { SqliteDatabase, isSqliteUrl, sqliteFilePath, type Dialect } from "./sqlite-database.js";

/** Row shape shared by both drivers (pg returns NUMERIC as string, SQLite as
 *  number — callers parse with parseFloat/Number, which accept either). */
export interface QueryResultRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [column: string]: any;
}

export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

/** What repositories and transaction callbacks program against — the pg
 *  PoolClient and the SQLite transaction client both satisfy it. */
export interface DbClient {
  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export class Database implements DbClient {
  private pool: pg.Pool | null = null;
  private sqlite: SqliteDatabase | null = null;
  private readonly log: Logger;
  readonly dialect: Dialect;

  constructor(
    private readonly url: string,
    private readonly poolMin = 2,
    private readonly poolMax = 10,
  ) {
    this.log = createLogger({ component: "database" });
    this.dialect = isSqliteUrl(url) ? "sqlite" : "postgres";
  }

  async connect(): Promise<void> {
    if (this.pool || this.sqlite) return;

    if (this.dialect === "sqlite") {
      const file = sqliteFilePath(this.url);
      this.sqlite = new SqliteDatabase(file);
      this.sqlite.open();
      this.log.info("Database connected", { dialect: "sqlite", file });
      return;
    }

    this.pool = new pg.Pool({
      connectionString: this.url,
      min: this.poolMin,
      max: this.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Fail fast if DB unreachable
    await this.pool.query("SELECT 1");
    this.log.info("Database connected", { dialect: "postgres" });
  }

  async close(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
      this.log.info("Database closed");
      return;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.log.info("Database closed");
    }
  }

  get connected(): boolean {
    return this.pool !== null || this.sqlite !== null;
  }

  async query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    if (this.sqlite) return this.sqlite.query<T>(sql, params);
    if (!this.pool) throw new Error("Database not connected — call connect() first");
    const res = await this.pool.query<T>(sql, params as never[]);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  /** Run inside a transaction. Rolls back on throw. */
  async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    if (this.sqlite) return this.sqlite.transaction(fn);
    if (!this.pool) throw new Error("Database not connected");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn({
        query: async <R extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<R>> => {
          const res = await client.query<R>(sql, params as never[]);
          return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
