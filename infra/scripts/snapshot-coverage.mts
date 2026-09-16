#!/usr/bin/env tsx
/**
 * Snapshot coverage audit (roadmap Phase A3): is the backtester dataset ready?
 * Read-only. Rerun anytime: pnpm exec tsx infra/scripts/snapshot-coverage.mts
 */
import pg from "pg";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://trader:trader@localhost:5432/trader";

// Phase-B bar from docs/roadmap.md — change it there first, then here.
const MIN_TOKENS = 50;
const MIN_SAMPLES = 20;
const MIN_DAYS = 3;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await pool.query(sql, params)).rows as T[];

try {
  const totals = await q<{ chain: string; rows: string; tokens: string; first: Date; last: Date }>(
    `SELECT chain, COUNT(*) AS rows, COUNT(DISTINCT token_address) AS tokens,
            MIN(observed_at) AS first, MAX(observed_at) AS last
     FROM token_market_snapshots GROUP BY chain`,
  );
  const covered = await q<{ token_address: string; samples: string; first: Date; last: Date }>(
    `SELECT token_address, COUNT(*) AS samples, MIN(observed_at) AS first, MAX(observed_at) AS last
     FROM token_market_snapshots GROUP BY token_address
     HAVING COUNT(*) >= $1 ORDER BY COUNT(*) DESC`,
    [MIN_SAMPLES],
  );

  console.log("Snapshot coverage by chain:");
  let maxSpanDays = 0;
  for (const r of totals) {
    const span = (new Date(r.last).getTime() - new Date(r.first).getTime()) / 86_400_000;
    maxSpanDays = Math.max(maxSpanDays, span);
    console.log(
      `  ${r.chain.padEnd(7)} rows ${r.rows.padStart(7)}  tokens ${r.tokens.padStart(4)}  ` +
      `span ${span.toFixed(1)}d  (${new Date(r.first).toISOString().slice(0, 10)} → ${new Date(r.last).toISOString().slice(0, 10)})`,
    );
  }

  console.log(`\nTokens with ≥${MIN_SAMPLES} samples: ${covered.length}`);
  for (const r of covered.slice(0, 15)) {
    console.log(
      `  ${r.token_address.slice(0, 10)}…  ${r.samples.padStart(5)} samples  ` +
      `${new Date(r.first).toISOString().slice(0, 16)} → ${new Date(r.last).toISOString().slice(0, 16)}`,
    );
  }
  if (covered.length > 15) console.log(`  … +${covered.length - 15} more`);

  const ready = covered.length >= MIN_TOKENS && maxSpanDays >= MIN_DAYS;
  console.log(
    `\nPhase-B bar: ≥${MIN_TOKENS} tokens × ${MIN_SAMPLES} samples over ≥${MIN_DAYS}d → ` +
    (ready ? "READY — start the backtester" : "NOT YET — keep the paper run going"),
  );
} finally {
  await pool.end();
}
