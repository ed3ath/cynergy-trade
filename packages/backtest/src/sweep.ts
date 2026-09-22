/**
 * Parameter sweep CLI (roadmap B2) — grid over FreshMomentum entry thresholds.
 *
 *   pnpm exec tsx packages/backtest/src/sweep.ts [--chain ton,bsc,base] [--min-rows 20] [--min-trades 20]
 *
 * Loads each chain's series ONCE, replays every grid combo, ranks by MEDIAN
 * return (avg is distorted by fat-tail "liquidity collapsed" fantasy exits).
 * Exits are policy-locked (+3% full exit, -10% stop) — only entry gates sweep.
 * Verdict-grade only when the A3 bar holds and days span regimes; treat early
 * output as direction, not tuning truth.
 */
import { DataFreshnessConfigSchema, MarketConfigSchema } from "@autonomous-trader/shared";
import type { Chain } from "@autonomous-trader/shared";
import { Database } from "@autonomous-trader/core";
import type { FreshMomentumParams } from "@autonomous-trader/strategy";
import { loadSeries, runBacktest } from "./index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const chains = (flag("chain") ?? "ton,bsc,base").split(",") as Chain[];
const minRows = parseInt(flag("min-rows") ?? "20", 10);
const minTrades = parseInt(flag("min-trades") ?? "20", 10);
const dbUrl = process.env["DATABASE_URL"] ?? "postgresql://trader:trader@localhost:5432/trader";

// Entry-gate grid — each axis independent, defaults always included as baseline
const GRID: Record<string, number[]> = {
  signalCountMin: [2, 1, 3],
  buySellRatioMin: [1.0, 1.25, 1.5],
  minOpportunityScore: [60, 50, 70],
};

interface Combo {
  params: Required<Pick<FreshMomentumParams, "signalCountMin" | "buySellRatioMin" | "minOpportunityScore">>;
  label: string;
}

function* grid(): Generator<Combo> {
  for (const signalCountMin of GRID.signalCountMin!) {
    for (const buySellRatioMin of GRID.buySellRatioMin!) {
      for (const minOpportunityScore of GRID.minOpportunityScore!) {
        yield {
          params: { signalCountMin, buySellRatioMin, minOpportunityScore },
          label: `sig≥${signalCountMin} ratio≥${buySellRatioMin} score≥${minOpportunityScore}`,
        };
      }
    }
  }
}

const db = new Database(dbUrl, 1, 2);
try {
  await db.connect();
  const series = (await Promise.all(chains.map((c) => loadSeries(db, c, { minRows }))))
    .flat()
    .filter((s) => s.rows.length >= minRows);
  console.log(`\nsweeping ${series.length} tokens over ${[...grid()].length} combos (chains=${chains.join(",")}, ≥${minRows} samples, ranked at ≥${minTrades} trades)`);

  const marketConfig = MarketConfigSchema.parse({});
  const freshnessConfig = DataFreshnessConfigSchema.parse({});

  const rows = [];
  for (const combo of grid()) {
    const r = runBacktest(series, { marketConfig, freshnessConfig, strategyParams: combo.params });
    rows.push({ label: combo.label, ...r });
  }

  const baseline = rows.find((r) => r.label === "sig≥2 ratio≥1 score≥60")!;
  console.log(`\nbaseline (live defaults): ${baseline.trades.length} trades, win ${(baseline.winRate * 100).toFixed(1)}%, avg ${baseline.avgReturnPct.toFixed(2)}%`);
  console.log(`\nranked (combos with ≥${minTrades} trades, by expectancy):`);
  const eligible = rows.filter((r) => r.trades.length >= minTrades)
    .sort((a, b) => median(a.trades) - median(b.trades));
  if (eligible.length === 0) {
    console.log("  none — dataset too thin, lower --min-trades");
  } else {
    for (const r of eligible.slice(0, 15)) {
      console.log(
        `  ${r.label.padEnd(28)} ${String(r.trades.length).padStart(4)} trades  win ${(r.winRate * 100).toFixed(1).padStart(5)}%  avg ${r.avgReturnPct.toFixed(2).padStart(8)}%  med ${median(r.trades).toFixed(2).padStart(7)}%  hold ${(r.avgHoldMinutes / 60).toFixed(1)}h`,
      );
    }
  }
} finally {
  await db.close();
}

/** Median return % — robust to the fat-tail "liquidity collapsed" fantasy exits. */
function median(trades: { returnPct: number }[]): number {
  if (trades.length === 0) return 0;
  const sorted = trades.map((t) => t.returnPct).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
