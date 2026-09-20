import { describe, expect, it } from "vitest";
import type { TradeIntent, QuoteResult } from "@autonomous-trader/shared";
import type { SwapQuoteProvider, SwapQuoteRequest } from "@autonomous-trader/providers";

import { quotesForIntent } from "../execution-router.js";

const BASE = "EQusdt";
const calls: SwapQuoteRequest[] = [];
const provider: SwapQuoteProvider = {
  name: "test", version: "1",
  initialize: async () => undefined, shutdown: async () => undefined,
  async getQuote(req: SwapQuoteRequest): Promise<QuoteResult> {
    calls.push(req);
    return {
      provider: "test", inputToken: req.inputMint, outputToken: req.outputMint,
      inputAmount: req.amount,
      // SELL: notional quote returns 1e9 token units; sell of those returns $9
      outputAmount: req.outputMint === BASE ? 9_000_000n : 1_000_000_000n,
      expectedPrice: 0.5, priceImpactBps: 3, slippageBps: 4,
      routeSteps: [], validUntil: new Date(),
      estimatedFeeLamports: 0n, rawQuote: {},
    };
  },
};

function intent(side: "BUY" | "SELL"): TradeIntent {
  return {
    id: "ti", tokenAddress: "EQtoken", chain: "ton", side, mode: "PAPER",
    strategyId: "s", strategyVersion: "1", riskVersion: "1",
    positionSizeUsd: 10, maxSlippageBps: 50, maxPriceImpactBps: 300,
    reason: "t", createdAt: new Date(), expiresAt: new Date(),
  };
}

describe("quotesForIntent", () => {
  it("BUY: single base→token quote for the USD notional", async () => {
    calls.length = 0;
    const q = await quotesForIntent(provider, intent("BUY"), BASE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ inputMint: BASE, outputMint: "EQtoken" });
    expect(q.inputAmount).toBe(10_000_000n); // $10 in 6dp base units
  });

  it("SELL: notional quote first, then sells exactly those token units", async () => {
    calls.length = 0;
    const q = await quotesForIntent(provider, intent("SELL"), BASE);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ inputMint: BASE, outputMint: "EQtoken" });
    expect(calls[1]).toMatchObject({ inputMint: "EQtoken", outputMint: BASE });
    expect(calls[1].amount).toBe(1_000_000_000n); // units from the notional quote
    expect(q.outputAmount).toBe(9_000_000n); // the sell's $9 proceeds
  });
});
