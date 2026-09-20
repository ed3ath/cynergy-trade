import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@autonomous-trader/shared";

import { StonQuoteProvider, USDT_TON } from "../ston-quote.js";
import type { TonApiClient } from "../tonapi-client.js";

const TON = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

function simulateBody(offer: string, ask: string, over: Record<string, unknown> = {}) {
  return {
    offer_units: offer, ask_units: ask, min_ask_units: String(Number(ask) * 0.995),
    price_impact: "0.0005", pool_address: "EQpool", gas_params: { gas_budget: "300000000" },
    ...over,
  };
}

function mockTonapi(decimals: number) {
  return { getJetton: async () => ({ metadata: { decimals: String(decimals) } }) } as unknown as TonApiClient;
}

describe("StonQuoteProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a BUY quote to USD expectedPrice and effective slippage", async () => {
    // 10 USDT → 21,374.775 NOT (9dp, live shape 2026-09-20): price = 10/21374.7754
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(simulateBody("10000000", "21374775415389")),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const p = new StonQuoteProvider(mockTonapi(9), "http://ston.test");
    const q = await p.getQuote({
      inputMint: USDT_TON, outputMint: "EQnot", amount: 10_000_000n, slippageBps: 50, chain: "ton",
    });

    expect(q.provider).toBe("stonfi-quote");
    expect(q.inputAmount).toBe(10_000_000n);
    expect(q.outputAmount).toBe(21_374_775_415_389n);
    expect(q.expectedPrice).toBeCloseTo(10 / 21_374.775415389, 9);
    expect(q.priceImpactBps).toBe(5);
    expect(q.slippageBps).toBe(50); // 1 - 0.995
    expect(q.routeSteps).toEqual(["EQpool"]);
    expect(q.estimatedFeeLamports).toBe(300_000_000n);

    // simulate is a POST with query-string params (verified live)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("http://ston.test/v1/swap/simulate?");
    expect(url).toContain("offer_address=EQ");
    expect(init.method).toBe("POST");
  });

  it("maps a SELL quote (jetton → USDT) with USD expectedPrice", async () => {
    // 21,374.775 NOT → 9.95 USDT: price = 9.95 / 21374.775415389
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(simulateBody("21374775415389", "9950000")),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const p = new StonQuoteProvider(mockTonapi(9), "http://ston.test");
    const q = await p.getQuote({
      inputMint: "EQnot", outputMint: USDT_TON, amount: 21_374_775_415_389n, slippageBps: 50, chain: "ton",
    });
    expect(q.expectedPrice).toBeCloseTo(9.95 / 21_374.775415389, 9);
    expect(q.inputAmount).toBe(21_374_775_415_389n);
    expect(q.outputAmount).toBe(9_950_000n);
  });

  it("uses native-TON constants without hitting tonapi, and caches jetton decimals", async () => {
    const getJetton = vi.fn(async () => ({ metadata: { decimals: "9" } }));
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(simulateBody("1000000000", "1367193")),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const p = new StonQuoteProvider({ getJetton } as unknown as TonApiClient, "http://ston.test");

    expect(await p.decimals(TON)).toBe(9);
    expect(await p.decimals(USDT_TON)).toBe(6);
    expect(getJetton).not.toHaveBeenCalled();

    await p.getQuote({ inputMint: USDT_TON, outputMint: "EQx", amount: 1_000_000n, slippageBps: 10, chain: "ton" });
    await p.getQuote({ inputMint: USDT_TON, outputMint: "EQx", amount: 2_000_000n, slippageBps: 10, chain: "ton" });
    expect(getJetton).toHaveBeenCalledTimes(1); // cached
  });

  it("maps HTTP errors to ProviderError (never a fake safe quote)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid jetton address", { status: 400 })));
    const p = new StonQuoteProvider(mockTonapi(9), "http://ston.test");
    await expect(p.getQuote({
      inputMint: "EQbad", outputMint: USDT_TON, amount: 1n, slippageBps: 50, chain: "ton",
    })).rejects.toBeInstanceOf(ProviderError);
  });
});
