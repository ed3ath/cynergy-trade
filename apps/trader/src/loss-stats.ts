/**
 * Loss statistics for the AI trader's memory — a pure summary over closed
 * trades. Wins/losses are classified by pnlUsd (fees already realized into
 * it); UNKNOWN-shaped rows (no pnl) are ignored.
 */

export interface ClosedTradeLite {
  token: string;
  chain?: string;
  strategyId?: string | null;
  pnlUsd: number;
  pnlPct?: number;
  exitReason?: string | null;
  heldMin?: number;
}

export interface LossStats {
  sampleSize: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  /** mean pnlPct per trade — the number the 80% win-rate goal lives on */
  expectancyPct: number;
  /** exit-reason histogram over LOSING trades, worst avg pnl first */
  lossReasons: { reason: string; count: number; avgPnlPct: number }[];
  /** strategies with ≥3 trades and <40% win rate */
  weakStrategies: { strategyId: string; trades: number; winRatePct: number }[];
  /** tokens losing ≥2 times */
  repeatLoserTokens: string[];
}

export function summarizeClosedTrades(trades: ClosedTradeLite[]): LossStats {
  const rows = trades.filter((t) => Number.isFinite(t.pnlUsd));
  const wins = rows.filter((t) => t.pnlUsd > 0);
  const losses = rows.filter((t) => t.pnlUsd <= 0);
  const pct = (t: ClosedTradeLite): number => (Number.isFinite(t.pnlPct) ? t.pnlPct as number : 0);
  const avg = (xs: ClosedTradeLite[]): number => (xs.length === 0 ? 0 : xs.reduce((s, t) => s + pct(t), 0) / xs.length);

  const byReason = new Map<string, ClosedTradeLite[]>();
  for (const l of losses) {
    const key = ((l.exitReason ?? "unknown").split(":")[0] ?? "").trim().slice(0, 60) || "unknown";
    byReason.set(key, [...(byReason.get(key) ?? []), l]);
  }
  const lossReasons = [...byReason.entries()]
    .map(([reason, ls]) => ({ reason, count: ls.length, avgPnlPct: Math.round(avg(ls) * 10) / 10 }))
    .sort((a, b) => a.avgPnlPct - b.avgPnlPct) // worst first
    .slice(0, 5);

  const byStrategy = new Map<string, ClosedTradeLite[]>();
  for (const r of rows) {
    if (!r.strategyId) continue;
    byStrategy.set(r.strategyId, [...(byStrategy.get(r.strategyId) ?? []), r]);
  }
  const weakStrategies = [...byStrategy.entries()]
    .map(([strategyId, rs]) => ({
      strategyId,
      trades: rs.length,
      winRatePct: Math.round((rs.filter((t) => t.pnlUsd > 0).length / rs.length) * 100),
    }))
    .filter((s) => s.trades >= 3 && s.winRatePct < 40)
    .sort((a, b) => a.winRatePct - b.winRatePct)
    .slice(0, 5);

  const lossCount = new Map<string, number>();
  for (const l of losses) lossCount.set(l.token, (lossCount.get(l.token) ?? 0) + 1);
  const repeatLoserTokens = [...lossCount.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([token]) => token);

  const round1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    sampleSize: rows.length,
    winRatePct: round1((wins.length / (rows.length || 1)) * 100),
    avgWinPct: round1(avg(wins)),
    avgLossPct: round1(avg(losses)),
    expectancyPct: round1(avg(rows)),
    lossReasons,
    weakStrategies,
    repeatLoserTokens,
  };
}
