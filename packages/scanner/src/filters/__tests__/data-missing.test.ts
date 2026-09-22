/**
 * Data-missing tolerance — GoPlus returns no data for brand-new EVM pools;
 * that must not read as "0 holders" or "uncertain findings".
 */
import { describe, expect, it } from "vitest";
import type {
  HolderSnapshot,
  LiquiditySnapshot,
  MarketConfig,
  MarketSnapshot,
  SecurityAssessment,
} from "@autonomous-trader/shared";

import type { TokenCandidate } from "../../lifecycle/candidate.js";
import { HolderFilter, SecurityFilter } from "../filters.js";
import { DEFAULT_WEIGHTS, scoreCandidate } from "../../scoring/scorer.js";

const config: MarketConfig = {
  minLiquidityUsd: 15_000,
  maxSlippageBps: 300,
  maxPriceImpactBps: 500,
  minPoolAgeMs: 5 * 60 * 1000,
  maxTop10ConcentrationPct: 80,
  maxInsiderPct: 30,
  maxSniperPct: 20,
  maxBundlerPct: 15,
  minHolders: 50,
  observationWindowMs: 3 * 60 * 1000,
};

const noDataSecurity: SecurityAssessment = {
  tokenAddress: "0xabc", chain: "bsc", status: "UNKNOWN", score: 30,
  reasons: [{ code: "NO_DATA", message: "GoPlus returned no data for token", severity: "LOW" }],
  providerResults: [], checkedAt: new Date(), dataTimestamp: new Date(), ageMs: 0, confidence: 0.3,
};

const emptyHolders: HolderSnapshot = {
  tokenAddress: "0xabc", chain: "bsc", totalHolders: 0,
  top1Pct: 0, top5Pct: 0, top10Pct: 0, top20Pct: 0,
  creatorPct: 0, insiderPct: 0, sniperPct: 0, bundlerPct: 0, whalePct: 0,
  holderGrowth5m: 0, holderGrowth15m: 0, holderGrowth1h: 0,
  concentrationChange5m: 0, concentrationChange15m: 0,
  observedAt: new Date(), provider: "goplus-evm-holders", confidence: 0.1,
};

const liquidity: LiquiditySnapshot = {
  tokenAddress: "0xabc", chain: "bsc", poolAddress: "0xpool", dex: "pancakeswap",
  liquidityUsd: 20_000, liquidityBase: 10_000, liquidityQuote: 10_000,
  poolAgeMs: 10 * 60 * 1000, baseToken: "0xabc", quoteToken: "WBNB",
  estimatedSlippageBps50: 20, estimatedSlippageBps500: 100, estimatedSlippageBps5000: 900,
  liquidityChange5m: 0, liquidityChange15m: 0,
  observedAt: new Date(), provider: "dexscreener", confidence: 0.8,
};

const market: MarketSnapshot = {
  tokenAddress: "0xabc", chain: "bsc", price: 0.001, priceUsd: 0.001,
  volumeUsd1m: 120, volumeUsd5m: 500, volumeUsd15m: 1_400, volumeUsd1h: 5_000, volumeUsd24h: 20_000,
  priceChange1m: 0.4, priceChange5m: 2, priceChange15m: 6, priceChange1h: 12, priceChange24h: 30,
  buyCount1m: 9, sellCount1m: 4, buyVolumeUsd1m: 90, sellVolumeUsd1m: 30,
  uniqueBuyers1m: 7, uniqueSellers1m: 3, tradeCount24h: 800, uniqueTraders24h: 300,
  observedAt: new Date(), provider: "dexscreener", confidence: 0.8,
};

function candidate(overrides: Partial<TokenCandidate>): TokenCandidate {
  return {
    tokenAddress: "0xabc", chain: "bsc", status: "WATCHLIST",
    firstSeenAt: new Date(), lastUpdatedAt: new Date(), discoverySource: "geckoterminal",
    features: {}, scores: { security: 0, liquidity: 0, holder: 0, momentum: 0, marketQuality: 0, execution: 0, risk: 0, opportunity: 0 },
    rejectionReasons: [], refreshCount: 0,
    ...overrides,
  } as TokenCandidate;
}

describe("SecurityFilter data-missing", () => {
  it("passes UNKNOWN carrying only NO_DATA", () => {
    expect(SecurityFilter.check(candidate({ security: noDataSecurity }), config)).toBeNull();
  });

  it("passes UNKNOWN carrying only PROVIDER_ERROR", () => {
    const err: SecurityAssessment = {
      ...noDataSecurity, confidence: 0.2,
      reasons: [{ code: "PROVIDER_ERROR", message: "GoPlus HTTP 429", severity: "LOW" }],
    };
    expect(SecurityFilter.check(candidate({ security: err }), config)).toBeNull();
  });

  it("still rejects UNKNOWN with a real finding", () => {
    const found: SecurityAssessment = {
      ...noDataSecurity,
      reasons: [{ code: "UNVERIFIED_CONTRACT", message: "x", severity: "MEDIUM" }],
    };
    expect(SecurityFilter.check(candidate({ security: found }), config))
      .toBe("SECURITY_UNKNOWN_LOW_CONFIDENCE");
  });

  it("still rejects REJECT status", () => {
    expect(SecurityFilter.check(
      candidate({ security: { ...noDataSecurity, status: "REJECT" } }), config,
    )).toBe("SECURITY_REJECTED");
  });
});

describe("HolderFilter data-missing", () => {
  it("passes a zeroed low-confidence snapshot (0 holders ≠ data-missing check)", () => {
    expect(HolderFilter.check(candidate({ holders: emptyHolders }), config)).toBeNull();
  });

  it("still rejects genuinely few holders", () => {
    expect(HolderFilter.check(
      candidate({ holders: { ...emptyHolders, totalHolders: 10, confidence: 0.7 } }), config,
    )).toBe("TOO_FEW_HOLDERS:10");
  });

  it("still rejects real 0 holders reported with confidence", () => {
    expect(HolderFilter.check(
      candidate({ holders: { ...emptyHolders, confidence: 0.5 } }), config,
    )).toBe("TOO_FEW_HOLDERS:0");
  });
});

describe("scoreCandidate renormalization", () => {
  const both = candidate({ security: noDataSecurity, holders: emptyHolders, liquidity, market });
  const scored = scoreCandidate(both);

  it("excludes data-missing dims: composite = weighted mean of the present five", () => {
    const w = DEFAULT_WEIGHTS;
    const expected = (scored.liquidity * w.liquidity + scored.momentum * w.momentum
      + scored.marketQuality * w.marketQuality + scored.execution * w.execution
      + scored.risk * w.risk)
      / (w.liquidity + w.momentum + w.marketQuality + w.execution + w.risk);
    expect(scored.opportunity).toBeCloseTo(expected, 10);
  });

  it("composite beats the zero-drag version of the same candidate", () => {
    // Same numbers but security/holders absent entirely (scored as active 0s)
    const zeroed = scoreCandidate(candidate({ liquidity, market }));
    expect(scored.opportunity).toBeGreaterThan(zeroed.opportunity);
  });

  it("reports data-missing dims as 0 in the returned scores", () => {
    expect(scored.security).toBe(0);
    expect(scored.holder).toBe(0);
  });
});
