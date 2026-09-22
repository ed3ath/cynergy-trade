import { describe, expect, it } from "vitest";
import type {
  MarketConfig,
  DataFreshnessConfig,
  MarketSnapshot,
  LiquiditySnapshot,
  HolderSnapshot,
  SecurityAssessment,
  Logger,
} from "@autonomous-trader/shared";

import { Scanner, type ScannerConfig } from "../scanner.js";

const logger: Logger = {
  debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined,
} as unknown as Logger;

// Permissive thresholds — the feed test cares about mapping/sorting, not gating
const marketConfig = {
  minLiquidityUsd: 0, maxSlippageBps: 100000, minPoolAgeMs: 0, minHolders: 0,
  maxTop10ConcentrationPct: 100, maxInsiderPct: 100, maxSniperPct: 100, maxBundlerPct: 100,
} as unknown as MarketConfig;

const scannerConfig: ScannerConfig = {
  market: marketConfig,
  freshness: {} as DataFreshnessConfig,
  observationWindowMs: 0,
  refreshIntervalMs: 60_000,
  maxWatchlistSize: 50,
  maxCandidateAgeMs: 60_000_000,
};

function marketSnap(token: string, priceUsd: number, volume1h: number): MarketSnapshot {
  return {
    tokenAddress: token, chain: "ton", priceUsd, price: priceUsd,
    volumeUsd1m: 0, volumeUsd5m: 0, volumeUsd15m: 0, volumeUsd1h: volume1h, volumeUsd24h: volume1h * 24,
    priceChange1m: 0, priceChange5m: 1, priceChange15m: 0, priceChange1h: 2, priceChange24h: 3,
    buyCount1m: 0, sellCount1m: 0, buyVolumeUsd1m: 0, sellVolumeUsd1m: 0,
    uniqueBuyers1m: 0, uniqueSellers1m: 0, tradeCount24h: 10, uniqueTraders24h: 5,
    marketCapUsd: 100_000,
    observedAt: new Date(), provider: "test", confidence: 0.9,
  };
}

function liqSnap(token: string, liquidityUsd: number): LiquiditySnapshot {
  return {
    tokenAddress: token, chain: "ton", poolAddress: "EQpool", liquidityUsd,
    liquidityBase: 0, liquidityQuote: 0, poolAgeMs: 3_600_000,
    baseToken: token, quoteToken: "USDC", dex: "test-dex",
    baseTokenSymbol: "TST", baseTokenName: "Test Token",
    estimatedSlippageBps50: 0, estimatedSlippageBps500: 0, estimatedSlippageBps5000: 0,
    liquidityChange5m: 0, liquidityChange15m: 0,
    observedAt: new Date(), provider: "test", confidence: 0.9,
  };
}

function holderSnap(token: string, holders: number): HolderSnapshot {
  return {
    tokenAddress: token, chain: "ton", totalHolders: holders,
    top1Pct: 0, top5Pct: 0, top10Pct: 0, top20Pct: 0,
    creatorPct: 0, insiderPct: 0, sniperPct: 0, bundlerPct: 0, whalePct: 0,
    holderGrowth5m: 0, holderGrowth15m: 0, holderGrowth1h: 0,
    concentrationChange5m: 0, concentrationChange15m: 0,
    observedAt: new Date(), provider: "test", confidence: 0.9,
  };
}

function securitySnap(token: string): SecurityAssessment {
  return {
    tokenAddress: token, chain: "ton", status: "SAFE", score: 90,
    reasons: [], providerResults: [],
    checkedAt: new Date(), dataTimestamp: new Date(), ageMs: 0, confidence: 0.9,
  };
}

function makeScanner(markets: Record<string, MarketSnapshot | Error>): Scanner {
  const isDown = (t: string) => markets[t] instanceof Error; // all providers fail together
  const providers = {
    discovery: { subscribe: () => () => undefined, initialize: async () => undefined, shutdown: async () => undefined },
    market: { getMarketSnapshot: async (t: string) => {
      const v = markets[t];
      if (v instanceof Error) throw v;
      return v ?? marketSnap(t, 1, 100);
    } },
    liquidity: { getLiquiditySnapshot: async (t: string) => {
      if (isDown(t)) throw new Error("provider down");
      return liqSnap(t, 50_000);
    } },
    security: { analyzeToken: async (t: string) => {
      if (isDown(t)) throw new Error("provider down");
      return securitySnap(t);
    } },
    holders: { getHolderSnapshot: async (t: string) => {
      if (isDown(t)) throw new Error("provider down");
      return holderSnap(t, 100);
    } },
  };
  return new Scanner(scannerConfig, providers as unknown as Parameters<typeof Scanner>[1], logger);
}

