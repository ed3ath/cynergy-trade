/**
 * Live integration tests — hit real public APIs.
 * Run: npx vitest run tests/integration
 * These are skipped automatically if network is unavailable.
 */
import { describe, it, expect } from "vitest";
import { GoPlusSecurityProvider, JupiterQuoteProvider, SolanaRpcProvider } from "@autonomous-trader/providers";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

async function networkAvailable(): Promise<boolean> {
  try {
    await fetch("https://api.gopluslabs.io", { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await networkAvailable()))("live provider integration", () => {
  it("GoPlus assesses BONK as a real token", async () => {
    const provider = new GoPlusSecurityProvider();
    const result = await provider.analyzeToken(BONK, "solana");

    expect(result.tokenAddress).toBe(BONK);
    // BONK is a major established token — must not be REJECT
    expect(result.status).not.toBe("REJECT");
    expect(result.confidence).toBeGreaterThan(0.5);
  }, 30_000);

  it("GoPlus returns UNKNOWN for a garbage address", async () => {
    const provider = new GoPlusSecurityProvider();
    const result = await provider.analyzeToken("11111111111111111111111111111111", "solana");
    // No data ≠ safe — must never be SAFE for unknown tokens
    expect(["UNKNOWN", "REJECT"]).toContain(result.status);
    expect(result.status).not.toBe("SAFE");
  }, 30_000);

  it("Jupiter quotes WSOL→USDC with real amounts", async () => {
    const provider = new JupiterQuoteProvider();
    const quote = await provider.getQuote({
      inputMint: WSOL,
      outputMint: USDC,
      amount: 100_000_000n, // 0.1 SOL
      slippageBps: 50,
      chain: "solana",
    });

    expect(quote.inputAmount).toBe(100_000_000n);
    expect(quote.outputAmount).toBeGreaterThan(0n);
    expect(quote.routeSteps.length).toBeGreaterThan(0);
    // USDC out for 0.1 SOL should be a sane number (raw 6 decimals: $10-30 → 10M-30M units)
    expect(Number(quote.outputAmount)).toBeGreaterThan(1_000_000);
  }, 30_000);

  it("Solana public RPC responds to getBalance", async () => {
    const rpc = new SolanaRpcProvider("https://api.mainnet-beta.solana.com");
    const balance = await rpc.getAccountBalance(WSOL); // WSOL mint authority-ish address, just needs to exist
    expect(typeof balance).toBe("bigint");
  }, 30_000);
});

describe.skipIf(!(await networkAvailable()))("live dexscreener integration", () => {
  it("returns real market + liquidity for BONK", async () => {
    const { DexScreenerProvider } = await import("@autonomous-trader/providers");
    const p = new DexScreenerProvider();

    const market = await p.getMarketSnapshot(BONK, "solana");
    expect(market.provider).toBe("dexscreener");
    expect(market.priceUsd).toBeGreaterThan(0);
    expect(market.volumeUsd24h).toBeGreaterThan(10_000); // BONK always trades
    expect(market.priceChange24h).not.toBe(0);
    expect(market.confidence).toBeGreaterThanOrEqual(0.5);

    const liq = await p.getLiquiditySnapshot(BONK, "solana");
    expect(liq.liquidityUsd).toBeGreaterThan(10_000);
    expect(liq.poolAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(liq.poolAgeMs).toBeGreaterThan(365 * 24 * 3600 * 1000); // BONK pair is old
  });

  it("unknown mint throws (missing data → UNKNOWN, never SAFE)", async () => {
    const { DexScreenerProvider } = await import("@autonomous-trader/providers");
    const p = new DexScreenerProvider();
    await expect(p.getMarketSnapshot("11111111111111111111111111111111", "solana")).rejects.toThrow();
  });
});
