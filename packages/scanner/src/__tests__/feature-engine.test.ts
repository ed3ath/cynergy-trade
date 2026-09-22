import { describe, it, expect } from "vitest";
import { computeMarketFeatures } from "../features/feature-engine.js";
import type { MarketSnapshot } from "@autonomous-trader/shared";

const base = {
  tokenAddress: "t",
  chain: "bsc" as const,
  price: 1,
  priceUsd: 1,
  volumeUsd1m: 0,
  volumeUsd5m: 100,
  volumeUsd15m: 0,
  volumeUsd1h: 1000,
  volumeUsd24h: 10_000,
  priceChange1m: 0,
  priceChange5m: 2,
  priceChange15m: 0,
  priceChange1h: 5,
  priceChange24h: 10,
  buyVolumeUsd1m: 0,
  sellVolumeUsd1m: 0,
  uniqueBuyers1m: 0,
  uniqueSellers1m: 0,
  tradeCount24h: 500,
  uniqueTraders24h: 0,
  observedAt: new Date(),
  provider: "dexscreener",
  confidence: 0.7,
};

describe("computeMarketFeatures buy_sell_ratio windows", () => {
  it("uses 5m counts when 1m is zero (DexScreener EVM path)", () => {
    const f = computeMarketFeatures({ ...base, buyCount1m: 0, sellCount1m: 0, buyCount5m: 600, sellCount5m: 300 } as MarketSnapshot);
    expect(f.buy_sell_ratio?.value).toBe(2);
  });

  it("falls back to 1h counts when 5m is also zero", () => {
    const f = computeMarketFeatures({ ...base, buyCount1m: 0, sellCount1m: 0, buyCount5m: 0, sellCount5m: 0, buyCount1h: 800, sellCount1h: 400 } as MarketSnapshot);
    expect(f.buy_sell_ratio?.value).toBe(2);
  });

  it("prefers 1m counts when present", () => {
    const f = computeMarketFeatures({ ...base, buyCount1m: 30, sellCount1m: 10, buyCount5m: 10, sellCount5m: 20, buyCount1h: 1, sellCount1h: 2 } as MarketSnapshot);
    expect(f.buy_sell_ratio?.value).toBe(3);
  });

  it("omits the feature when every window is zero (unknown, not bearish)", () => {
    const f = computeMarketFeatures({ ...base, buyCount1m: 0, sellCount1m: 0, buyCount5m: 0, sellCount5m: 0, buyCount1h: 0, sellCount1h: 0 } as MarketSnapshot);
    expect(f.buy_sell_ratio).toBeUndefined();
  });
});
