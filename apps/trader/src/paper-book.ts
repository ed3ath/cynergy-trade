import type { PortfolioSnapshot, Position, TradeSide } from "@autonomous-trader/shared";

/** Confirmed PAPER facts only. BUY input / SELL output are USD-micro;
 * BUY output / SELL input are synthetic token-nano, never native chain units. */
export interface PaperBookFill {
  orderId: string;
  positionId: string;
  side: TradeSide;
  inputAmount: bigint;
  outputAmount: bigint;
  confirmedAt: Date;
  cashDeltaUsd: number;
  realizedPnlDeltaUsd: number;
}

export class PaperBook {
  private readonly fills = new Map<string, PaperBookFill>();

  constructor(private readonly startingCapitalUsd: number) {
    if (!Number.isFinite(startingCapitalUsd) || startingCapitalUsd <= 0) {
      throw new Error("Invalid PAPER starting capital");
    }
  }

  /** Replayed facts cannot double-book cash, including after persistence retries. */
  record(fill: PaperBookFill): boolean {
    if (!fill.orderId || !fill.positionId || !["BUY", "SELL"].includes(fill.side)
        || fill.inputAmount <= 0n || fill.outputAmount < 0n
        || !Number.isFinite(fill.confirmedAt.getTime())
        || !Number.isFinite(fill.cashDeltaUsd) || !Number.isFinite(fill.realizedPnlDeltaUsd)) {
      throw new Error("Invalid confirmed PAPER accounting fact");
    }
    const existing = this.fills.get(fill.orderId);
    if (existing) {
      if (existing.positionId !== fill.positionId || existing.side !== fill.side
          || existing.inputAmount !== fill.inputAmount || existing.outputAmount !== fill.outputAmount
          || existing.cashDeltaUsd !== fill.cashDeltaUsd || existing.realizedPnlDeltaUsd !== fill.realizedPnlDeltaUsd
          || existing.confirmedAt.getTime() !== fill.confirmedAt.getTime()) {
        throw new Error(`Conflicting PAPER fill ${fill.orderId}`);
      }
      return false;
    }
    this.fills.set(fill.orderId, { ...fill, confirmedAt: new Date(fill.confirmedAt) });
    return true;
  }

  reconciliationIssues(positions: readonly Position[]): string[] {
    const quantities = new Map<string, bigint>();
    for (const fill of this.fills.values()) {
      quantities.set(fill.positionId, (quantities.get(fill.positionId) ?? 0n)
        + (fill.side === "BUY" ? fill.outputAmount : -fill.inputAmount));
    }
    const issues: string[] = [];
    for (const p of positions) {
      if (p.status === "CLOSED") continue;
      if (p.mode !== "PAPER" || p.accountingVersion !== 2) {
        issues.push(`unreconciled position ${p.id}`);
        continue;
      }
      if (quantities.get(p.id) !== p.sizeTokens) issues.push(`quantity mismatch ${p.id}`);
      quantities.delete(p.id);
      if (!Number.isFinite(p.currentPrice) || p.currentPrice <= 0 || p.sizeTokens < 0n
          || !Number.isFinite(p.sizeUsd) || p.sizeUsd < 0) issues.push(`invalid position ${p.id}`);
    }
    for (const [id, quantity] of quantities) {
      if (quantity !== 0n) issues.push(`orphaned quantity ${id}`);
    }
    return issues;
  }

  snapshot(positions: readonly Position[], now = new Date(), previousPeak = this.startingCapitalUsd): PortfolioSnapshot {
    const issues = this.reconciliationIssues(positions);
    if (issues.length > 0) throw new Error(`PAPER reconciliation required: ${issues.join("; ")}`);
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const week = day - ((now.getUTCDay() + 6) % 7) * 86_400_000;
    const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    let cash = this.startingCapitalUsd;
    let daily = 0, weekly = 0, monthly = 0, allTime = 0;
    for (const fill of this.fills.values()) {
      cash += fill.cashDeltaUsd;
      allTime += fill.realizedPnlDeltaUsd;
      const at = fill.confirmedAt.getTime();
      if (at >= day && at <= now.getTime()) daily += fill.realizedPnlDeltaUsd;
      if (at >= week && at <= now.getTime()) weekly += fill.realizedPnlDeltaUsd;
      if (at >= month && at <= now.getTime()) monthly += fill.realizedPnlDeltaUsd;
    }
    const held = positions.filter((p) => p.status !== "CLOSED");
    const allocated = held.reduce((sum, p) => sum + p.sizeUsd, 0);
    const total = cash + held.reduce((sum, p) => sum + Number(p.sizeTokens) / 1e9 * p.currentPrice, 0);
    if (![cash, allocated, total].every(Number.isFinite)) throw new Error("Invalid PAPER book value");
    const peak = Math.max(this.startingCapitalUsd, Number.isFinite(previousPeak) ? previousPeak : 0, total);
    return {
      totalValueUsd: total,
      availableCapitalUsd: cash,
      allocatedUsd: allocated,
      openPositions: held.length,
      dailyPnlUsd: daily,
      weeklyPnlUsd: weekly,
      monthlyPnlUsd: monthly,
      allTimePnlUsd: allTime,
      currentDrawdownPct: Math.max(0, (peak - total) / peak * 100),
      peakValueUsd: peak,
      snapshotAt: new Date(now),
    };
  }
}
