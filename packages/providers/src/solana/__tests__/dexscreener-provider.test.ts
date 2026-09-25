import { afterEach, describe, expect, it, vi } from "vitest";
import { DexScreenerProvider } from "../dexscreener-provider.js";

const MINT = "So11111111111111111111111111111111111111112";

function pairBody(): string {
  return JSON.stringify({
    pairs: [{
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "AVUC66rapRHpf4jfq7jDyM4bWJ2Yv2fgsXFXtxsCSUnq",
      baseToken: { address: MINT, name: "Wrapped SOL", symbol: "SOL" },
      quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
      priceUsd: "150",
      liquidity: { usd: 1_000_000 },
      pairCreatedAt: Date.now() - 86_400_000,
    }],
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("DexScreenerProvider", () => {
  it("429 → single fetch (no retry storm), breaker open, cooldown fails fast", async () => {
    const p = new DexScreenerProvider();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(p.getMarketSnapshot(MINT, "solana")).rejects.toThrow("rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(1); // was 3 with withRetry — extends the penalty

    // cooling down: another token makes NO HTTP call
    await expect(p.getMarketSnapshot("Dez1AZzsmMp2Uiy4iXLmdFr33wKxPHwpuuMB4bn8", "solana"))
      .rejects.toThrow("cooling down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("concurrent market + liquidity for one token share a single HTTP call", async () => {
    const p = new DexScreenerProvider();
    const fetchMock = vi.fn(async () => new Response(pairBody(), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const [market, liquidity] = await Promise.all([
      p.getMarketSnapshot(MINT, "solana"),
      p.getLiquiditySnapshot(MINT, "solana"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // was 2 — the doubled request load
    expect(market.priceUsd).toBe(150);
    expect(liquidity.liquidityUsd).toBe(1_000_000);
  });

  it("success recovers after the cooldown window elapses", async () => {
    vi.useFakeTimers();
    try {
      const p = new DexScreenerProvider("http://dex.test", 0); // no cache — force refetch
      let status = 429;
      const fetchMock = vi.fn(async () =>
        new Response(status === 429 ? "{}" : pairBody(), { status }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(p.getMarketSnapshot(MINT, "solana")).rejects.toThrow("rate limited");
      status = 200;
      // still inside the 15s first-rung cooldown → no HTTP call
      await expect(p.getMarketSnapshot(MINT, "solana")).rejects.toThrow("cooling down");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15_001);
      const market = await p.getMarketSnapshot(MINT, "solana");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(market.priceUsd).toBe(150);
    } finally {
      vi.useRealTimers();
    }
  });
});
