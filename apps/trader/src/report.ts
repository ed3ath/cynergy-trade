/**
 * Daily performance report (spec §69).
 * Aggregates closed positions + portfolio + strategy stats.
 * In-memory state; journal persistence when DB available.
 */
import type { PortfolioSnapshot, Position, Logger, TradeMode } from "@autonomous-trader/shared";
import type { StrategyPerformanceTracker } from "@autonomous-trader/core";

export interface DailyReport {
  date: string; // YYYY-MM-DD UTC
  mode: TradeMode;
  portfolioStartUsd: number;
  portfolioEndUsd: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  totalFeesUsd: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyUsd: number;
  largestWinUsd: number;
  largestLossUsd: number;
  openPositions: number;
  unrealizedPnlUsd: number;
  currentDrawdownPct: number;
  strategies: Array<{
    strategyId: string;
    trades: number;
    winRate: number;
    expectancyUsd: number;
    performanceMultiplier: number;
  }>;
  generatedAt: string;
}

interface ClosedTrade {
  strategyId: string;
  pnlUsd: number;
  feesUsd: number;
  closedAt: Date;
}

/** Tracks closed trades for reporting. */
export class ReportTracker {
  private closedTrades: ClosedTrade[] = [];
  private dayKey = utcDayKey(new Date());

  recordClose(trade: ClosedTrade): void {
    this.rollDayIfNeeded();
    this.closedTrades.push(trade);
  }

  private rollDayIfNeeded(): void {
    const today = utcDayKey(new Date());
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.closedTrades = []; // new day, new ledger (report should have been emitted at rollover)
    }
  }

  getTrades(): ClosedTrade[] {
    this.rollDayIfNeeded();
    return [...this.closedTrades];
  }
}

export function buildDailyReport(
  tracker: ReportTracker,
  portfolio: PortfolioSnapshot,
  openPositions: Position[],
  performanceTracker: StrategyPerformanceTracker,
  mode: TradeMode,
): DailyReport {
  const trades = tracker.getTrades();
  const gross = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const fees = trades.reduce((s, t) => s + t.feesUsd, 0);
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const largestWin = wins.reduce((m, t) => Math.max(m, t.pnlUsd), 0);
  const largestLoss = losses.reduce((m, t) => Math.min(m, t.pnlUsd), 0);

  const strategyIds = [...new Set(trades.map((t) => t.strategyId))];

  return {
    date: utcDayKey(new Date()),
    mode,
    portfolioStartUsd: portfolio.totalValueUsd - gross,
    portfolioEndUsd: portfolio.totalValueUsd,
    grossPnlUsd: gross,
    netPnlUsd: gross - fees,
    totalFeesUsd: fees,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    expectancyUsd: trades.length > 0 ? (gross - fees) / trades.length : 0,
    largestWinUsd: largestWin,
    largestLossUsd: largestLoss,
    openPositions: openPositions.length,
    unrealizedPnlUsd: openPositions.reduce((s, p) => s + p.unrealizedPnlUsd, 0),
    currentDrawdownPct: portfolio.currentDrawdownPct,
    strategies: strategyIds.map((id) => {
      const stats = performanceTracker.getStats(id);
      return {
        strategyId: id,
        trades: stats.sampleSize,
        winRate: stats.winRate,
        expectancyUsd: stats.expectancyUsd,
        performanceMultiplier: stats.performanceMultiplier,
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}

export function formatReportText(r: DailyReport): string {
  const pnl = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
  return [
    `Daily report ${r.date} (${r.mode})`,
    `Portfolio: ${r.portfolioStartUsd.toFixed(2)} → ${r.portfolioEndUsd.toFixed(2)} USD`,
    `Net PnL: ${pnl(r.netPnlUsd)} (gross ${pnl(r.grossPnlUsd)}, fees ${r.totalFeesUsd.toFixed(2)})`,
    `Trades: ${r.trades} (W${r.wins}/L${r.losses}) | win rate ${(r.winRate * 100).toFixed(1)}% | expectancy ${pnl(r.expectancyUsd)}`,
    `Largest win ${pnl(r.largestWinUsd)} | largest loss ${pnl(r.largestLossUsd)}`,
    `Open positions: ${r.openPositions} (unrealized ${pnl(r.unrealizedPnlUsd)})`,
    `Drawdown: ${r.currentDrawdownPct.toFixed(2)}%`,
    ...r.strategies.map((s) =>
      `  ${s.strategyId}: ${s.trades} trades, wr ${(s.winRate * 100).toFixed(0)}%, exp ${pnl(s.expectancyUsd)}, x${s.performanceMultiplier.toFixed(2)}`),
  ].join("\n");
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
