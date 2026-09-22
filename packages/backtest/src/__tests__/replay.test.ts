import { describe, expect, it } from "vitest";
import { DataFreshnessConfigSchema, MarketConfigSchema } from "@autonomous-trader/shared";

import { runBacktest, type TokenSeries } from "../replay.js";

// Permissive gates — the replay test cares about entry/exit mechanics
const marketConfig = MarketConfigSchema.parse({
  minLiquidityUsd: 0.01, maxSlippageBps: 100_000, minPoolAgeMs: 1, minHolders: 1,
  maxTop10ConcentrationPct: 100, maxInsiderPct: 100, maxSniperPct: 100, maxBundlerPct: 100,
});
const freshnessConfig = DataFreshnessConfigSchema.parse({});

function series(token: string, prices: number[], h1 = 5, c5m = 2): TokenSeries {
  const t0 = Date.parse("2026-09-16T00:00:00Z");
  return {
    token, chain: "ton",
    rows: prices.map((priceUsd, i) => ({
      at: new Date(t0 + i * 60_000),
      market: {
        tokenAddress: token, chain: "ton" as const, priceUsd, price: priceUsd,
        marketCapUsd: priceUsd * 1e9,
        volumeUsd1m: 1_000, volumeUsd5m: 5_000, volumeUsd15m: 15_000,
        volumeUsd1h: 60_000, volumeUsd24h: 1_400_000,
        priceChange1m: 1, priceChange5m: c5m, priceChange15m: c5m, priceChange1h: h1, priceChange24h: 10,
        buyCount1m: 0, sellCount1m: 0,
        buyCount5m: 0, sellCount5m: 0, buyCount1h: 0, sellCount1h: 0,
        buyVolumeUsd1m: 0, sellVolumeUsd1m: 0,
        uniqueBuyers1m: 0, uniqueSellers1m: 0, tradeCount24h: 500, uniqueTraders24h: 100,
        observedAt: new Date(t0 + i * 60_000), provider: "test", confidence: 0.9,
      },
    })),
    liquidity: {
      tokenAddress: token, chain: "ton", poolAddress: "EQpool", liquidityUsd: 200_000,
      liquidityBase: 0, liquidityQuote: 0, poolAgeMs: 86_400_000,
      baseToken: token, quoteToken: "USDT", dex: "ston.fi",
      estimatedSlippageBps50: 10, estimatedSlippageBps500: 50, estimatedSlippageBps5000: 400,
      liquidityChange5m: 1, liquidityChange15m: 1,
      observedAt: new Date(t0), provider: "test", confidence: 0.9,
    },
    holders: {
      tokenAddress: token, chain: "ton", totalHolders: 2_000,
      top1Pct: 5, top5Pct: 20, top10Pct: 30, top20Pct: 45,
      creatorPct: 0, insiderPct: 0, sniperPct: 0, bundlerPct: 0, whalePct: 0,
      holderGrowth5m: 1, holderGrowth15m: 1, holderGrowth1h: 1,
      concentrationChange5m: 0, concentrationChange15m: 0,
      observedAt: new Date(t0), provider: "test", confidence: 0.9,
    },
    security: {
      tokenAddress: token, chain: "ton", status: "SAFE", score: 90,
      reasons: [], providerResults: [],
      checkedAt: new Date(t0), dataTimestamp: new Date(t0), ageMs: 0, confidence: 0.9,
    },
  };
}

const opts = { marketConfig, freshnessConfig };

describe("runBacktest", () => {
  it("enters on momentum, exits on TP1 (first take-profit level) with positive return", () => {
    // 1.0 → +3.5%/min: entry row0(+slip), full-exit TP = entry*1.03 hit first
    const prices = Array.from({ length: 30 }, (_, i) => 1 + i * 0.035);
    const r = runBacktest([series("RISE", prices)], opts);

    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const t = r.trades[0]!;
    expect(t.returnPct).toBeGreaterThan(2); // +3% full-exit minus slippage (policy: take profit early, 2026-09-22)
    expect(t.reason).toMatch(/Take profit 1/);
    expect(r.winRate).toBe(1);
  });

  it("never enters without momentum", () => {
    const flat = Array.from({ length: 30 }, () => 1);
    const r = runBacktest([series("FLAT", flat, /*h1*/ 0, /*c5m*/ 0)], opts);
    expect(r.trades).toHaveLength(0);
    expect(r.totalTokens).toBe(1);
    expect(r.tokensWithTrades).toBe(0);
  });

  it("exits via hard stop on an immediate dump", () => {
    // entry at row0 (~1.0), stop = 0.90 (-10% policy), next row crashes through it
    // (no +5% excursion first — that would take profit per the short-hold policy)
    const prices = [1, 0.8, 0.7, 0.6, 0.5];
    const r = runBacktest([series("DUMP", prices)], opts);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    expect(r.trades[0]!.reason).toMatch(/Hard stop loss/);
    expect(r.trades[0]!.returnPct).toBeLessThan(0);
  });

  it("closes still-open positions at END_OF_DATA", () => {
    // momentum entry then mild drift — no stop/TP/time hit in 30 rows
    const prices = [...Array.from({ length: 5 }, (_, i) => 1 + i * 0.05), ...Array.from({ length: 25 }, (_, i) => 1.25 - i * 0.001)];
    const r = runBacktest([series("DRIFT", prices)], opts);
    const last = r.trades.at(-1)!;
    expect(last.reason).toBe("END_OF_DATA");
  });
});
