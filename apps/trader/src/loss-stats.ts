/** Pure feedback over completed positions supplied by the host, never partial fills.
 * pnlUsd must be cumulative trading NET; do not deduct fees/slippage again here.
 * The host owns the corrected PAPER namespace and new-close learning gate.
 */

export interface ClosedTradeLite {
  token: string;
  chain?: string;
  mode?: string;
  accountingVersion?: number;
  dataQuality?: readonly string[];
  strategyId?: string | null;
  pnlUsd: number;
  pnlPct?: number;
  exitReason?: string | null;
  heldMin?: number;
}

export interface LossStats {
  sampleSize: number;
  winRatePct: number;
  breakevens: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Mean of observed percentages only; null when nonempty rows have none. */
  expectancyPct: number | null;
  percentageSampleSize: number;
  netPnlUsd: number;
  expectancyUsd: number;
  profitFactor: number | null;
  invalidPnlRows: number;
  legacyRows: number;
  unverifiedRows: number;
  /** A supplied recent-history window is not lifetime evidence. */
  scope: "supplied-completed-positions";
  feedbackEligible: boolean;
  evaluationStatus: "insufficient-samples" | "cohort-only" | "not-validated";
  costCaution: string;
  /** exit-reason histogram over LOSING trades, worst avg pnl first */
  lossReasons: { reason: string; count: number; avgPnlPct: number | null }[];
  /** strategies with ≥3 trades and <40% win rate */
  weakStrategies: { strategyId: string; trades: number; winRatePct: number; mode?: string; chain?: string; accountingVersion?: number }[];
  /** Tokens losing >=2 times within the SAME mode/chain/accounting cohort. */
  repeatLoserTokens: string[];
  cohorts: {
    mode: string;
    chain: string;
    strategyId: string;
    accountingVersion: number;
    sampleSize: number;
    netPnlUsd: number;
    expectancyUsd: number;
    profitFactor: number | null;
    winRatePct: number;
    evaluationStatus: "insufficient-samples" | "not-validated";
  }[];
}

export function summarizeClosedTrades(trades: ClosedTradeLite[]): LossStats {
  const rows = trades.filter((t) => Number.isFinite(t.pnlUsd));
  const wins = rows.filter((t) => t.pnlUsd > 0);
  const losses = rows.filter((t) => t.pnlUsd < 0);
  const avg = (xs: ClosedTradeLite[]): number | null => {
    const known = xs.filter((t) => Number.isFinite(t.pnlPct));
    return known.length ? known.reduce((s, t) => s + (t.pnlPct as number), 0) / known.length : xs.length ? null : 0;
  };
  const round1 = (n: number | null): number | null => n === null ? null : Math.round(n * 10) / 10;
  const net = (xs: ClosedTradeLite[]): number => xs.reduce((s, t) => s + t.pnlUsd, 0);
  const profitFactor = (xs: ClosedTradeLite[]): number | null => {
    const lost = -net(xs.filter((t) => t.pnlUsd < 0));
    return lost > 0 ? net(xs.filter((t) => t.pnlUsd > 0)) / lost : null;
  };

  const byReason = new Map<string, ClosedTradeLite[]>();
  for (const l of losses) {
    const key = ((l.exitReason ?? "unknown").split(":")[0] ?? "").trim().slice(0, 60) || "unknown";
    byReason.set(key, [...(byReason.get(key) ?? []), l]);
  }
  const lossReasons = [...byReason.entries()]
    .map(([reason, ls]) => ({ reason, count: ls.length, avgPnlPct: round1(avg(ls)) }))
    .sort((a, b) => (a.avgPnlPct ?? Infinity) - (b.avgPnlPct ?? Infinity)) // known worst first
    .slice(0, 5);

  const byStrategy = new Map<string, ClosedTradeLite[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.mode ?? "unknown", r.chain ?? "unknown", r.strategyId ?? "unknown", r.accountingVersion ?? 1]);
    byStrategy.set(key, [...(byStrategy.get(key) ?? []), r]);
  }
  const weakStrategies = [...byStrategy.values()]
    .filter((rs) => rs[0]?.strategyId)
    .map((rs) => ({
      strategyId: rs[0]!.strategyId!,
      ...(rs[0]!.mode !== undefined ? { mode: rs[0]!.mode } : {}),
      ...(rs[0]!.chain !== undefined ? { chain: rs[0]!.chain } : {}),
      ...(rs[0]!.accountingVersion !== undefined ? { accountingVersion: rs[0]!.accountingVersion } : {}),
      trades: rs.length,
      winRatePct: Math.round((rs.filter((t) => t.pnlUsd > 0).length / rs.length) * 100),
    }))
    .filter((s) => s.trades >= 3 && s.winRatePct < 40)
    .sort((a, b) => a.winRatePct - b.winRatePct)
    .slice(0, 5);

  const lossCount = new Map<string, { token: string; count: number }>();
  for (const l of losses) {
    const key = JSON.stringify([l.mode ?? "unknown", l.chain ?? "unknown", l.accountingVersion ?? 1, l.token]);
    lossCount.set(key, { token: l.token, count: (lossCount.get(key)?.count ?? 0) + 1 });
  }
  const repeatLoserTokens = [...lossCount.values()]
    .filter((r) => r.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((r) => r.token);

  const cohorts = [...byStrategy.values()].map((rs) => ({
    mode: rs[0]!.mode ?? "unknown",
    chain: rs[0]!.chain ?? "unknown",
    strategyId: rs[0]!.strategyId ?? "unknown",
    accountingVersion: rs[0]!.accountingVersion ?? 1,
    sampleSize: rs.length,
    netPnlUsd: net(rs),
    expectancyUsd: net(rs) / rs.length,
    profitFactor: profitFactor(rs),
    winRatePct: Math.round(rs.filter((t) => t.pnlUsd > 0).length / rs.length * 1000) / 10,
    evaluationStatus: rs.length < 100 ? "insufficient-samples" as const : "not-validated" as const,
  }));

  return {
    sampleSize: rows.length,
    winRatePct: Math.round((wins.length / (rows.length || 1)) * 1000) / 10,
    breakevens: rows.length - wins.length - losses.length,
    avgWinPct: round1(avg(wins)),
    avgLossPct: round1(avg(losses)),
    expectancyPct: round1(avg(rows)),
    percentageSampleSize: rows.filter((t) => Number.isFinite(t.pnlPct)).length,
    netPnlUsd: net(rows),
    expectancyUsd: rows.length ? net(rows) / rows.length : 0,
    profitFactor: profitFactor(rows),
    invalidPnlRows: trades.length - rows.length,
    legacyRows: rows.filter((t) => t.accountingVersion !== 2).length,
    unverifiedRows: rows.filter((t) => !t.dataQuality || t.dataQuality.length > 0).length,
    scope: "supplied-completed-positions",
    feedbackEligible: rows.length > 0 && rows.length === trades.length && rows.every((t) => t.mode === "PAPER" && t.accountingVersion === 2),
    evaluationStatus: cohorts.every((c) => c.sampleSize < 100) ? "insufficient-samples" : cohorts.length > 1 ? "cohort-only" : "not-validated",
    costCaution: "Trading net already includes transaction costs; AI operating costs are not included. Positive after-cost expectancy, PF >1.3 and full-cohort drawdown need cost-sensitive forward evaluation. At least 100 completed positions per compatible cohort is a minimum, not proof or LIVE approval. Legacy/unknown inputs are not corrected learning evidence.",
    lossReasons,
    weakStrategies,
    repeatLoserTokens,
    cohorts,
  };
}
