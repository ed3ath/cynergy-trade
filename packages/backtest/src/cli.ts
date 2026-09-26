/**
 * Backtest CLI — replay the recorded snapshot dataset.
 *
 *   pnpm exec tsx packages/backtest/src/cli.ts [--chain ton] [--min-rows 20] [--regime BULL]
 *
 * Prints per-token trades and aggregate expectancy. This answers "what would
 * FreshMomentum have done on the recorded data" — NOT a tuning verdict until
 * the Phase-B data gate (≥50 tokens × ≥20 samples) is met.
 */
import { DataFreshnessConfigSchema, MarketConfigSchema } from "@autonomous-trader/shared";
import type { MarketRegime } from "@autonomous-trader/shared";
import { Database } from "@autonomous-trader/core";
import { loadSeries, runBacktest } from "./index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const chain = (flag("chain") ?? "ton") as "ton" | "solana";
const minRows = parseInt(flag("min-rows") ?? "20", 10);
// Fixed regime for the whole run (roadmap B3). Real conditioning needs
// regime_history rows joined by entry time — until that table has data, this
// only measures strategy gate behavior across regimes.
const regime = flag("regime") as MarketRegime | undefined;
const dbUrl = process.env["DATABASE_URL"] ?? "sqlite:data/trader.db";

const db = new Database(dbUrl, 1, 2);
try {
  await db.connect();
  const series = await loadSeries(db, chain, { minRows });
  const withEnough = series.filter((s) => s.rows.length >= minRows);
  console.log(`\nreplaying ${withEnough.length} tokens (chain=${chain}, ≥${minRows} samples each${regime ? `, regime=${regime}` : ""})`);

  const result = runBacktest(withEnough, {
    marketConfig: MarketConfigSchema.parse({}),
    freshnessConfig: DataFreshnessConfigSchema.parse({}),
    ...(regime ? { regime } : {}),
  });

  console.log(`\ntrades: ${result.trades.length} on ${result.tokensWithTrades}/${result.totalTokens} tokens`);
  console.log(`win rate: ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`avg return/trade: ${result.avgReturnPct.toFixed(2)}%  (expectancy)`);
  console.log(`avg hold: ${(result.avgHoldMinutes / 60).toFixed(1)}h`);
  console.log("\nby exit reason:");
  for (const [reason, r] of Object.entries(result.byExitReason).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(r.count).padStart(4)}x  avg ${r.avgReturnPct.toFixed(2).padStart(7)}%  ${reason}`);
  }
  console.log("\nper-token:");
  for (const [token, ts] of Object.entries(groupByToken(result.trades))) {
    const avg = ts.reduce((s, t) => s + t.returnPct, 0) / ts.length;
    console.log(`  ${token.slice(0, 12)}… ${String(ts.length).padStart(3)} trades  avg ${avg.toFixed(2).padStart(7)}%`);
  }
} finally {
  await db.close();
}

function groupByToken(trades: { token: string; returnPct: number }[]) {
  const by: Record<string, { token: string; returnPct: number }[]> = {};
  for (const t of trades) (by[t.token] ??= []).push(t);
  return by;
}
