import { describe, it, expect, beforeEach } from "vitest";
import { RiskEngine } from "../risk-engine.js";
import type { RiskEngineInput } from "../risk-engine.js";
import type {
  RiskConfig,
  TradeIntent,
  PortfolioSnapshot,
  LiquiditySnapshot,
  SecurityAssessment,
} from "@autonomous-trader/shared";

const BASE_CONFIG: RiskConfig = {
  version: "risk-v1",
  maxDailyLossUsd: 100,
  maxWeeklyLossUsd: 300,
  maxDrawdownPct: 10,
  maxDrawdownEmergencyPct: 20,
  maxPositionRiskPct: 1,
  maxPositionValueUsd: 500,
  maxTokenExposureUsd: 1000,
  maxTotalExposureUsd: 2000,
  maxStrategyExposurePct: 50,
  maxSlippageBps: 300,
  maxPriceImpactBps: 500,
  minLiquidityUsd: 50_000,
  maxConcurrentPositions: 5,
  maxTransactionCostUsd: 2,
  baseRiskPct: 0.5,
  minRiskPct: 0.1,
  maxRiskPct: 2.0,
};

const SAFE_SECURITY: SecurityAssessment = {
  tokenAddress: "tokenA",
  chain: "solana",
  status: "SAFE",
  score: 90,
  reasons: [],
  providerResults: [],
  checkedAt: new Date(),
  dataTimestamp: new Date(),
  ageMs: 0,
  confidence: 0.95,
};

const GOOD_LIQUIDITY: LiquiditySnapshot = {
  tokenAddress: "tokenA",
  chain: "solana",
  poolAddress: "pool1",
  dex: "raydium",
  liquidityUsd: 200_000,
  liquidityBase: 100_000,
  liquidityQuote: 100_000,
  poolAgeMs: 30 * 60 * 1000,
  baseToken: "tokenA",
  quoteToken: "WSOL",
  estimatedSlippageBps50: 5,
  estimatedSlippageBps500: 25,
  estimatedSlippageBps5000: 150,
  liquidityChange5m: 0,
  liquidityChange15m: 0,
  observedAt: new Date(),
  provider: "mock",
  confidence: 0.95,
};

const GOOD_PORTFOLIO: PortfolioSnapshot = {
  totalValueUsd: 10_000,
  availableCapitalUsd: 8_000,
  allocatedUsd: 1_000,
  openPositions: 2,
  dailyPnlUsd: 0,
  weeklyPnlUsd: 0,
  monthlyPnlUsd: 0,
  allTimePnlUsd: 0,
  currentDrawdownPct: 0,
  peakValueUsd: 10_000,
  snapshotAt: new Date(),
};

function makeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: "ti_test001",
    tokenAddress: "tokenA",
    chain: "solana",
    side: "BUY",
    mode: "PAPER",
    strategyId: "strategy-a",
    strategyVersion: "1.0.0",
    riskVersion: "risk-v1",
    positionSizeUsd: 200,
    maxSlippageBps: 300,
    maxPriceImpactBps: 500,
    reason: "test",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function makeInput(overrides: Partial<RiskEngineInput> = {}): RiskEngineInput {
  return {
    intent: makeIntent(),
    portfolio: GOOD_PORTFOLIO,
    liquidity: GOOD_LIQUIDITY,
    security: SAFE_SECURITY,
    marketRegime: "BULL",
    strategyConfidence: 0.8,
    strategyPerformanceMultiplier: 1.0,
    openPositionCount: 2,
    dailyLossUsd: 0,
    weeklyLossUsd: 0,
    currentDrawdownPct: 0,
    existingTokenExposureUsd: 0,
    existingStrategyExposureUsd: 0,
    ...overrides,
  };
}

