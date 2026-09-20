import { describe, it, expect } from "vitest";
import { MicroScalpStrategy } from "../strategies/micro-scalp.js";
import type { TradingStrategy, StrategyContext } from "../engine/strategy-interface.js";
import type { TokenCandidate } from "@autonomous-trader/scanner";

const strategy: TradingStrategy = new MicroScalpStrategy();

function makeCandidate(overrides: Record<string, unknown> = {}): TokenCandidate {
  return {
    tokenAddress: "tokenA",
    chain: "solana",
    status: "TRADE_CANDIDATE",
    scores: { opportunity: 70 },
    market: {
      priceUsd: 0.001,
      priceChange1m: 2.5,
      priceChange5m: 4,
      priceChange1h: 6,
      volumeUsd1m: 30_000,
      volumeUsd5m: 50_000, // 10k/min baseline → velocity 3×
      buyVolumeUsd1m: 20_000,
      sellVolumeUsd1m: 10_000,
      uniqueBuyers1m: 8,
      uniqueSellers1m: 3,
    },
    liquidity: { liquidityUsd: 100_000, liquidityChange5m: 2 },
    security: { status: "SAFE", score: 90 },
    holders: { holderGrowth5m: 1.5 },
    features: {},
    ...overrides,
  } as unknown as TokenCandidate;
}

function makeCtx(candidate: TokenCandidate, overrides: Partial<StrategyContext> = {}): StrategyContext {
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
    ...overrides,
  };
}

describe("MicroScalpStrategy", () => {
  it("enters on a volume-confirmed 1m burst with tight exits", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate()));
    expect(d.decision).toBe("ENTER");
    expect(d.confidence).toBeGreaterThan(0.3);
    expect(d.suggestedStopLoss).toBeCloseTo(0.001 * 0.93, 9);
    expect(d.suggestedTakeProfit1).toBeCloseTo(0.001 * 1.04, 9);
    expect(d.suggestedTrailingStopPct).toBe(6);
  });

  it("skips when volume does not confirm the burst", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange1m: 2.5, volumeUsd1m: 5_000, volumeUsd5m: 50_000,
        buyVolumeUsd1m: 3_000, sellVolumeUsd1m: 2_000, uniqueBuyers1m: 5, uniqueSellers1m: 2 },
    })));
    expect(d.decision).toBe("SKIP");
    expect(d.risks[0]).toContain("velocity");
  });

  it("skips a burst from fewer than 3 wallets (wash guard)", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange1m: 3, volumeUsd1m: 30_000, volumeUsd5m: 10_000,
        buyVolumeUsd1m: 25_000, sellVolumeUsd1m: 5_000, uniqueBuyers1m: 2, uniqueSellers1m: 1 },
    })));
    expect(d.decision).toBe("SKIP");
    expect(d.risks[0]).toContain("wash");
  });

  it("coarse fallback enters on 5m move + buy/sell ratio when 1m data is zeroed", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange1m: 0, priceChange5m: 4, priceChange1h: 6,
        volumeUsd1m: 0, volumeUsd5m: 50_000, buyVolumeUsd1m: 0, sellVolumeUsd1m: 0,
        uniqueBuyers1m: 0, uniqueSellers1m: 0 },
      features: { buy_sell_ratio: { value: 1.6, timestamp: new Date(), confidence: 0.9 } },
    })));
    expect(d.decision).toBe("ENTER");
  });

  it("coarse fallback requires ratio ≥ 1.3", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange1m: 0, priceChange5m: 4, priceChange1h: 6,
        volumeUsd1m: 0, volumeUsd5m: 50_000, buyVolumeUsd1m: 0, sellVolumeUsd1m: 0,
        uniqueBuyers1m: 0, uniqueSellers1m: 0 },
      features: { buy_sell_ratio: { value: 1.0, timestamp: new Date(), confidence: 0.9 } },
    })));
    expect(d.decision).toBe("SKIP");
  });

  it("skips hostile regimes", () => {
    expect(strategy.evaluate(makeCtx(makeCandidate(), { marketRegime: "RISK_OFF" })).decision).toBe("SKIP");
    expect(strategy.evaluate(makeCtx(makeCandidate(), { marketRegime: "BEAR" })).decision).toBe("SKIP");
  });

  it("rejects draining liquidity (exit door closing)", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      liquidity: { liquidityUsd: 100_000, liquidityChange5m: -15 },
    })));
    expect(d.decision).toBe("REJECT");
  });

  it("rejects a crashing token (falling knife, not a scalp)", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange1m: 2, priceChange5m: -12, priceChange1h: -20,
        volumeUsd1m: 30_000, volumeUsd5m: 50_000, buyVolumeUsd1m: 20_000, sellVolumeUsd1m: 10_000,
        uniqueBuyers1m: 8, uniqueSellers1m: 3 },
    })));
    expect(d.decision).toBe("REJECT");
  });
});
