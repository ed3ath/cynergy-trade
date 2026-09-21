import { describe, it, expect } from "vitest";
import { PositionManager } from "../position-manager.js";
import {
  generateTradeIntentId,
  createLogger,
  type ExecutionResult,
  type TradeIntent,
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

function intent(token: string): TradeIntent {
  return {
    id: generateTradeIntentId(),
    tokenAddress: token,
    chain: "solana",
    side: "BUY",
    mode: "PAPER",
    strategyId: "ai-autonomous",
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

function managerWithPosition(): PositionManager {
  const m = new PositionManager({} as ExecutionRouter, createLogger({ t: "test" }));
  m.openPosition(execResult(1), intent("TokT"), 0.9, 1.05, 1.1, 15);
  return m;
}

describe("PositionManager.tightenExits (one-way ratchet)", () => {
  it("raises the stop loss only when the new one is higher", () => {
    const m = managerWithPosition();
    const r1 = m.tightenExits(positionId(m), { stopLoss: 0.95 });
    expect(r1.applied).toEqual({ stopLoss: 0.95 });
    expect(r1.clamped).toEqual([]);
    const r2 = m.tightenExits(positionId(m), { stopLoss: 0.8 }); // widen attempt
    expect(r2.applied).toEqual({});
    expect(r2.clamped).toHaveLength(1);
    expect(m.getPosition(positionId(m))?.stopLoss).toBe(0.95); // unchanged
  });

  it("lowers take-profits only when the new one is lower", () => {
    const m = managerWithPosition();
    const r = m.tightenExits(positionId(m), { takeProfit1: 1.03, takeProfit2: 1.2 });
    expect(r.applied).toEqual({ takeProfit1: 1.03 }); // tp2 (1.2 > 1.1) clamped
    expect(m.getPosition(positionId(m))?.takeProfit1).toBe(1.03);
    expect(m.getPosition(positionId(m))?.takeProfit2).toBe(1.1);
  });

  it("lowers the trailing stop only when the new one is tighter", () => {
    const m = managerWithPosition();
    const r = m.tightenExits(positionId(m), { trailingStopPct: 8 });
    expect(r.applied).toEqual({ trailingStopPct: 8 });
    const r2 = m.tightenExits(positionId(m), { trailingStopPct: 20 }); // loosen attempt
    expect(r2.applied).toEqual({});
    expect(m.getPosition(positionId(m))?.trailingStopPct).toBe(8);
  });

  it("soft-fails on an unknown position id", () => {
    const m = managerWithPosition();
    const r = m.tightenExits("nope", { stopLoss: 2 });
    expect(r.applied).toEqual({});
    expect(r.clamped).toEqual(["unknown-position"]);
  });

  it("ignores non-finite and non-positive values", () => {
    const m = managerWithPosition();
    const r = m.tightenExits(positionId(m), { stopLoss: Number.NaN, takeProfit1: -1, trailingStopPct: Number.POSITIVE_INFINITY });
    expect(r.applied).toEqual({});
    expect(r.clamped).toEqual([]);
    expect(m.getPosition(positionId(m))?.stopLoss).toBe(0.9);
  });
});

function positionId(m: PositionManager): string {
  return m.getOpenPositions()[0]!.id;
}
