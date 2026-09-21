import { describe, it, expect } from "vitest";
import { PositionManager } from "../position-manager.js";
import {
  generateTradeIntentId,
  createLogger,
  type ExecutionResult,
  type TradeIntent,
  type MarketSnapshot,
  type LiquiditySnapshot,
} from "@autonomous-trader/shared";
import type { ExecutionRouter } from "@autonomous-trader/execution";

function execResult(price: number): ExecutionResult {
  return {
    tradeIntentId: generateTradeIntentId(),
    orderId: "order-1",
    status: "CONFIRMED",
    inputAmount: 100n,
    outputAmount: 1_000_000n,
    executedPrice: price,
    actualSlippageBps: 50,
    feesLamports: 5000n,
    feeUsd: 0.01,
    mode: "PAPER",
  };
}

function intent(token: string, strategyId: string): TradeIntent {
  return {
    id: generateTradeIntentId(),
    tokenAddress: token,
    chain: "ton",
    side: "BUY",
    mode: "PAPER",
    strategyId,
    strategyVersion: "1.0.0",
    riskVersion: "1.0.0",
    positionSizeUsd: 50,
    maxSlippageBps: 300,
    maxPriceImpactBps: 300,
    reason: "test",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

const input = (price: number, timestampMs: number) => ({
  market: { priceUsd: price } as MarketSnapshot,
  liquidity: { liquidityUsd: 100_000, liquidityChange5m: 0 } as LiquiditySnapshot,
  timestampMs,
});

describe("multiple concurrent positions per token", () => {
  it("holds scalp + shortterm + core slots side by side on one mint", () => {
    const m = new PositionManager({} as ExecutionRouter, createLogger({ t: "test" }));
    const t0 = Date.now();
    const scalp = m.openPosition(execResult(1), intent("TokT", "copytrade-scalp"), 0.95, 1.03, 1.06, 8, 20 * 60_000);
    const swing = m.openPosition(execResult(1), intent("TokT", "copytrade-shortterm"), 0.90, 1.05, 1.10, 15, 2 * 60 * 60_000);
    const core = m.openPosition(execResult(1), intent("TokT", "fresh-momentum"), 0.90, 1.05, 1.10, 15);
    expect(m.getOpenPositions()).toHaveLength(3);
    expect(m.getTokenExposureUsd("TokT")).toBe(150); // aggregate caps work per token

    // 21 minutes later: the scalp hit its 20min time stop, the others did not
    const late = t0 + 21 * 60_000;
    expect(m.updateAndCheckExit(scalp.id, input(1.0, late))?.reason).toContain("Time stop");
    expect(m.updateAndCheckExit(swing.id, input(1.0, late))).toBeNull();
    expect(m.updateAndCheckExit(core.id, input(1.0, late))).toBeNull();
  });

  it("restored copy positions recover their time stop from strategyId", () => {
    const m = new PositionManager({} as ExecutionRouter, createLogger({ t: "test" }));
    const opened = Date.now() - 21 * 60_000;
    // journal-restore path: timeStopMs lost, strategyId carries the profile
    m.restorePosition({
      id: "pos-restored",
      tokenAddress: "TokT",
      chain: "ton",
      status: "OPEN",
      mode: "PAPER",
      strategyId: "copytrade-scalp",
      entryPrice: 1,
      currentPrice: 1,
      sizeUsd: 50,
      sizeTokens: 1_000_000n,
      stopLoss: 0.95,
      peakPrice: 1,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      drawdownFromPeakPct: 0,
      openedAt: new Date(opened),
      updatedAt: new Date(opened),
    });
    const signal = m.updateAndCheckExit("pos-restored", input(1.0, Date.now()));
    expect(signal?.reason).toContain("Time stop");
  });
});
