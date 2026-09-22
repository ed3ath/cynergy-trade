/**
 * Strategy B: Micro Scalp
 *
 * Short-horizon momentum burst: catch a 1-minute price+volume impulse on an
 * already-screened token, ride it a few percent, exit fast on tight levels
 * (-7% stop, +3%/+10% TP, 6% trail). Complements Fresh Momentum,
 * which needs sustained multi-window momentum — this fires on the burst itself.
 *
 * Two data paths (same pattern as fresh-momentum):
 * - Fine-grained (mock, and any provider with real 1m trade granularity):
 *   1m price impulse + volume velocity vs 5m baseline + buy pressure + ≥3 buyers.
 * - Coarse fallback (Birdeye/DexScreener report 1m fields as 0):
 *   5m move + 1h alignment + buy/sell ratio or holder growth.
 */
import type { StrategyDecision } from "@autonomous-trader/shared";
import type { TradingStrategy, StrategyContext } from "../engine/strategy-interface.js";

export class MicroScalpStrategy implements TradingStrategy {
  readonly id = "strategy-micro-scalp";
  readonly version = "1.0.0";
  readonly name = "Micro Scalp";
  readonly description = "Rides 1-minute volume-confirmed impulses with tight exits";
  /** Lower than fresh-momentum's 60 — bursts are the opportunity this hunts. */
  readonly minimumOpportunityScore = 50;

  evaluate(ctx: StrategyContext): StrategyDecision {
    const { candidate, marketRegime } = ctx;
    const { market, liquidity, security, holders } = candidate;
    const reasons: string[] = [];
    const risks: string[] = [];

    // ── Regime: momentum family — hostile regimes skip ────────────────────────
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
    if (security.status === "WARNING") {
      risks.push("Security has warnings — reduced confidence");
    }

    // ── Structure: enough liquidity, and the exit door not closing ────────────
    if (liquidity.liquidityUsd < ctx.marketConfig.minLiquidityUsd) {
      return this.reject("Insufficient liquidity", ctx);
    }
    if (liquidity.liquidityChange5m < -10) {
      return this.reject("Liquidity draining — exit door closing", ctx);
    }

    // ── Price context ─────────────────────────────────────────────────────────
    const priceChange1m = candidate.features["price_change_1m"]?.value ?? market.priceChange1m;
    const priceChange5m = candidate.features["price_change_5m"]?.value ?? market.priceChange5m;
    const priceChange1h = candidate.features["price_change_1h"]?.value ?? market.priceChange1h;

    if (Math.abs(priceChange1m) > 50) {
      return this.reject("Extremely volatile 1m candle — possible manipulation", ctx);
    }
    if (priceChange5m < -10) {
      return this.reject("Token crashing over 5m — not a scalp, a falling knife", ctx);
    }

    // ── Entry trigger: 1m burst path or coarse fallback ───────────────────────
    const hasFineData = market.volumeUsd1m > 0 && market.uniqueBuyers1m > 0;
    if (hasFineData) {
      const perMinute5m = Math.max(1, market.volumeUsd5m / 5);
      const velocity = market.volumeUsd1m / perMinute5m;
      if (priceChange1m < 1.2) {
        return this.skip("No 1m price impulse", ctx);
      }
      if (velocity < 1.8) {
        return this.skip("Volume burst not confirmed (velocity < 1.8× 5m baseline)", ctx);
      }
      if (market.buyVolumeUsd1m <= market.sellVolumeUsd1m) {
        return this.skip("Sellers dominating the burst", ctx);
      }
      if (market.uniqueBuyers1m < 3) {
        return this.skip("Burst from fewer than 3 wallets — likely wash", ctx);
      }
      reasons.push(
        `1m impulse +${priceChange1m.toFixed(1)}%`,
        `Volume ${velocity.toFixed(1)}× 5m baseline`,
        `${market.uniqueBuyers1m} unique buyers in 1m`,
      );
    } else {
      // Coarse path: no 1m trade granularity (DexScreener/Birdeye zero-fill it).
      // DexScreener also zero-fills 5m for TON — fall back to 1h when 5m is 0.
      // ponytail: replace with native 5m once DexScreener TON exposes it.
      const coarse5m = priceChange5m !== 0 ? priceChange5m : priceChange1h;
      if (coarse5m < 1.5 || priceChange1h <= 0) {
        return this.skip("No coarse momentum burst", ctx);
      }
      const buySellRatio = candidate.features["buy_sell_ratio"]?.value;
      const holderGrowth = holders?.holderGrowth5m ?? 0;
      if (buySellRatio !== undefined) {
        if (buySellRatio < 1.3) return this.skip("Buy/sell ratio below 1.3", ctx);
        reasons.push(`1h move +${coarse5m.toFixed(1)}%`, `Buy/sell ratio ${buySellRatio.toFixed(2)}`);
      } else if (holderGrowth > 0.5) {
        reasons.push(`1h move +${coarse5m.toFixed(1)}%`, `Holder growth +${holderGrowth.toFixed(1)}%/5m`);
      } else {
        return this.skip("No volume/holder confirmation available", ctx);
      }
    }

    // ── Confidence: bursts are noisier than sustained trends ──────────────────
    const baseConfidence = Math.min(0.7, 0.4 + candidate.scores.opportunity / 250);
    const securityPenalty = security.status === "WARNING" ? 0.1 : 0;
    const confidence = Math.max(0.3, baseConfidence - securityPenalty);

    // ── Tight exit profile — this is what makes it a scalp ────────────────────
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
        "Impulse fades: volume velocity back under 1×",
        "Buy/sell ratio flips below 1.0",
        "Liquidity drops below minimum",
      ],
      suggestedEntryPrice: price,
      suggestedStopLoss: price * 0.93,      // -7% hard stop
      suggestedTakeProfit1: price * 1.03,   // +3% take profit (full exit)
      suggestedTakeProfit2: price * 1.10,   // +10% second partial
      suggestedTrailingStopPct: 6,          // 6% trail from peak
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
