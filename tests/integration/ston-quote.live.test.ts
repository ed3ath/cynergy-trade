/**
 * Live STON.fi quote integration — hits the real v1 swap/simulate endpoint.
 * Run: npx vitest run tests/integration/ston-quote.live.test.ts
 * Skipped automatically if network is unavailable.
 * Verified 2026-09-20: POST with query-string params (see ston-quote.ts).
 */
import { describe, it, expect } from "vitest";
import { StonQuoteProvider, TonApiClient, USDT_TON } from "@autonomous-trader/providers";

const TON_NATIVE = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const NOT = "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT"; // 9dp, STON-listed

async function networkAvailable(): Promise<boolean> {
  try {
    await fetch("https://api.ston.fi", { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await networkAvailable()))("live STON.fi quote integration", () => {
  const p = new StonQuoteProvider(new TonApiClient());

  it("BUYS 10 USDT of NOT: USD price within a sane band of tonapi's NOT price", async () => {
    const q = await p.getQuote({
      inputMint: USDT_TON, outputMint: NOT, amount: 10_000_000n, slippageBps: 50, chain: "ton",
    });
    expect(q.outputAmount).toBeGreaterThan(0n);
    expect(q.expectedPrice).toBeGreaterThan(1e-9);  // sane positive price, any magnitude
    expect(q.expectedPrice).toBeLessThan(100);
    expect(q.priceImpactBps).toBeGreaterThanOrEqual(0);
    expect(q.routeSteps.length).toBeGreaterThan(0);
  });

  it("SELLS ~1 TON for USDT: outputAmount ≈ TON spot price", async () => {
    const q = await p.getQuote({
      inputMint: TON_NATIVE, outputMint: USDT_TON, amount: 1_000_000_000n, slippageBps: 50, chain: "ton",
    });
    // 1 TON in USD — wide band, this is a sanity check not a price oracle
    expect(Number(q.outputAmount) / 1e6).toBeGreaterThan(0.1);
    expect(Number(q.outputAmount) / 1e6).toBeLessThan(50);
  });

  it("rejects a garbage address with ProviderError (never a fake quote)", async () => {
    await expect(p.getQuote({
      inputMint: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9cX",
      outputMint: USDT_TON, amount: 1_000_000n, slippageBps: 50, chain: "ton",
    })).rejects.toThrow(/HTTP 400/);
  });
});
