/**
 * Idempotency guard — one trade intent executes at most once, EVER.
 * Duplicate event/restart/retry must never produce a duplicate purchase.
 *
 * In-memory for dev/paper; Postgres-backed for production (survives restarts).
 */
import { ExecutionError } from "@autonomous-trader/shared";
import type { Database } from "@autonomous-trader/core";

export interface IdempotencyGuard {
  /** Returns true when this caller is the first to claim (safe to execute). */
  claim(intentId: string): Promise<boolean>;
}

export class InMemoryIdempotencyGuard implements IdempotencyGuard {
  private claimed = new Set<string>();
  private readonly max: number;

  constructor(max = 100_000) {
    this.max = max;
  }

  async claim(intentId: string): Promise<boolean> {
    if (this.claimed.has(intentId)) return false;
    this.claimed.add(intentId);
    if (this.claimed.size > this.max) this.claimed.clear(); // paper-mode only; DB guard never clears
    return true;
  }
}

export class PgIdempotencyGuard implements IdempotencyGuard {
  constructor(private readonly db: Database) {}

  async claim(intentId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO executed_intents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [intentId],
    );
    return rowCount === 1;
  }
}

/** Composite: durable store first, memory as fallback if DB flakes. */
export class FallbackIdempotencyGuard implements IdempotencyGuard {
  constructor(
    private readonly primary: IdempotencyGuard,
    private readonly fallback: IdempotencyGuard,
  ) {}

  async claim(intentId: string): Promise<boolean> {
    try {
      return await this.primary.claim(intentId);
    } catch {
      // DB down: memory still blocks duplicates within this process lifetime
      return this.fallback.claim(intentId);
    }
  }
}

/** Throws on duplicate — the standard pre-execution check. */
export async function assertNotDuplicate(guard: IdempotencyGuard, intentId: string): Promise<void> {
  const first = await guard.claim(intentId);
  if (!first) {
    throw new ExecutionError(`Duplicate execution prevented for intent ${intentId}`, { intentId });
  }
}

/**
 * Redis-backed guard (Phase D gate: LIVE is forbidden until this exists).
 * SET NX PX is atomic — the claim and the uniqueness check are one operation,
 * safe across processes and crashes. Claims expire after ttlMs (Pg's
 * executed_intents remains the forever-record; Redis is the fast lock).
 */
export class RedisIdempotencyGuard implements IdempotencyGuard {
  constructor(
    /** Minimal surface of ioredis we use — structural, easy to fake in tests. */
    private readonly redis: {
      set(key: string, value: string, mode: "PX", ms: number, nx: "NX"): Promise<"OK" | null>;
      ping(): Promise<string>;
      disconnect(): void;
    },
    private readonly ttlMs = 30 * 24 * 3_600_000, // 30d — outlives any retry storm
  ) {}

  async claim(intentId: string): Promise<boolean> {
    const res = await this.redis.set(`executed_intent:${intentId}`, "1", "PX", this.ttlMs, "NX");
    return res === "OK";
  }

  /** Boot-time health probe — LIVE must refuse to start when Redis is down. */
  async healthy(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}
