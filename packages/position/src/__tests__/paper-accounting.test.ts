import { describe, expect, it, vi } from "vitest";
import { createLogger, generateTradeIntentId, type TradeIntent, type ExecutionResult, type Position } from "@autonomous-trader/shared";
import { InMemoryIdempotencyGuard, PaperExecutionRouter, type ExecutionRouter } from "@autonomous-trader/execution";
import { EMERGENCY_LIQUIDITY_FLOOR_USD, PositionManager } from "../position-manager.js";

const log = createLogger({ component: "paper-accounting-test" });
const paper = () => new PaperExecutionRouter(log, new InMemoryIdempotencyGuard());
function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: generateTradeIntentId(), tokenAddress: "token", chain: "base", mode: "PAPER", side: "BUY",
    strategyId: "test", strategyVersion: "1", riskVersion: "1", positionSizeUsd: 3,
    maxSlippageBps: 300, maxPriceImpactBps: 300, reason: "test", createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000), ...overrides,
  };
}
function sell(position: Position, fraction = 1): TradeIntent {
  return intent({ side: "SELL", mode: position.mode, positionId: position.id,
    positionSizeUsd: position.sizeUsd * fraction,
    paperTokenQuantity: fraction === 1 ? position.sizeTokens : position.sizeTokens / 2n });
}
const signal = { reason: "test exit", urgency: "NORMAL" as const, suggestedSellPct: 100 };
async function opened(router?: ExecutionRouter) {
  const buyIntent = intent();
  const buy = await paper().execute(buyIntent, 1);
  const manager = new PositionManager(router ?? paper(), log);
  const position = manager.openPosition(buy, buyIntent, 0.9, 1.03, 1.1, 15);
  return { manager, position, buy, buyIntent };
}
function legacy(position: Position): Position {
  const restored = structuredClone(position);
  for (const field of ["accountingVersion", "initialSizeUsd", "initialSizeTokens", "entryFeeUsd", "remainingEntryFeeUsd",
    "realizedPnlUsd", "realizedGrossPnlUsd", "totalFeesUsd", "entryOrderId", "exitOrderId"] as const) delete restored[field];
  return restored;
}