const flush = () => new Promise((r) => setTimeout(r, 25));

describe("Scanner.getMarketFeed", () => {
  it("maps every tracked token with its latest snapshots, live statuses first", async () => {
    const scanner = makeScanner({
      GOOD: marketSnap("GOOD", 0.5, 500),           // passes gates → WATCHLIST
      DEAD: marketSnap("DEAD", 0.001, 0),           // zero volume → REJECTED
      NORES: new Error("provider down"),            // no snapshots → REJECTED, null fields
    });
    scanner.seedToken("GOOD", "ton");
    scanner.seedToken("DEAD", "ton");
    scanner.seedToken("NORES", "ton");
    await flush(); // seed → discovery → fetch+screen is async

    const feed = scanner.getMarketFeed();
    expect(feed.map((r) => r.token).sort()).toEqual(["DEAD", "GOOD", "NORES"]);

    const good = feed.find((r) => r.token === "GOOD")!;
    expect(good.status).toBe("WATCHLIST");
    expect(good.priceUsd).toBe(0.5);
    expect(good.priceChange1h).toBe(2);
    expect(good.volume24hUsd).toBe(500 * 24);
    expect(good.liquidityUsd).toBe(50_000);
    expect(good.marketCapUsd).toBe(100_000);
    expect(good.holders).toBe(100);
    expect(good.dex).toBe("test-dex");
    expect(good.symbol).toBe("TST");
    expect(good.name).toBe("Test Token");
    expect(good.rejection).toBeNull();
    expect(good.observedAt).toBeTypeOf("string");

    const dead = feed.find((r) => r.token === "DEAD")!;
    expect(dead.status).toBe("REJECTED");
    expect(dead.rejection).toMatch(/ZERO_VOLUME/);

    const nores = feed.find((r) => r.token === "NORES")!;
    expect(nores.priceUsd).toBeNull();
    expect(nores.liquidityUsd).toBeNull();
    expect(nores.observedAt).toBeNull();

    // Live tokens sort ahead of rejected ones
    expect(feed.findIndex((r) => r.token === "GOOD")).toBeLessThan(feed.findIndex((r) => r.token === "DEAD"));
  });

  it("refreshes TRADE_CANDIDATE tokens (regression: promoted tokens froze on stale data)", async () => {
    let price = 0.5;
    const markets: Record<string, MarketSnapshot | Error> = { GOOD: marketSnap("GOOD", price, 500) };
    const scanner = makeScanner(markets);
    scanner.seedToken("GOOD", "ton");
    await flush();
    expect(scanner.getCandidate("GOOD")?.status).toBe("WATCHLIST");

    // Promote (permissive gates → score from healthy fixtures is high), then
    // change the price and refresh: the candidate must pick up the new data.
    const cand = scanner.getCandidate("GOOD")!;
    scanner["transition"]("GOOD", "TRADE_CANDIDATE");
    expect(scanner.getCandidate("GOOD")?.status).toBe("TRADE_CANDIDATE");

    price = 0.9;
    markets["GOOD"] = marketSnap("GOOD", price, 500);
    await (scanner as unknown as { refreshCandidates(): Promise<void> }).refreshCandidates();

    expect(scanner.getMarketFeed()[0]?.priceUsd).toBe(0.9);
  });

  it("getMarketDetail returns full snapshots or null for unknown tokens", async () => {
    const scanner = makeScanner({
      GOOD: marketSnap("GOOD", 0.5, 500),
      NORES: new Error("provider down"),
    });
    scanner.seedToken("GOOD", "ton");
    scanner.seedToken("NORES", "ton");
    await flush();

    expect(scanner.getMarketDetail("MISSING")).toBeNull();

    const good = scanner.getMarketDetail("GOOD")!;
    expect(good.priceUsd).toBe(0.5);
    expect(good.market?.tradeCount24h).toBe(10);
    expect(good.liquidity?.poolAgeMs).toBe(3_600_000);
    expect(good.liquidity?.slippageBps500).toBe(0);
    expect(good.holderDist?.top10Pct).toBe(0);
    expect(good.security?.status).toBe("SAFE");
    expect(good.security?.checkedAt).toBeTypeOf("string");
    expect(typeof good.scores.opportunity).toBe("number");
    expect(good.rejectionReasons).toEqual([]);

    const nores = scanner.getMarketDetail("NORES")!;
    expect(nores.market).toBeNull();
    expect(nores.liquidity).toBeNull();
    expect(nores.holders).toBeNull();
    expect(nores.security).toBeNull();
    expect(nores.rejectionReasons.length).toBeGreaterThan(0);
  });
});
