import { describe, expect, it } from "vitest";
import type { MarketConfig, MarketSnapshot } from "@autonomous-trader/shared";

import { computeMarketFeatures } from "../../features/feature-engine.js";
import type { TokenCandidate } from "../../lifecycle/candidate.js";
import { MarketFilter } from "../filters.js";

const config = {} as MarketConfig;

function candidate(market: MarketSnapshot): TokenCandidate {
  return { market } as unknown as TokenCandidate; // MarketFilter reads only .market
}

function market(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    tokenAddress: "EQtest",
    chain: "ton",
    price: 1,
    priceUsd: 1,
    volumeUsd1m: 0,
    volumeUsd5m: 0,
    volumeUsd15m: 0,
    volumeUsd1h: 0,
    volumeUsd24h: 0,
    priceChange1m: 0,
    priceChange5m: 0,
    priceChange15m: 0,
    priceChange1h: 0,
    priceChange24h: 0,
    buyCount1m: 0,
    sellCount1m: 0,
    buyVolumeUsd1m: 0,
    sellVolumeUsd1m: 0,
    uniqueBuyers1m: 0,
    uniqueSellers1m: 0,
    tradeCount24h: 0,
    uniqueTraders24h: 0,
    observedAt: new Date(),
    provider: "test",
    confidence: 0.9,
    ...overrides,
  };
}

describe("MarketFilter", () => {
  it("rejects when volume is zero at every granularity", () => {
    expect(MarketFilter.check(candidate(market({})), config)).toBe("ZERO_VOLUME");
  });

  it("passes TON tokens where DexScreener reports no m5 but real h1 volume", () => {
    // STON.fi/DeDust pairs never populate volume.m5 on DexScreener
    expect(
      MarketFilter.check(candidate(market({ volumeUsd1h: 124.85, volumeUsd24h: 3312 })), config),
    ).toBeNull();
  });

  it("still requires confidence", () => {
    expect(
      MarketFilter.check(candidate(market({ volumeUsd5m: 500, confidence: 0.3 })), config),
    ).toBe("MARKET_DATA_LOW_CONFIDENCE");
  });
});

describe("computeMarketFeatures buy_sell_ratio", () => {
  it("omits the feature when trade counts are absent (DexScreener/TON)", () => {
    const features = computeMarketFeatures(market({ volumeUsd1h: 100 }));
    expect(features.buy_sell_ratio).toBeUndefined();
  });

  it("computes ratio when counts exist", () => {
    const features = computeMarketFeatures(market({ buyCount1m: 5, sellCount1m: 2 }));
    expect(features.buy_sell_ratio?.value).toBe(2.5);
  });
});
