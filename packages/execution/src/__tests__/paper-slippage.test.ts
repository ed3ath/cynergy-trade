import { describe, expect, it } from "vitest";
import { createLogger, generateTradeIntentId, type TradeIntent } from "@autonomous-trader/shared";
import { PaperExecutionRouter } from "../execution-router.js";
import { InMemoryIdempotencyGuard } from "../idempotency.js";

const log = createLogger({ component: "paper-slippage-test" });
const router = () => new PaperExecutionRouter(log, new InMemoryIdempotencyGuard());
function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: generateTradeIntentId(), tokenAddress: "token", chain: "base", side: "BUY", mode: "PAPER",
    strategyId: "test", strategyVersion: "1", riskVersion: "1", positionSizeUsd: 3,
    maxSlippageBps: 300, maxPriceImpactBps: 300, reason: "test",
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), ...overrides,
  };
}

describe("PAPER estimated slippage", () => {
  it("fills a healthy-pool BUY at the estimate, not half-tolerance", async () => {
    const buy = await router().execute(intent({ expectedSlippageBps: 12 }), 1);
    expect(buy.actualSlippageBps).toBe(12);
    expect(buy.executedPrice).toBeCloseTo(1 / 0.9988, 12);
    expect(buy.outputAmount).toBe(2_996_400_000n);
  });

  it("round-trips $3 at 12bps/side for ~$0.008 cost instead of $0.09", async () => {
    const paper = router();
    const buy = await paper.execute(intent({ expectedSlippageBps: 12 }), 1);
    const sell = await paper.execute(intent({
      side: "SELL", paperTokenQuantity: buy.outputAmount, expectedSlippageBps: 12,
    }), 1);
    expect(sell.actualSlippageBps).toBe(12);
    expect(sell.outputAmount).toBe(2_992_804n);
    expect(Number(sell.outputAmount) / 1e6 - 3 - buy.feeUsd - sell.feeUsd).toBeCloseTo(-0.008196, 12);
  });

  it("haircuts exits from rugged pools (6010bps estimate)", async () => {
    const sell = await router().execute(intent({
      side: "SELL", paperTokenQuantity: 1_000_000_000n, expectedSlippageBps: 6010,
    }), 1);
    expect(sell.actualSlippageBps).toBe(6010);
    expect(sell.outputAmount).toBe(399_000n);
  });

  it("fills at par on a zero estimate", async () => {
    const buy = await router().execute(intent({ expectedSlippageBps: 0 }), 1);
    expect(buy.actualSlippageBps).toBe(0);
    expect(buy.outputAmount).toBe(3_000_000_000n);
  });

  it("falls back to half-tolerance when no estimate is set (legacy)", async () => {
    const buy = await router().execute(intent(), 1);
    expect(buy.actualSlippageBps).toBe(150);
    expect(buy.outputAmount).toBe(2_955_000_000n);
  });

  it.each([NaN, Infinity, -1, 10_000, 50_000])("falls back on out-of-range estimate %s", async (expectedSlippageBps) => {
    const buy = await router().execute(intent({ expectedSlippageBps }), 1);
    expect(buy.actualSlippageBps).toBe(150);
    expect(buy.outputAmount).toBe(2_955_000_000n);
  });
});
