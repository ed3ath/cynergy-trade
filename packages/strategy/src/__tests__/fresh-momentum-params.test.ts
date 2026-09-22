import { describe, it, expect } from "vitest";
import { FreshMomentumStrategy } from "../strategies/fresh-momentum.js";
import type { StrategyContext } from "../engine/strategy-interface.js";
import type { TokenCandidate } from "@autonomous-trader/scanner";

function makeCandidate(): TokenCandidate {
  return {
    tokenAddress: "tokenA",
    chain: "bsc",
    status: "TRADE_CANDIDATE",
    scores: { opportunity: 55 }, // below default score gate 60
    market: { priceUsd: 0.001 },
    liquidity: { liquidityUsd: 100_000, liquidityChange5m: 0 },
    security: { status: "SAFE", score: 90 },
    holders: { holderGrowth5m: 1.5, totalHolders: 5_000 }, // exactly 1 default reason (growth)
    features: { price_change_1h: { value: 1.2 }, buy_sell_ratio: { value: 1.1 }, volume_buy_pct: { value: 55 } },
  } as unknown as TokenCandidate;
}

function makeCtx(candidate: TokenCandidate): StrategyContext {
  return {
    candidate,
    marketRegime: "BULL",
    portfolioValueUsd: 10_000,
    availableCapitalUsd: 10_000,
    openPositionCount: 0,
    existingTokenExposureUsd: 0,
    freshnessConfig: {} as StrategyContext["freshnessConfig"],
    marketConfig: { minLiquidityUsd: 50_000 } as StrategyContext["marketConfig"],
    timestamp: new Date(),
  };
}

describe("FreshMomentumParams (B2 sweep surface)", () => {
  const candidate = makeCandidate();

  it("defaults reproduce live behavior: skip (1 reason < 2)", () => {
    expect(new FreshMomentumStrategy().evaluate(makeCtx(candidate)).decision).toBe("SKIP");
  });

  it("signalCountMin=1 flips the same input to ENTER", () => {
    const d = new FreshMomentumStrategy({ signalCountMin: 1 }).evaluate(makeCtx(candidate));
    expect(d.decision).toBe("ENTER");
    expect(d.suggestedTakeProfit1).toBeCloseTo(0.001 * 1.03, 9); // exit geometry untouched by params
  });

  it("buySellRatioMin above the flow ratio skips what the default enters", () => {
    const loose = new FreshMomentumStrategy({ signalCountMin: 1 });
    const strict = new FreshMomentumStrategy({ signalCountMin: 1, buySellRatioMin: 1.2 });
    expect(loose.evaluate(makeCtx(candidate)).decision).toBe("ENTER");
    expect(strict.evaluate(makeCtx(candidate)).decision).toBe("SKIP");
  });

  it("minimumOpportunityScore is exposed for the engine-side gate", () => {
    expect(new FreshMomentumStrategy().minimumOpportunityScore).toBe(60);
    expect(new FreshMomentumStrategy({ minOpportunityScore: 50 }).minimumOpportunityScore).toBe(50);
  });
});
