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

/**
 * Entry-threshold overrides for backtesting sweeps (roadmap B2). Live uses the
 * defaults — exit geometry is NOT parameterized (owner policy: +3% full exit,
 * -10% stop, never widened).
 */
export interface FreshMomentumParams {
  /** Positive-signal count required to enter (default 2). */
  signalCountMin?: number;
  /** Minimum buy/sell ratio; below → skip (default 1.0). */
  buySellRatioMin?: number;
  /** 1h momentum % needed for the no-ratio backfill reason (default 1). */
  momentumMin1h?: number;
  /** Minimum opportunity score (default 60). */
  minOpportunityScore?: number;
}

export class FreshMomentumStrategy implements TradingStrategy {
  readonly id = "strategy-fresh-momentum";
  readonly version = "1.0.0";
  readonly name = "Fresh Momentum";
  readonly description = "Identifies tokens with organic buying momentum in healthy market structure";
  readonly minimumOpportunityScore: number;
  private readonly signalCountMin: number;
  private readonly buySellRatioMin: number;
  private readonly momentumMin1h: number;

  constructor(params: FreshMomentumParams = {}) {
    this.minimumOpportunityScore = params.minOpportunityScore ?? 60;
    this.signalCountMin = params.signalCountMin ?? 2;
    this.buySellRatioMin = params.buySellRatioMin ?? 1.0;
    this.momentumMin1h = params.momentumMin1h ?? 1;
  }

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
    const priceChange1h = features["price_change_1h"]?.value ?? 0;
    const buySellRatio = features["buy_sell_ratio"]?.value ?? 1;
    const buyVolumePct = features["volume_buy_pct"]?.value ?? 50;

    // Need sustained momentum, not a single candle — finest available window wins.
    // h1 backfills chains whose DEXes report no 5m/15m granularity (TON via DexScreener)
    if (priceChange5m <= 0 && priceChange15m <= 0 && priceChange1h <= 0) {
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

    if (buySellRatio < this.buySellRatioMin) {
      return this.skip("Sellers dominating", ctx);
    }

    // ponytail: chains without 1m trade granularity (TON via DexScreener) can never
    // hit the ratio/volume reasons — backfill the signal gate with coarser data that
    // exists. DexScreener also zero-fills 5m for TON, so 1h is the finest reliable
    // window; threshold lowered to 1% accordingly. Replace with native 5m/buy counts
    // once a TON provider exposes them.
    if (features["buy_sell_ratio"] == null) {
      if (priceChange1h >= this.momentumMin1h) reasons.push(`1h momentum +${priceChange1h.toFixed(1)}%`);
      if (holders.totalHolders >= 1000) {
        reasons.push(`Broad holder base: ${holders.totalHolders.toLocaleString("en-US")}`);
      }
    }

    // ── Positive signal count ─────────────────────────────────────────────────
    if (reasons.length < this.signalCountMin) {
      return this.skip("Insufficient positive signals", ctx);
    }

    // ── Confidence ────────────────────────────────────────────────────────────
    const baseConfidence = Math.min(0.85, candidate.scores.opportunity / 100);
    const securityPenalty = security.status === "WARNING" ? 0.15 : 0;
    const confidence = Math.max(0.3, baseConfidence - securityPenalty);

    // ── Stop / TP levels ──────────────────────────────────────────────────────
    const price = market.priceUsd;
    // Policy: TP1 (+3%) sells HALF the position (see executePartialTp1 in the
    // trader); the remainder runs under stop/trailing/TP2/time-stop. Geometry
    // roughly matches Micro Scalp (-7/+3/+10) — momentum gets slightly more room.
    const stopLoss = price * 0.90;      // -10% hard stop — loss prevention over ride-through
    const takeProfit1 = price * 1.03;   // +3% take profit (full exit)
    const takeProfit2 = price * 1.10;   // +10% backstop target

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
