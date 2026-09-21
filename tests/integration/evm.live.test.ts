/**
 * Live EVM provider integration — hits real free public APIs.
 * Run: npx vitest run tests/integration/evm.live.test.ts
 * Skipped automatically if network is unavailable.
 * Known-good asset: WBNB on BSC (live-verified 2026-09-21, GoPlus + GT + DexScreener).
 */
import { describe, it, expect } from "vitest";
import {
  DexScreenerProvider,
  EVM_CHAINS,
  GeckoTerminalDiscoveryProvider,
  GoPlusEvmHoldersProvider,
  GoPlusEvmSecurityProvider,
} from "@autonomous-trader/providers";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

async function networkAvailable(): Promise<boolean> {
  try {
    await fetch("https://api.gopluslabs.io", { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await networkAvailable()))("live EVM provider integration", () => {
  it("GoPlus bsc security: WBNB is clean → SAFE/WARNING, never REJECT", async () => {
    const p = new GoPlusEvmSecurityProvider(56);
    const r = await p.analyzeToken(WBNB, "bsc");
    expect(r.status).not.toBe("REJECT");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  }, 30_000);

  it("GoPlus bsc holders: WBNB has millions of holders, top10 < 100%", async () => {
    const p = new GoPlusEvmHoldersProvider(56);
    const s = await p.getHolderSnapshot(WBNB, "bsc");
    expect(s.totalHolders).toBeGreaterThan(100_000);
    expect(s.top1Pct).toBeGreaterThan(0);
    expect(s.top1Pct).toBeLessThan(100);
    expect(s.confidence).toBeGreaterThanOrEqual(0.5);
  }, 30_000);

  it("GoPlus garbage address → UNKNOWN, never SAFE", async () => {
    const p = new GoPlusEvmSecurityProvider(56);
    const r = await p.analyzeToken("0x0000000000000000000000000000000000000001", "bsc");
    expect(r.status).not.toBe("SAFE");
  }, 30_000);

  it("DexScreener bsc filter returns live WBNB pair", async () => {
    const p = new DexScreenerProvider("https://api.dexscreener.com", 0, "bsc");
    const m = await p.getMarketSnapshot(WBNB, "bsc");
    expect(m.priceUsd).toBeGreaterThan(100); // BNB trades in the hundreds
    expect(m.priceUsd).toBeLessThan(100_000);
    expect(m.volumeUsd24h).toBeGreaterThan(0);

    const l = await p.getLiquiditySnapshot(WBNB, "bsc");
    expect(l.liquidityUsd).toBeGreaterThan(100_000);
  }, 30_000);

  it("GeckoTerminal bsc discovery poll resolves (never throws)", async () => {
    const p = new GeckoTerminalDiscoveryProvider("https://api.geckoterminal.com", {
      network: "bsc",
      chain: "bsc",
      skipBaseTokenIds: [`bsc_${WBNB.toLowerCase()}`],
    });
    await expect(p.pollOnce()).resolves.toBeUndefined();
  }, 30_000);

  it.each(["base", "polygon", "arbitrum"] as const)(
    "GoPlus %s endpoint answers for its wrapped-native flagship",
    async (chain) => {
      const p = new GoPlusEvmSecurityProvider(EVM_CHAINS[chain].goPlusChainId);
      const r = await p.analyzeToken(EVM_CHAINS[chain].wrappedNative, chain);
      // provider answered (SAFE/WARNING/UNKNOWN all fine — honeypot flags vary);
      // a crash or 404 shape change fails the test outright
      expect(typeof r.status).toBe("string");
    }, 30_000);
});
