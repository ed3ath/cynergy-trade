import { describe, it, expect } from "vitest";
import { BreakoutContinuationStrategy } from "../strategies/breakout-continuation.js";
import { DipReversionStrategy } from "../strategies/dip-reversion.js";
import { MicroScalpStrategy } from "../strategies/micro-scalp.js";
import type { StrategyContext } from "../engine/strategy-interface.js";
import type { TokenCandidate } from "@autonomous-trader/scanner";

function makeCandidate(overrides: Record<string, unknown> = {}): TokenCandidate {
  return {
    tokenAddress: "tokenA",
    chain: "bsc",
    status: "TRADE_CANDIDATE",
    scores: { opportunity: 70 },
    market: { priceUsd: 0.001 },
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

describe("BreakoutContinuationStrategy", () => {
  const strategy = new BreakoutContinuationStrategy();

  it("enters on a multi-window breakout with flow confirmation", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange5m: 2, priceChange15m: 8, priceChange1h: 20, volumeUsd5m: 9_000 },
      features: { buy_sell_ratio: { value: 1.6 } },
    })));
    expect(d.decision).toBe("ENTER");
    expect(d.suggestedTrailingStopPct).toBe(7);
    expect(d.suggestedStopLoss).toBeCloseTo(0.001 * 0.92, 9);
  });

  it("skips when only one window is positive (impulse, not trend)", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange5m: 1, priceChange15m: 2, priceChange1h: 3, volumeUsd5m: 9_000 },
      features: { buy_sell_ratio: { value: 1.6 } },
    })));
    expect(d.decision).toBe("SKIP");
  });

  it("enters on turnover-only confirmation when flow counts are missing", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange5m: 2, priceChange15m: 8, priceChange1h: 20, volumeUsd5m: 9_000 },
      holders: { holderGrowth5m: 0 },
    })));
    expect(d.decision).toBe("ENTER");
    expect(d.risks.some((r) => r.includes("turnover-only"))).toBe(true);
  });

  it("skips a vertical move (buying exit liquidity)", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange5m: 30, priceChange15m: 60, priceChange1h: 150, volumeUsd5m: 9_000 },
      features: { buy_sell_ratio: { value: 1.6 } },
    })));
    expect(d.decision).toBe("SKIP");
  });
});

describe("DipReversionStrategy", () => {
  const strategy = new DipReversionStrategy();

  it("enters on a stabilized dip inside a 24h uptrend", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange24h: 30, priceChange1h: -6, priceChange15m: -7, priceChange5m: -1, volumeUsd5m: 9_000 },
      features: { buy_sell_ratio: { value: 0.9 } },
    })));
    expect(d.decision).toBe("ENTER");
    expect(d.suggestedStopLoss).toBeCloseTo(0.001 * 0.94, 9);
    expect(d.suggestedTrailingStopPct).toBe(4);
  });

  it("skips without a 24h anchor (fresh launches never fire)", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange24h: 0, priceChange1h: -6, priceChange15m: -7, priceChange5m: -1 },
      features: { buy_sell_ratio: { value: 0.9 } },
    })));
    expect(d.decision).toBe("SKIP");
  });

  it("skips a collapsing token (falling knife, not a dip)", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange24h: 30, priceChange1h: -20, priceChange15m: -25, priceChange5m: -3 },
      features: { buy_sell_ratio: { value: 0.9 } },
    })));
    expect(d.decision).toBe("SKIP");
  });

  it("skips when sellers overwhelm the dip", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange24h: 30, priceChange1h: -6, priceChange15m: -7, priceChange5m: -1 },
      features: { buy_sell_ratio: { value: 0.4 } },
    })));
    expect(d.decision).toBe("SKIP");
  });
});

describe("MicroScalpStrategy turnover fallback", () => {
  const strategy = new MicroScalpStrategy();

  it("enters on 5m turnover ≥5% of pool when ratio and holders are missing", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange1m: 0, priceChange5m: 3, priceChange1h: 5,
        volumeUsd1m: 0, volumeUsd5m: 9_000, buyVolumeUsd1m: 0, sellVolumeUsd1m: 0, uniqueBuyers1m: 0 },
      holders: undefined,
    })));
    expect(d.decision).toBe("ENTER");
    expect(d.risks.some((r) => r.includes("turnover-only"))).toBe(true);
    expect(d.confidence).toBeLessThan(0.7);
  });

  it("still skips when turnover is thin too", () => {
    const d = strategy.evaluate(makeCtx(makeCandidate({
      market: { priceUsd: 0.001, priceChange1m: 0, priceChange5m: 3, priceChange1h: 5,
        volumeUsd1m: 0, volumeUsd5m: 500, buyVolumeUsd1m: 0, sellVolumeUsd1m: 0, uniqueBuyers1m: 0 },
      holders: undefined,
    })));
    expect(d.decision).toBe("SKIP");
    expect(d.risks[0]).toContain("No volume/holder confirmation");
  });
});