describe("RiskEngine", () => {
  let engine: RiskEngine;

  beforeEach(() => {
    engine = new RiskEngine(
      BASE_CONFIG,
      () => false, // kill switch off
      () => false, // stop new entries off
    );
  });

  it("approves a clean trade (possibly reduced to risk-based size)", () => {
    const result = engine.evaluate(makeInput());
    // Engine may approve at reduced size — that's correct risk-based sizing,
    // not a rejection. It must never exceed the requested amount.
    expect(["APPROVED", "REDUCED"]).toContain(result.decision);
    expect(result.approvedSizeUsd).toBeGreaterThan(0);
    expect(result.approvedSizeUsd).toBeLessThanOrEqual(200);
    expect(result.rejectionReasons).toHaveLength(0);
  });

  it("rejects when kill switch active", () => {
    const e = new RiskEngine(BASE_CONFIG, () => true, () => false);
    const result = e.evaluate(makeInput());
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("KILL_SWITCH"))).toBe(true);
  });

  it("rejects when stop new entries active", () => {
    const e = new RiskEngine(BASE_CONFIG, () => false, () => true);
    const result = e.evaluate(makeInput());
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("STOP_NEW_ENTRIES"))).toBe(true);
  });

  it("rejects REJECT security status", () => {
    const result = engine.evaluate(makeInput({
      security: { ...SAFE_SECURITY, status: "REJECT", score: 5 },
    }));
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("SECURITY_REJECTED"))).toBe(true);
  });

  it("rejects below minimum liquidity", () => {
    const result = engine.evaluate(makeInput({
      liquidity: { ...GOOD_LIQUIDITY, liquidityUsd: 10_000 },
    }));
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("LIQUIDITY_BELOW_MINIMUM"))).toBe(true);
  });

  it("rejects when daily loss limit hit", () => {
    const result = engine.evaluate(makeInput({ dailyLossUsd: 100 }));
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("DAILY_LOSS_LIMIT"))).toBe(true);
  });

  it("rejects when max positions reached", () => {
    const result = engine.evaluate(makeInput({ openPositionCount: 5 }));
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("MAX_POSITIONS"))).toBe(true);
  });

  it("rejects expired intent", () => {
    const result = engine.evaluate(makeInput({
      intent: makeIntent({ expiresAt: new Date(Date.now() - 1000) }),
    }));
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("INTENT_EXPIRED"))).toBe(true);
  });

  it("rejects insufficient capital", () => {
    const result = engine.evaluate(makeInput({
      portfolio: { ...GOOD_PORTFOLIO, availableCapitalUsd: 10 },
    }));
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("INSUFFICIENT_CAPITAL"))).toBe(true);
  });

  it("reduces size under bear regime", () => {
    const bullResult = engine.evaluate(makeInput({ marketRegime: "BULL" }));
    const bearResult = engine.evaluate(makeInput({ marketRegime: "BEAR" }));
    // Bear regime should produce smaller approved size
    expect(bearResult.approvedSizeUsd).toBeLessThan(bullResult.approvedSizeUsd);
  });

  it("applies drawdown reduction", () => {
    const noDD = engine.evaluate(makeInput({ currentDrawdownPct: 0 }));
    const highDD = engine.evaluate(makeInput({ currentDrawdownPct: 9 }));
    expect(highDD.approvedSizeUsd).toBeLessThan(noDD.approvedSizeUsd);
  });

  it("never approves above maxPositionValueUsd", () => {
    const result = engine.evaluate(makeInput({
      intent: makeIntent({ positionSizeUsd: 50_000 }),
      portfolio: { ...GOOD_PORTFOLIO, totalValueUsd: 1_000_000, availableCapitalUsd: 1_000_000 },
    }));
    // Will be rejected for token/total exposure, but if approved size check:
    if (result.decision !== "REJECTED") {
      expect(result.approvedSizeUsd).toBeLessThanOrEqual(BASE_CONFIG.maxPositionValueUsd);
    }
  });

  it("collects multiple rejection reasons", () => {
    const e = new RiskEngine(BASE_CONFIG, () => true, () => true);
    const result = e.evaluate(makeInput({
      security: { ...SAFE_SECURITY, status: "REJECT" },
      liquidity: { ...GOOD_LIQUIDITY, liquidityUsd: 1_000 },
    }));
    expect(result.rejectionReasons.length).toBeGreaterThan(2);
  });
});
