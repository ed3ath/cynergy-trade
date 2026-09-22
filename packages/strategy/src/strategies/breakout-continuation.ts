/**
 * Strategy C: Breakout Continuation
 *
 * Sustained multi-window breakout — fires when a token is in a real trend
 * (15m AND 1h aligned, 5m not stalling) rather than a single impulse.
 * Complements Micro Scalp (1-minute bursts) and Fresh Momentum (any single
 * positive window): this one demands strength across every window and pays
 * for it with a wider trail. Exit geometry stays inside the always-take-profit
 * policy envelope (+3% full exit, ~-8% stop, tight trail) — the edge is the
 * stricter entry, not a wider hold.
 *
 * Confirmation (§2 rule — entry without volume/holder flow is bait):
 * buy/sell ratio (1m→5m→1h windows), holder velocity, or ≥5% pool turnover.
 */
import type { StrategyDecision } from "@autonomous-trader/shared";
import type { TradingStrategy, StrategyContext } from "../engine/strategy-interface.js";

export class BreakoutContinuationStrategy implements TradingStrategy {
  readonly id = "strategy-breakout-continuation";
  readonly version = "1.0.0";
  readonly name = "Breakout Continuation";
  readonly description = "Enters multi-window breakouts with volume confirmation and a wider trail";
  /** Between scalp (50) and fresh-momentum (60) — demands high opportunity scores. */
  readonly minimumOpportunityScore = 55;

  evaluate(ctx: StrategyContext): StrategyDecision {
    const { candidate, marketRegime } = ctx;
    const { market, liquidity, security, holders, features } = candidate;
    const reasons: string[] = [];
    const risks: string[] = [];

    // ── Regime: trend family — hostile regimes skip ────────────────────────────
    if (marketRegime === "RISK_OFF" || marketRegime === "BEAR") {
      return this.skip("Market regime hostile to momentum entries", ctx);
    }

    // ── Data floors: no data ⇒ no trade ───────────────────────────────────────
    if (!market || !liquidity || !security) {
      return this.skip("Missing required data layers", ctx);
    }
    if (security.status === "REJECT") {
      return this.reject("Security rejected", ctx);
    }
    if (security.status === "WARNING") risks.push("Security has warnings — reduced confidence");

    // ── Structure ──────────────────────────────────────────────────────────────
    if (liquidity.liquidityUsd < ctx.marketConfig.minLiquidityUsd) {
      return this.reject("Insufficient liquidity", ctx);
    }
    if (liquidity.liquidityChange5m < -10) {
      return this.reject("Liquidity draining — exit door closing", ctx);
    }

    // ── Multi-window breakout ──────────────────────────────────────────────────
    const priceChange5m = features["price_change_5m"]?.value ?? market.priceChange5m;
    const priceChange15m = features["price_change_15m"]?.value ?? market.priceChange15m;
    const priceChange1h = features["price_change_1h"]?.value ?? market.priceChange1h;
    const priceChange1m = features["price_change_1m"]?.value ?? market.priceChange1m;

    if (Math.abs(priceChange1m) > 50) {
      return this.reject("Extremely volatile 1m candle — possible manipulation", ctx);
    }
    if (priceChange15m < 5 || priceChange1h < 8) {
      return this.skip("Not a sustained breakout", ctx);
    }
    if (priceChange5m < 0) {
      return this.skip("Breakout stalling over 5m", ctx);
    }
    if (priceChange1h > 100) {
      return this.skip("Already vertical — buying exit liquidity", ctx);
    }
    reasons.push(`15m +${priceChange15m.toFixed(1)}%`, `1h +${priceChange1h.toFixed(1)}%`);

    // ── Flow confirmation (volume or holder velocity — never price-only) ──────
    const buySellRatio = features["buy_sell_ratio"]?.value;
    const holderGrowth = holders?.holderGrowth5m ?? 0;
    const turnover = liquidity.liquidityUsd > 0 ? market.volumeUsd5m / liquidity.liquidityUsd : 0;
    let confirmed = false;
    if (buySellRatio !== undefined) {
      if (buySellRatio < 1.2) return this.skip("Buy/sell ratio below 1.2", ctx);
      reasons.push(`Buy/sell ratio ${buySellRatio.toFixed(2)}`);
      confirmed = true;
    }
    if (holderGrowth > 0.5) {
      reasons.push(`Holder growth +${holderGrowth.toFixed(1)}%/5m`);
      confirmed = true;
    }
    if (!confirmed && turnover >= 0.05) {
      reasons.push(`5m turnover ${(100 * turnover).toFixed(1)}% of pool`);
      risks.push("Flow counts unavailable — turnover-only confirmation");
      confirmed = true;
    }
    if (!confirmed) {
      return this.skip("No volume/holder confirmation available", ctx);
    }

    // ── Confidence ─────────────────────────────────────────────────────────────
    const baseConfidence = Math.min(0.8, 0.45 + candidate.scores.opportunity / 250);
    const securityPenalty = security.status === "WARNING" ? 0.1 : 0;
    const confidence = Math.max(0.3, baseConfidence - securityPenalty);

    // ── Exits: policy envelope — TP1 +3% full exit, never hold long ───────────
    const price = market.priceUsd;
    return {
      strategyId: this.id,
      strategyVersion: this.version,
      tokenAddress: candidate.tokenAddress,
      decision: "ENTER",
      confidence,
      reasons,
      risks,
      invalidationConditions: [
        "Breakout fails: 5m change turns negative",
        "Buy/sell ratio flips below 1.0",
        "Liquidity drops below minimum",
      ],
      suggestedEntryPrice: price,
      suggestedStopLoss: price * 0.92,      // -8% hard stop
      suggestedTakeProfit1: price * 1.03,   // +3% take profit (full exit)
      suggestedTakeProfit2: price * 1.12,   // +12% backstop target
      suggestedTrailingStopPct: 7,          // wider trail than scalp — trend room
      evaluatedAt: new Date(),
    };
  }

  private skip(reason: string, ctx: StrategyContext): StrategyDecision {
    return {
      strategyId: this.id, strategyVersion: this.version,
      tokenAddress: ctx.candidate.tokenAddress,
      decision: "SKIP", confidence: 0, reasons: [],
      risks: [reason], invalidationConditions: [], evaluatedAt: new Date(),
    };
  }

  private reject(reason: string, ctx: StrategyContext): StrategyDecision {
    return {
      strategyId: this.id, strategyVersion: this.version,
      tokenAddress: ctx.candidate.tokenAddress,
      decision: "REJECT", confidence: 0, reasons: [],
      risks: [reason], invalidationConditions: [], evaluatedAt: new Date(),
    };
  }
}
