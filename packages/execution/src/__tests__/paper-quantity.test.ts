import { describe, expect, it, vi } from "vitest";
import { createLogger, generateTradeIntentId, type TradeIntent, type QuoteResult } from "@autonomous-trader/shared";
import type { SwapQuoteProvider } from "@autonomous-trader/providers";
import { PaperExecutionRouter, quotesForIntent } from "../execution-router.js";
import { InMemoryIdempotencyGuard } from "../idempotency.js";

const log = createLogger({ component: "paper-quantity-test" });
const router = () => new PaperExecutionRouter(log, new InMemoryIdempotencyGuard());
function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: generateTradeIntentId(), tokenAddress: "token", chain: "base", side: "BUY", mode: "PAPER",
    strategyId: "test", strategyVersion: "1", riskVersion: "1", positionSizeUsd: 3,
    maxSlippageBps: 300, maxPriceImpactBps: 300, reason: "test",
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), ...overrides,
  };
}

describe("PAPER quantity boundary", () => {
  it("flat $3 round trip produces $2.910675 proceeds and $0.090325 net loss", async () => {
    const paper = router();
    const buy = await paper.execute(intent(), 1);
    expect(buy.inputAmount).toBe(3_000_000n);
    expect(buy.outputAmount).toBe(2_955_000_000n);
    const sell = await paper.execute(intent({ side: "SELL", paperTokenQuantity: buy.outputAmount }), 1);
    expect(sell.inputAmount).toBe(buy.outputAmount);
    expect(sell.outputAmount).toBe(2_910_675n);
    expect(Number(sell.outputAmount) / 1e6 - 3 - buy.feeUsd - sell.feeUsd).toBeCloseTo(-0.090325, 12);
  });

  it("SELL uses held quantity and current fill price, not original USD notional", async () => {
    const paper = router();
    const buy = await paper.execute(intent(), 1);
    const sell = await paper.execute(intent({ side: "SELL", positionSizeUsd: 500, paperTokenQuantity: buy.outputAmount / 2n }), 2);
    expect(sell.inputAmount).toBe(1_477_500_000n);
    expect(sell.outputAmount).toBe(2_910_675n);
  });

  it("does not impose BUY USD-micro rounding on a SELL's informational cost basis", async () => {
    const result = await router().execute(intent({ side: "SELL", positionSizeUsd: 1e-9, paperTokenQuantity: 1_000_000_000n }), 1);
    expect(result.outputAmount).toBe(985_000n);
  });

  it("preserves exact large token quantities beyond JavaScript safe integer range", async () => {
    const paper = router();
    const buy = await paper.execute(intent(), 1e-9);
    expect(buy.outputAmount).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const sell = await paper.execute(intent({ side: "SELL", paperTokenQuantity: buy.outputAmount }), 1e-9);
    expect(sell.inputAmount).toBe(buy.outputAmount);
    expect(sell.outputAmount).toBe(2_910_675n);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1])("rejects invalid price %s before claiming intent", async (price) => {
    const paper = router();
    const buy = intent();
    await expect(paper.execute(buy, price)).rejects.toThrow(/Invalid/);
    await expect(paper.execute(buy, 1)).resolves.toMatchObject({ status: "CONFIRMED" });
  });

  it.each([NaN, Infinity, -1, 0])("rejects invalid notional %s", async (positionSizeUsd) => {
    await expect(router().execute(intent({ positionSizeUsd }), 1)).rejects.toThrow();
  });

  it.each([undefined, 0n, -1n])("rejects absent/non-positive SELL quantity %s", async (quantity) => {
    const sell = intent({ side: "SELL" });
    if (quantity !== undefined) sell.paperTokenQuantity = quantity;
    await expect(router().execute(sell, 1)).rejects.toThrow(/paperTokenQuantity/);
  });

  it.each([NaN, Infinity, -1, 20_000])("rejects invalid slippage %s", async (maxSlippageBps) => {
    await expect(router().execute(intent({ maxSlippageBps }), 1)).rejects.toThrow();
  });

  it("rejects expired, wrong-mode, empty and overflowing fills", async () => {
    await expect(router().execute(intent({ expiresAt: new Date(0) }), 1)).rejects.toThrow();
    await expect(router().execute(intent({ mode: "LIVE" }), 1)).rejects.toThrow();
    await expect(router().execute(intent({ positionSizeUsd: 1e-10 }), 1)).rejects.toThrow();
    await expect(router().execute(intent(), Number.MIN_VALUE)).rejects.toThrow();
    await expect(router().execute(intent({ side: "SELL", paperTokenQuantity: 10n ** 400n }), 1)).rejects.toThrow();
  });

  it("prevents duplicate execution", async () => {
    const paper = router();
    const buy = intent();
    await paper.execute(buy, 1);
    await expect(paper.execute(buy, 1)).rejects.toThrow(/Duplicate/);
  });

  it.each(["SHADOW", "LIVE"] as const)("does not apply PAPER token units to %s quotes", async (mode) => {
    const getQuote = vi.fn(async (request) => ({
      inputAmount: request.amount,
      outputAmount: request.outputMint === "base" ? 900_000n : 123_456n,
    } as QuoteResult));
    const provider = { getQuote } as unknown as SwapQuoteProvider;
    const result = await quotesForIntent(provider, intent({ mode, side: "SELL", paperTokenQuantity: 999_999_999n }), "base");
    expect(getQuote.mock.calls[0]![0].amount).toBe(3_000_000n);
    expect(getQuote.mock.calls[1]![0].amount).toBe(123_456n);
    expect(result.outputAmount).toBe(900_000n);
  });
});
