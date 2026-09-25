/**
 * Strategy performance tracker.
 * Uses shrinkage toward neutral for small sample sizes — no 5-trade "hot streak" blowup.
 */
export interface TradeOutcome {
  strategyId: string;
  pnlUsd: number;
  /** Authoritative fill-net outcome for a completed position. When present,
   *  fees and slippage are already included and are not deducted again. */
  netPnlUsd?: number;
  feesUsd: number;
  slippageUsd: number;
  durationMs: number;
  timestamp: Date;
}

export interface StrategyStats {
  strategyId: string;
  sampleSize: number;
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  expectancyUsd: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeProxy: number;    // simple mean/stddev ratio
  performanceMultiplier: number; // shrunk toward 1.0 for small N
}

const MIN_RELIABLE_SAMPLE = 100;
const SHRINKAGE_SAMPLE = 30;  // start trusting after 30 trades

export class StrategyPerformanceTracker {
  private outcomes = new Map<string, TradeOutcome[]>();

  record(outcome: TradeOutcome): void {
    if (![outcome.pnlUsd, outcome.netPnlUsd ?? outcome.pnlUsd, outcome.feesUsd,
      outcome.slippageUsd, outcome.durationMs, outcome.timestamp.getTime()].every(Number.isFinite)
        || outcome.feesUsd < 0 || outcome.slippageUsd < 0 || outcome.durationMs < 0) {
      throw new Error("Invalid strategy performance outcome");
    }
    const list = this.outcomes.get(outcome.strategyId) ?? [];
    list.push(outcome);
    this.outcomes.set(outcome.strategyId, list);
  }

  getStats(strategyId: string): StrategyStats {
    const trades = this.outcomes.get(strategyId) ?? [];
    const n = trades.length;

    if (n === 0) {
      return neutralStats(strategyId);
    }

    const netPnls = trades.map((t) => t.netPnlUsd ?? (t.pnlUsd - t.feesUsd - t.slippageUsd));
    const wins = netPnls.filter((p) => p > 0);
    const losses = netPnls.filter((p) => p <= 0);

    const winRate = n > 0 ? wins.length / n : 0.5;
    const avgWin = wins.length > 0 ? mean(wins) : 0;
    const avgLoss = losses.length > 0 ? Math.abs(mean(losses)) : 0;
    const expectancy = mean(netPnls);
    const profitFactor = avgLoss > 0 ? (avgWin * winRate) / (avgLoss * (1 - winRate)) : 1.0;

    const std = stddev(netPnls);
    const sharpeProxy = std > 0 ? expectancy / std : 0;

    // Performance multiplier: shrink toward 1.0 for small samples
    const shrinkWeight = Math.min(n, SHRINKAGE_SAMPLE) / SHRINKAGE_SAMPLE;
    const rawMultiplier = computeRawMultiplier(winRate, expectancy, profitFactor);
    const performanceMultiplier = 1.0 * (1 - shrinkWeight) + rawMultiplier * shrinkWeight;

    return {
      strategyId,
      sampleSize: n,
      winRate,
      avgWinUsd: avgWin,
      avgLossUsd: avgLoss,
      expectancyUsd: expectancy,
      profitFactor,
      maxDrawdownPct: computeMaxDrawdown(netPnls),
      sharpeProxy,
      performanceMultiplier: clamp(performanceMultiplier, 0.3, 1.5),
    };
  }

  /** How reliable are the stats for this strategy? */
  isStatisticallyMeaningful(strategyId: string): boolean {
    return (this.outcomes.get(strategyId)?.length ?? 0) >= MIN_RELIABLE_SAMPLE;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function neutralStats(strategyId: string): StrategyStats {
  return {
    strategyId, sampleSize: 0, winRate: 0.5,
    avgWinUsd: 0, avgLossUsd: 0, expectancyUsd: 0,
    profitFactor: 1.0, maxDrawdownPct: 0, sharpeProxy: 0,
    performanceMultiplier: 1.0,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function computeRawMultiplier(winRate: number, expectancy: number, profitFactor: number): number {
  // >1 when positive expectancy, <1 when negative
  if (expectancy <= 0) return 0.5;
  if (profitFactor >= 2.0) return 1.4;
  if (profitFactor >= 1.5) return 1.2;
  if (profitFactor >= 1.2) return 1.1;
  if (profitFactor >= 1.0) return 1.0;
  return 0.7;
}

function computeMaxDrawdown(pnlSeries: number[]): number {
  let peak = 0, equity = 0, maxDD = 0;
  for (const pnl of pnlSeries) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}
