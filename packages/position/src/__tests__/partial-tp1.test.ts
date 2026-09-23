import { describe, it, expect } from "vitest";
import { PositionManager } from "../position-manager.js";
import {
  generateTradeIntentId,
  createLogger,
  type ExecutionResult,
  type TradeIntent,
} from "@autonomous-trader/shared";
import type { ExecutionRouter } from "@autonomous-trader/execution";

function execResult(price: number, outputAmount = 1_000_000n): ExecutionResult {
  return {
    tradeIntentId: generateTradeIntentId(),
    orderId: "order-1",
    status: "CONFIRMED",
    inputAmount: 100n,
    outputAmount,
    executedPrice: price,
    actualSlippageBps: 50,
    feesLamports: 5000n,
    feeUsd: 0.01,
    mode: "PAPER",
  };
}

function buyIntent(sizeUsd: number): TradeIntent {
  return {
    id: generateTradeIntentId(),
    tokenAddress: "TokT",
    chain: "solana",
    side: "BUY",
    mode: "PAPER",
    strategyId: "ai-autonomous",
    strategyVersion: "1.0.0",
    riskVersion: "1.0.0",
    positionSizeUsd: sizeUsd,
    maxSlippageBps: 300,
    maxPriceImpactBps: 300,
    reason: "test",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

/** Fake router: SELL always confirms at `sellPrice`. */
function router(sellPrice: number): ExecutionRouter {
  return { execute: async () => execResult(sellPrice) } as unknown as ExecutionRouter;
}

/** $50 position @ $1, TP1 +3%, TP2 +10%, stop -10%. */
function managerAtTp1(router_: ExecutionRouter): PositionManager {
  const m = new PositionManager(router_, createLogger({ t: "test" }));
  m.openPosition(execResult(1, 50_000_000_000n), buyIntent(50), 0.9, 1.03, 1.1, 15);
  return m;
}

function sellIntent(sizeUsd: number): TradeIntent {
  return { ...buyIntent(sizeUsd), side: "SELL" } as TradeIntent;
}

const liq20k = { liquidityUsd: 100_000, liquidityChange5m: 0 };

describe("PositionManager TP1 partial exit", () => {
  it("reducePosition sells half: size halves, TP1 cleared, status PARTIAL_EXIT, still managed", async () => {
    const m = managerAtTp1(router(1.03));
    const id = m.getOpenPositions()[0]!.id;

    const { position } = await m.reducePosition(id, 0.5, 1.03, sellIntent(25));

    expect(position.sizeUsd).toBeCloseTo(25);
    expect(position.takeProfit1).toBeUndefined();
    expect(position.status).toBe("PARTIAL_EXIT");
    expect(m.getOpenPositions().map((p) => p.id)).toContain(id); // still managed
    // tokens: sold 25 USD @ 1.03 = ~24.27e9 nano; 50e9 - 24.27e9 > 0
    expect(position.sizeTokens).toBeGreaterThan(0n);
  });

  it("TP1 never re-fires after the partial; TP2 still closes the remainder", async () => {
    const m = managerAtTp1(router(1.03));
    const id = m.getOpenPositions()[0]!.id;
    await m.reducePosition(id, 0.5, 1.03, sellIntent(25));

    // price still above the old TP1 → no signal (TP1 gone, TP2 not reached)
    const s = m.updateAndCheckExit(id, {
      market: { priceUsd: 1.05 } as never,
      liquidity: liq20k as never,
      timestampMs: Date.now(),
    });
    expect(s).toBeNull();

    // price above TP2 → TP2 signal (full-exit path in the trader)
    const s2 = m.updateAndCheckExit(id, {
      market: { priceUsd: 1.12 } as never,
      liquidity: liq20k as never,
      timestampMs: Date.now(),
    });
    expect(s2?.reason.startsWith("Take profit 2")).toBe(true);
  });

  it("hard stop still fires on a PARTIAL_EXIT position", async () => {
    const m = managerAtTp1(router(1.03));
    const id = m.getOpenPositions()[0]!.id;
    await m.reducePosition(id, 0.5, 1.03, sellIntent(25));

    const s = m.updateAndCheckExit(id, {
      market: { priceUsd: 0.85 } as never,
      liquidity: liq20k as never,
      timestampMs: Date.now(),
    });
    expect(s?.urgency).toBe("EMERGENCY");
    expect(s?.reason.startsWith("Hard stop")).toBe(true);
  });

  it("rejects bad fractions and unconfirmed fills leave size unchanged", async () => {
    const failing: ExecutionRouter = {
      execute: async () => ({ ...execResult(1.03), status: "FAILED" }),
    } as unknown as ExecutionRouter;
    const m = managerAtTp1(failing);
    const id = m.getOpenPositions()[0]!.id;

    await expect(m.reducePosition(id, 0, 1.03, sellIntent(25))).rejects.toThrow();
    await expect(m.reducePosition(id, 1.5, 1.03, sellIntent(25))).rejects.toThrow();
    await expect(m.reducePosition(id, 0.5, 1.03, sellIntent(25))).rejects.toThrow(/not confirmed/);
    expect(m.getPosition(id)!.sizeUsd).toBe(50); // unchanged
    expect(m.getPosition(id)!.status).toBe("OPEN");
  });

  it("restorePosition keeps PARTIAL_EXIT status (restart keeps TP1 spent)", () => {
    const m = managerAtTp1(router(1.03));
    const snapshot = m.getOpenPositions()[0]!;
    const fresh = new PositionManager(router(1.03), createLogger({ t: "test" }));
    fresh.restorePosition({ ...snapshot, status: "PARTIAL_EXIT" });
    expect(fresh.getOpenPositions()[0]!.status).toBe("PARTIAL_EXIT");
  });
});
