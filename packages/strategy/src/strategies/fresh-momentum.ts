/**
 * Strategy A: Fresh Momentum
 *
 * Looks for tokens with:
 * - Healthy liquidity (not thinning)
 * - Healthy holder distribution (not concentrated)
 * - Sustained buying pressure (not a single spike)
 * - Controlled volatility (not a pump & dump)
 * - Acceptable execution quality
 */
import type { StrategyDecision } from "@autonomous-trader/shared";
import type { TradingStrategy, StrategyContext } from "../engine/strategy-interface.js";

export class FreshMomentumStrategy implements TradingStrategy {
  readonly id = "strategy-fresh-momentum";
  readonly version = "1.0.0";
  readonly name = "Fresh Momentum";
  readonly description = "Identifies tokens with organic buying momentum in healthy market structure";
  readonly minimumOpportunityScore = 60;

  evaluate(ctx: StrategyContext): StrategyDecision {
    const { candidate, marketRegime } = ctx;
    const { market, liquidity, holders, security, features } = candidate;
    const reasons: string[] = [];
    const risks: string[] = [];
    const invalidation: string[] = [];

    // ── Reject hostile regimes ────────────────────────────────────────────────
    if (marketRegime === "RISK_OFF" || marketRegime === "BEAR") {
      return this.skip("Market regime hostile to momentum entries", ctx);
    }

    // ── Require all data layers ───────────────────────────────────────────────
    if (!market || !liquidity || !holders || !security) {
      return this.skip("Missing required data layers", ctx);
    }

    // ── Security check ────────────────────────────────────────────────────────
    if (security.status === "REJECT") {
      return this.reject("Security rejected", ctx);
    }
    if (security.status === "WARNING") {
      risks.push("Security has warnings — reduced confidence");
    }

    // ── Liquidity structure ───────────────────────────────────────────────────
    if (liquidity.liquidityUsd < ctx.marketConfig.minLiquidityUsd) {
      return this.reject("Insufficient liquidity", ctx);
    }
    if (liquidity.liquidityChange5m < -15) {
      return this.reject("Liquidity draining rapidly", ctx);
    }
    if (liquidity.liquidityChange5m > 0) {
      reasons.push("Liquidity growing");
    }

    // ── Holder health ─────────────────────────────────────────────────────────
    if (holders.top10Pct > 70) {
      return this.reject("Excessive top-10 concentration", ctx);
    }
    if (holders.insiderPct > 25) {
      return this.reject("High insider holding", ctx);
    }
    if (holders.concentrationChange5m > 3) {
      return this.reject("Concentration increasing — insiders accumulating", ctx);
    }
    if (holders.holderGrowth5m > 0) {
      reasons.push(`Holder growth +${holders.holderGrowth5m.toFixed(1)}%/5m`);
    }

    // ── Momentum check ────────────────────────────────────────────────────────
    const priceChange5m = features["price_change_5m"]?.value ?? 0;
    const priceChange15m = features["price_change_15m"]?.value ?? 0;
    const buySellRatio = features["buy_sell_ratio"]?.value ?? 1;
    const buyVolumePct = features["volume_buy_pct"]?.value ?? 50;

    // Need sustained momentum, not a single candle
    if (priceChange5m <= 0 && priceChange15m <= 0) {
      return this.skip("No positive price momentum", ctx);
    }

    // Explosive single-minute moves are suspicious
    const priceChange1m = features["price_change_1m"]?.value ?? 0;
    if (Math.abs(priceChange1m) > 25) {
      risks.push(`Volatile 1m candle: ${priceChange1m.toFixed(1)}%`);
    }
    if (Math.abs(priceChange1m) > 50) {
      return this.reject("Extremely volatile — possible manipulation", ctx);
    }

    if (buySellRatio >= 1.5) reasons.push(`Buy/sell ratio: ${buySellRatio.toFixed(2)}`);
    if (buyVolumePct >= 60) reasons.push(`Buy volume: ${buyVolumePct.toFixed(0)}%`);

    if (buySellRatio < 1.0) {
      return this.skip("Sellers dominating", ctx);
    }

    // ── Positive signal count ─────────────────────────────────────────────────
    if (reasons.length < 2) {
      return this.skip("Insufficient positive signals", ctx);
    }

    // ── Confidence ────────────────────────────────────────────────────────────
    const baseConfidence = Math.min(0.85, candidate.scores.opportunity / 100);
    const securityPenalty = security.status === "WARNING" ? 0.15 : 0;
    const confidence = Math.max(0.3, baseConfidence - securityPenalty);

    // ── Stop / TP levels ──────────────────────────────────────────────────────
    const price = market.priceUsd;
    const stopLoss = price * 0.85;      // -15% hard stop
    const takeProfit1 = price * 1.20;   // +20% first TP
    const takeProfit2 = price * 1.40;   // +40% second TP

    invalidation.push(
      "Liquidity drops below minimum",
      "Top-10 concentration exceeds 80%",
      "Buy/sell ratio drops below 0.8 for 3 consecutive minutes",
      "Price drops below stop loss",
    );

    return {
      strategyId: this.id,
      strategyVersion: this.version,
      tokenAddress: candidate.tokenAddress,
      decision: "ENTER",
      confidence,
      reasons,
      risks,
      invalidationConditions: invalidation,
      suggestedEntryPrice: price,
      suggestedStopLoss: stopLoss,
      suggestedTakeProfit1: takeProfit1,
      suggestedTakeProfit2: takeProfit2,
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