describe("confirmed PAPER accounting", () => {
  it("never opens from unconfirmed, non-finite, or mismatched execution data", async () => {
    const buyIntent = intent();
    const buy = await paper().execute(buyIntent, 1);
    for (const bad of [
      { status: "UNKNOWN" as const }, { status: "FAILED" as const }, { tradeIntentId: "wrong-intent" },
      { executedPrice: NaN }, { executedPrice: Infinity }, { feeUsd: NaN }, { inputAmount: 0n }, { outputAmount: 0n },
    ]) {
      const manager = new PositionManager(paper(), log);
      expect(() => manager.openPosition({ ...buy, ...bad }, buyIntent, 0.9)).toThrow();
      expect(manager.getAllPositions()).toEqual([]);
    }
  });

  it("books exact flat-price fill-net PnL, fees, cash, and completed remainder", async () => {
    const { manager, position } = await opened();
    expect(position.accountingVersion).toBe(2);
    expect(position.unrealizedPnlUsd).toBeCloseTo(-0.0005, 12);
    expect(manager.getLastAccounting(position.id)?.cashDeltaUsd).toBe(-3.0005);
    manager.updateAndCheckExit(position.id, { market: { priceUsd: 1 } as never, timestampMs: Date.now() });
    expect(position.unrealizedPnlUsd).toBeCloseTo(-0.0455, 12);
    const exit = await manager.exitPosition(position.id, signal, 1, sell(position));
    expect(exit.outputAmount).toBe(2_910_675n);
    expect(position).toMatchObject({ status: "CLOSED", sizeUsd: 0, sizeTokens: 0n,
      initialSizeUsd: 3, initialSizeTokens: 2_955_000_000n, remainingEntryFeeUsd: 0, totalFeesUsd: 0.001 });
    expect(position.realizedGrossPnlUsd).toBeCloseTo(-0.089325, 12);
    expect(position.realizedPnlUsd).toBeCloseTo(-0.090325, 12);
    expect(position.unrealizedPnlUsd).toBe(0);
    expect(position.exitOrderId).toBe(exit.orderId);
    expect(position.closedAt).toEqual(exit.confirmedAt);
    expect(manager.getTotalExposureUsd()).toBe(0);
  });

  it("conserves tokens and proportional fees across rising TP1, restart, and falling final exit", async () => {
    const { manager, position } = await opened();
    const entryCash = manager.getLastAccounting(position.id)!.cashDeltaUsd;
    const partial = await manager.reducePosition(position.id, 0.5, 1.2, sell(position, 0.5));
    expect(partial.result.inputAmount).toBe(1_477_500_000n);
    expect(position.sizeTokens).toBe(1_477_500_000n);
    expect(position.sizeUsd).toBe(1.5);
    expect(position.remainingEntryFeeUsd).toBe(0.00025);
    expect(partial.accounting?.allocatedEntryFeeUsd).toBe(0.00025);
    expect(position.realizedPnlUsd).toBeCloseTo(0.245655, 12);
    const resumed = new PositionManager(paper(), log);
    resumed.restorePosition(structuredClone(position));
    const remaining = resumed.getPosition(position.id)!;
    expect(remaining.takeProfit1).toBeUndefined();
    const final = await resumed.exitPosition(remaining.id, signal, 0.8, sell(remaining));
    expect(final.inputAmount + partial.result.inputAmount).toBe(position.initialSizeTokens);
    expect(remaining.totalFeesUsd).toBeCloseTo(0.0015, 12);
    expect(remaining.realizedPnlUsd).toBeCloseTo(-0.090825, 12);
    expect(entryCash + partial.accounting!.cashDeltaUsd + resumed.getLastAccounting(remaining.id)!.cashDeltaUsd)
      .toBeCloseTo(remaining.realizedPnlUsd!, 12);
  });

  it("TP1 signals exactly half and remains spent while the partial can still tighten", async () => {
    const { manager, position } = await opened();
    const tp = manager.updateAndCheckExit(position.id, { market: { priceUsd: 1.04 } as never, timestampMs: Date.now() });
    expect(tp?.suggestedSellPct).toBe(50);
    await manager.reducePosition(position.id, 0.5, 1.04, sell(position, 0.5));
    const tightened = manager.tightenExits(position.id, { stopLoss: 0.99, takeProfit1: 1.02, trailingStopPct: 8 });
    expect(tightened.applied).toEqual({ stopLoss: 0.99, trailingStopPct: 8 });
    expect(tightened.clamped).toContain("takeProfit1-already-spent");
    expect(position.takeProfit1).toBeUndefined();
    expect(manager.tightenExits(position.id, { stopLoss: 0.8, trailingStopPct: 20 }).applied).toEqual({});
    expect(manager.updateAndCheckExit(position.id, { market: { priceUsd: 1.04 } as never, timestampMs: Date.now() })).toBeNull();
  });

  it("leaves the odd nano remainder for the final exit", async () => {
    const buyIntent = intent({ maxSlippageBps: 0 });
    const buy = await paper().execute(buyIntent, 1);
    const manager = new PositionManager(paper(), log);
    const position = manager.openPosition({ ...buy, outputAmount: 3_000_000_001n }, buyIntent, 0.9);
    const partial = await manager.reducePosition(position.id, 0.5, 1, sell(position, 0.5));
    expect(partial.result.inputAmount).toBe(1_500_000_000n);
    expect(position.sizeTokens).toBe(1_500_000_001n);
    const final = await manager.exitPosition(position.id, signal, 1, sell(position));
    expect(final.inputAmount).toBe(1_500_000_001n);
    expect(position.sizeTokens).toBe(0n);
  });

  it.each(["FAILED", "UNKNOWN", "SUBMITTED"] as const)("does not change PAPER holdings for %s exits", async (status) => {
    const router: ExecutionRouter = { execute: async (intent, price) => ({ ...await paper().execute(intent, price), status }) };
    const { manager, position } = await opened(router);
    const before = structuredClone(position);
    await expect(manager.exitPosition(position.id, signal, 1, sell(position))).rejects.toThrow(/not confirmed/);
    expect(position).toEqual(before);
    await expect(manager.reducePosition(position.id, 0.5, 1, sell(position, 0.5))).rejects.toThrow(/not confirmed/);
    expect(position).toEqual(before);
  });

  it("leaves PAPER holdings unchanged on thrown errors, invalid identity/price/fraction, and oversells", async () => {
    const execute = vi.fn(async () => { throw new Error("simulation failure"); });
    const { manager, position } = await opened({ execute });
    const before = structuredClone(position);
    for (const fraction of [NaN, Infinity, -1, 0, 1]) {
      await expect(manager.reducePosition(position.id, fraction, 1, sell(position, 0.5))).rejects.toThrow();
    }
    for (const price of [NaN, Infinity, -1, 0]) {
      await expect(manager.exitPosition(position.id, signal, price, sell(position))).rejects.toThrow();
    }
    await expect(manager.exitPosition(position.id, signal, 1, { ...sell(position), chain: "ton" })).rejects.toThrow();
    await expect(manager.exitPosition(position.id, signal, 1, { ...sell(position), paperTokenQuantity: position.sizeTokens + 1n })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(manager.exitPosition(position.id, signal, 1, sell(position))).rejects.toThrow(/simulation failure/);
    expect(position).toEqual(before);
  });

  it("rejects duplicate entries and replayed exit orders, including after restart", async () => {
    const { manager, position, buy, buyIntent } = await opened();
    expect(() => manager.openPosition(buy, buyIntent, 0.9)).toThrow(/Duplicate/);
    const exitIntent = sell(position, 0.5);
    const partial = await manager.reducePosition(position.id, 0.5, 1, exitIntent);
    await expect(manager.reducePosition(position.id, 0.5, 1, exitIntent)).rejects.toThrow(/Duplicate/);
    const resumed = new PositionManager({ execute: async () => partial.result }, log);
    resumed.restorePosition(structuredClone(position));
    const before = structuredClone(resumed.getPosition(position.id));
    await expect(resumed.exitPosition(position.id, signal, 1, { ...exitIntent, positionSizeUsd: 1.5 })).rejects.toThrow(/Duplicate/);
    expect(resumed.getPosition(position.id)).toEqual(before);
  });

  it("serializes conflicting executions without claiming a close before confirmation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const router: ExecutionRouter = { execute: async (intent, price) => { await gate; return paper().execute(intent, price); } };
    const { manager, position } = await opened(router);
    const closing = manager.exitPosition(position.id, signal, 1, sell(position));
    expect(position.status).toBe("OPEN");
    await expect(manager.exitPosition(position.id, signal, 1, sell(position))).rejects.toThrow(/in flight/);
    release();
    await closing;
    expect(position.status).toBe("CLOSED");
  });

  it("keeps price stops independent of unavailable/invalid liquidity and consumes security REJECT", async () => {
    const { manager, position } = await opened();
    expect(EMERGENCY_LIQUIDITY_FLOOR_USD).toBe(20_000);
    const input = { market: { priceUsd: 0.85 } as never, timestampMs: Date.now() };
    expect(manager.updateAndCheckExit(position.id, input)?.reason).toMatch(/Hard stop/);
    expect(manager.updateAndCheckExit(position.id, { ...input, market: { priceUsd: 1 } as never,
      liquidity: { liquidityUsd: NaN, liquidityChange5m: NaN } as never })).toBeNull();
    expect(manager.updateAndCheckExit(position.id, { ...input, market: { priceUsd: 1 } as never,
      security: { status: "REJECT" } as never })?.urgency).toBe("EMERGENCY");
    const before = structuredClone(position);
    expect(manager.updateAndCheckExit(position.id, { ...input, market: { priceUsd: NaN } as never })).toBeNull();
    expect(position).toEqual(before);
  });

  it("keeps known legacy exits cash-only and unknown partial quantities fail closed", async () => {
    const { position } = await opened();
    const manager = new PositionManager(paper(), log);
    const restored = { ...legacy(position), realizedPnlUsd: -0.2, unrealizedPnlUsd: -0.3 };
    manager.restorePosition(restored);
    await manager.exitPosition(restored.id, signal, 1, sell(restored));
    expect(restored.accountingVersion).toBeUndefined();
    expect(restored.realizedPnlUsd).toBe(-0.2);
    expect(restored.unrealizedPnlUsd).toBe(-0.3);
    expect(restored.dataQuality).toContain("legacy-realized-pnl-unknown");
    expect(manager.getLastAccounting(restored.id)).toMatchObject({ realizedPnlDeltaUsd: null, soldCostBasisUsd: null });
    const uncertain = new PositionManager(paper(), log);
    const partial = { ...legacy(position), status: "PARTIAL_EXIT" as const };
    uncertain.restorePosition(partial);
    await expect(uncertain.exitPosition(partial.id, signal, 1, sell(partial))).rejects.toThrow(/unresolved/);
    expect(uncertain.getTotalExposureUsd()).toBe(3);
  });

  it.each(["SHADOW", "LIVE"] as const)("does not turn %s native amounts into PAPER dollars or token-nano", async (mode) => {
    const buyIntent = intent({ mode });
    const native: ExecutionResult = { tradeIntentId: buyIntent.id, orderId: "native-buy", mode,
      status: "CONFIRMED", inputAmount: 9_000_000_000n, outputAmount: 400n, executedPrice: 1,
      actualSlippageBps: 0, feesLamports: 1n, feeUsd: 0.001 };
    const execute = vi.fn(async (intent: TradeIntent) => ({ ...native, tradeIntentId: intent.id,
      orderId: generateTradeIntentId(), inputAmount: 200n, outputAmount: 8_000_000_000n }));
    const manager = new PositionManager({ execute }, log);
    const position = manager.openPosition(native, buyIntent, 0.9);
    expect(position.sizeUsd).toBe(3);
    expect(position.accountingVersion).toBeUndefined();
    const partial = await manager.reducePosition(position.id, 0.5, 1, sell(position, 0.5));
    expect(partial.position.sizeTokens).toBe(200n);
    expect(partial.position.sizeUsd).toBe(1.5);
    expect(partial.accounting).toBeUndefined();
    expect(manager.getLastAccounting(position.id)).toBeUndefined();
  });

  it("retains unknown LIVE execution and restart transient states as non-retriable exposure", async () => {
    const { position } = await opened();
    const unresolved = { ...legacy(position), mode: "LIVE" as const, status: "CLOSING" as const };
    const execute = vi.fn();
    const manager = new PositionManager({ execute }, log);
    manager.restorePosition(unresolved);
    expect(manager.getOpenPositions()).toHaveLength(0);
    expect(manager.getExposurePositions()).toHaveLength(1);
    expect(manager.getTotalExposureUsd()).toBe(3);
    await expect(manager.exitPosition(unresolved.id, signal, 1, sell(unresolved))).rejects.toThrow(/not open/);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["UNKNOWN", "CONFIRMED"] as const)("retains mismatched or %s native fills as unresolved exposure", async (status) => {
    const { position } = await opened();
    const manager = new PositionManager({ execute: async (intent) => ({ tradeIntentId: intent.id,
      orderId: "native-unresolved", status, mode: "LIVE", inputAmount: 1n, outputAmount: 9_000_000_000n,
      executedPrice: 1, actualSlippageBps: 0, feesLamports: 0n, feeUsd: 0 }) }, log);
    const restored = { ...legacy(position), mode: "LIVE" as const };
    manager.restorePosition(restored);
    await expect(manager.exitPosition(restored.id, signal, 1, sell(restored))).rejects.toThrow();
    expect(restored.status).toBe("CLOSING");
    expect(restored.sizeTokens).toBe(2_955_000_000n);
    expect(manager.getTotalExposureUsd()).toBe(3);
    await expect(manager.exitPosition(restored.id, signal, 1, sell(restored))).rejects.toThrow(/not open/);
  });

  it("fails closed on inconsistent restored v2 basis or missing accounting fields", async () => {
    const { position } = await opened();
    for (const change of [{ sizeTokens: position.sizeTokens / 2n }, { entryFeeUsd: undefined }, { remainingEntryFeeUsd: NaN }]) {
      const manager = new PositionManager(paper(), log);
      const restored = { ...structuredClone(position), ...change } as Position;
      manager.restorePosition(restored);
      expect(restored.status).toBe("ERROR");
      expect(restored.dataQuality).toContain("invalid-accounting");
      expect(manager.getTotalExposureUsd()).toBe(3);
      expect(restored.accountingVersion).toBe(2);
    }
  });
});
