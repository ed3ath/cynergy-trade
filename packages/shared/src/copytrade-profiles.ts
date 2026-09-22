/**
 * Copy-trade position profiles. Multiple concurrent positions per token are
 * keyed by strategyId (`copytrade-scalp`, `copytrade-shortterm`) so journal
 * attribution and the risk engine's strategy gates separate them; aggregate
 * per-token exposure stays capped by the existing maxTokenExposureUsd gate.
 *
 * Exit levels follow the standing policy (realize early, cut fast, never
 * widen): scalp = very tight and short-lived, shortterm = the system's
 * standard 2h/10%/5% envelope under a copy-trade label.
 */

export type CopyTradeProfile = "scalp" | "shortterm";

export interface CopyTradeProfileConfig {
  /** strategyId suffix used on positions and intents. */
  strategyId: string;
  /** Hard stop, pct below entry. */
  stopLossPct: number;
  /** TP ladders, pct above entry. */
  takeProfit1Pct: number;
  takeProfit2Pct: number;
  /** Trailing stop, pct from peak. */
  trailingStopPct: number;
  /** Time stop — momentum theses have a half-life. */
  timeStopMs: number;
}

export const COPYTRADE_PROFILES: Record<CopyTradeProfile, CopyTradeProfileConfig> = {
  scalp: {
    strategyId: "copytrade-scalp",
    stopLossPct: 5,
    takeProfit1Pct: 3,
    takeProfit2Pct: 6,
    trailingStopPct: 8,
    timeStopMs: 20 * 60_000,
  },
  shortterm: {
    strategyId: "copytrade-shortterm",
    stopLossPct: 10,
    takeProfit1Pct: 5,
    takeProfit2Pct: 10,
    trailingStopPct: 15,
    timeStopMs: 2 * 60 * 60_000,
  },
};

/** Resolve a profile by strategyId (also covers positions restored from the
 *  journal, whose in-memory timeStopMs is lost). null for non-copy positions. */
export function copytradeProfileFor(strategyId: string): CopyTradeProfileConfig | null {
  for (const p of Object.values(COPYTRADE_PROFILES)) {
    if (p.strategyId === strategyId) return p;
  }
  return null;
}
