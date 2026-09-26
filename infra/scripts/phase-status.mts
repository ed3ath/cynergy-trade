/**
 * Phase-gate status — one read-only report for the roadmap counters.
 * Run: pnpm exec tsx infra/scripts/phase-status.mts
 *
 *   A1 closed paper trades     (bar: ≥30)
 *   A2 shadow signals          (bar: ≥30 evaluated)
 *   A3 snapshot depth per chain(bar: ≥50 tokens × ≥20 samples, ≥3d)
 *   C2 fill calibration        (paper vs real STON quote delta)
 *   B   backtest expectancy    → pnpm exec tsx packages/backtest/src/cli.ts
 */
// ESM from infra/ can't resolve workspace packages (no node_modules here) —
// import the built core directly. Rebuild packages/core after touching its exports.
import { Database } from "../../packages/core/dist/index.js";

const db = new Database(process.env["DATABASE_URL"] ?? "sqlite:data/trader.db");
await db.connect();

const q = async <T>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;

console.log("── A1 · closed paper trades (bar ≥30) ──");
for (const r of await q<{ chain: string; n: string; realized: string }>(
  `SELECT chain, COUNT(*) AS n, COALESCE(SUM(realized_pnl_usd),0) AS realized
   FROM positions WHERE status='CLOSED' GROUP BY chain`,
)) {
  console.log(`  ${r.chain.padEnd(7)} ${r.n} closed, realized $${parseFloat(String(r.realized)).toFixed(2)}`);
}

console.log("\n── A2 · shadow signals (bar ≥30 evaluated) ──");
for (const r of await q<{ total: string; evaluated: string; avg: string | null; win: string | null }>(
  `SELECT COUNT(*) AS total, COUNT(evaluated_at) AS evaluated,
          ROUND(AVG(outcome_return_pct),2) AS avg,
          ROUND(100.0*COUNT(*) FILTER (WHERE outcome_return_pct>0)/NULLIF(COUNT(evaluated_at),0),1) AS win
   FROM shadow_decisions`,
)) {
  console.log(`  ${r.evaluated}/${r.total} evaluated · avg ${r.avg ?? "–"}% · win ${r.win ?? "–"}%`);
}

console.log("\n── A3 · snapshot coverage (bar ≥50 tokens × ≥20 samples, ≥3d) ──");
for (const r of await q<{ chain: string; rows: string; tokens: string; deep: string; span: string; first: Date; last: Date }>(
  `SELECT chain, COUNT(*) AS rows, COUNT(DISTINCT token_address) AS tokens,
          COUNT(DISTINCT CASE WHEN n>=20 THEN token_address END) AS deep,
          to_char(MIN(observed_at),'YYYY-MM-DD') || ' → ' || to_char(MAX(observed_at),'YYYY-MM-DD') AS span,
          MIN(observed_at) AS first, MAX(observed_at) AS last
   FROM (SELECT *, COUNT(*) OVER (PARTITION BY chain, token_address) AS n
         FROM token_market_snapshots) s
   GROUP BY chain`,
)) {
  const days = (new Date(r.last).getTime() - new Date(r.first).getTime()) / 86_400_000;
  console.log(`  ${r.chain.padEnd(7)} ${r.tokens} tokens (${r.deep} ≥20 samples) · ${r.rows} rows · ${days.toFixed(1)}d ${r.span}`);
}

console.log("\n── C2 · fill calibration (paper vs real STON quote) ──");
for (const r of await q<{ side: string; n: string; delta: string | null; impact: string | null }>(
  `SELECT side, COUNT(*) AS n,
          ROUND(AVG(paper_price/NULLIF(quote_price,0)-1)*100,2) AS delta,
          ROUND(AVG(quote_price_impact_bps),0) AS impact
   FROM fill_calibration GROUP BY side`,
)) {
  console.log(`  ${r.side.padEnd(4)} ${r.n} rows · paper vs real ${r.delta ?? "–"}% · avg impact ${r.impact ?? "–"}bps`);
}
const noQuote = (await q<{ n: number | string }>(`SELECT COUNT(*) AS n FROM fill_calibration WHERE quote_price IS NULL`))[0];
if (noQuote && Number(noQuote.n) > 0) console.log(`  ⚠ ${noQuote.n} rows with failed quotes (see quote_error)`);

await db.close();
