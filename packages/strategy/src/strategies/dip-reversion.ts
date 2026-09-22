/**
 * Strategy D: Dip Reversion
 *
 * Buy the pullback in an established uptrend (§1.1 RSI-momentum pullback
 * family): token up strongly over 24h (the anchor), currently dipping over
 * 15m/1h, flow not capitulating. Catches exactly the candidates the momentum
 * strategies skip ("No positive price momentum") — flat/pulled-back tokens in
 * larger uptrends. Anchor requires 24h history, so fresh launches
 * (24h change = 0) never fire — reversion on a 20-minute-old mean is bait (§1.2).
 *
 * Exits are the tightest in the ensemble — reversion is a lower-expectancy,
 * higher-frequency family; TP1 +3% full exit per policy, tight -6% stop,
 * snap-back is fast or wrong.
 */
import type { StrategyDecision } from "@autonomous-trader/shared";
import type { TradingStrategy, StrategyContext } from "../engine/strategy-interface.js";

export class DipReversionStrategy implements TradingStrategy {
  readonly id = "strategy-dip-reversion";
  readonly version = "1.0.0";
  readonly name = "Dip Reversion";
  readonly description = "Buys stabilized pullbacks inside established 24h uptrends";
  /** Anchor makes this selective on its own — mid-ensemble floor. */
  readonly minimumOpportunityScore = 55;

  evaluate(ctx: StrategyContext): StrategyDecision {
    const { candidate, marketRegime } = ctx;
    const { market, liquidity, security, holders, features } = candidate;
    const reasons: string[] = [];
    const risks: string[] = [];

    // ── Regime: RANGE/BULL only — BEAR dips are not dips, they are stairs ─────
    if (marketRegime === "RISK_OFF" || marketRegime === "BEAR") {
      return this.skip("Market regime hostile to reversion entries", ctx);
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
    if (liquidity.liquidityChange5m < -15) {
      return this.reject("Liquidity draining — exit door closing", ctx);
    }

    // ── Anchor: established uptrend (also gates out fresh launches) ───────────
    const priceChange24h = features["price_change_24h"]?.value ?? market.priceChange24h;
    const priceChange1h = features["price_change_1h"]?.value ?? market.priceChange1h;
    const priceChange15m = features["price_change_15m"]?.value ?? market.priceChange15m;
    const priceChange5m = features["price_change_5m"]?.value ?? market.priceChange5m;
    const priceChange1m = features["price_change_1m"]?.value ?? market.priceChange1m;

    if (Math.abs(priceChange1m) > 50) {
      return this.reject("Extremely volatile 1m candle — possible manipulation", ctx);
    }
    if (priceChange24h < 5) {
      return this.skip("No established uptrend to buy a dip in", ctx);
    }
    reasons.push(`24h anchor +${priceChange24h.toFixed(1)}%`);

    // ── The dip: real pullback, not a collapse ────────────────────────────────
    if (priceChange15m > -4) {
      return this.skip("No meaningful dip", ctx);
    }
    if (priceChange15m < -20 || priceChange1h < -15) {
      return this.skip("Token collapsing — falling knife, not a dip", ctx);
    }
    if (priceChange5m < -10) {
      return this.skip("Dip still accelerating down", ctx);
    }
    reasons.push(`15m pullback ${priceChange15m.toFixed(1)}%`);

    // ── Flow not capitulating (§2: volume/holder confirmation) ────────────────
    const buySellRatio = features["buy_sell_ratio"]?.value;
    const holderGrowth = holders?.holderGrowth5m ?? 0;
    const turnover = liquidity.liquidityUsd > 0 ? market.volumeUsd5m / liquidity.liquidityUsd : 0;
    if (buySellRatio !== undefined) {
      if (buySellRatio < 0.7) return this.skip("Sellers overwhelming the dip", ctx);
      reasons.push(`Buy/sell ratio ${buySellRatio.toFixed(2)} holding`);
    } else if (holderGrowth >= 0) {
      reasons.push("Holder base stable through the dip");
    } else if (turnover >= 0.05) {
      reasons.push(`5m turnover ${(100 * turnover).toFixed(1)}% of pool`);
      risks.push("Flow counts unavailable — turnover-only confirmation");
    } else {
      return this.skip("No volume/holder confirmation available", ctx);
    }

    // ── Confidence: reversion is the noisiest family — capped lower ───────────
    const baseConfidence = Math.min(0.6, 0.35 + candidate.scores.opportunity / 300);
    const securityPenalty = security.status === "WARNING" ? 0.1 : 0;
    const confidence = Math.max(0.25, baseConfidence - securityPenalty);

    // ── Exits: tightest in the ensemble — snap-back or out ────────────────────
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
        "Dip deepens past 15m -20% from entry evaluation",
        "Buy/sell ratio drops below 0.5",
        "Liquidity drops below minimum",
      ],
      suggestedEntryPrice: price,
      suggestedStopLoss: price * 0.94,      // -6% hard stop — reversion is fast or wrong
      suggestedTakeProfit1: price * 1.03,   // +3% take profit (full exit)
      suggestedTakeProfit2: price * 1.06,   // +6% backstop target
      suggestedTrailingStopPct: 4,          // 4% trail — protect the snap-back
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
