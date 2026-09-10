/**
 * Database access — pg Pool wrapper.
 * Single pool per process. All repositories share it.
 */
import pg from "pg";
import { createLogger, type Logger } from "@autonomous-trader/shared";

export class Database {
  private pool: pg.Pool | null = null;
  private readonly log: Logger;

  constructor(
    private readonly url: string,
    private readonly poolMin = 2,
    private readonly poolMax = 10,
  ) {
    this.log = createLogger({ component: "database" });
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = new pg.Pool({
      connectionString: this.url,
      min: this.poolMin,
      max: this.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Fail fast if DB unreachable
    await this.pool.query("SELECT 1");
    this.log.info("Database connected");
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.log.info("Database closed");
    }
  }

  get connected(): boolean {
    return this.pool !== null;
  }

  query<T extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
    if (!this.pool) throw new Error("Database not connected — call connect() first");
    return this.pool.query<T>(sql, params as never[]);
  }

  /** Run inside a transaction. Rolls back on throw. */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error("Database not connected");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
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
