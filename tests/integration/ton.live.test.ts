/**
 * Live TON provider integration — hits real free public APIs.
 * Run: npx vitest run tests/integration/ton.live.test.ts
 * Skipped automatically if network is unavailable.
 * Known-good asset: TON-USDT jetton (live-verified 2026-09-16).
 */
import { describe, it, expect } from "vitest";
import {
  TonApiClient,
  TonApiSecurityProvider,
  TonApiHoldersProvider,
  GeckoTerminalDiscoveryProvider,
  DexScreenerProvider,
} from "@autonomous-trader/providers";

const USDT_TON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

async function networkAvailable(): Promise<boolean> {
  try {
    await fetch("https://tonapi.io", { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await networkAvailable()))("live TON provider integration", () => {
  // One shared client → every tonapi request in this file rides the same
  // 1.1s serial queue; per-test clients can burst past the free-tier 1rps.
  const sharedClient = new TonApiClient();

  it("tonapi security: USDT-TON is mintable+whitelist → WARNING, never REJECT", async () => {
    const p = new TonApiSecurityProvider(sharedClient);
    const r = await p.analyzeToken(USDT_TON, "ton");
    expect(r.status).not.toBe("REJECT");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  }, 30_000);

  it("tonapi holders: USDT-TON has millions of holders, top10 < 100%", async () => {
    const p = new TonApiHoldersProvider(sharedClient);
    const s = await p.getHolderSnapshot(USDT_TON, "ton");
    expect(s.totalHolders).toBeGreaterThan(100_000);
    expect(s.top10Pct).toBeGreaterThan(0);
    expect(s.top10Pct).toBeLessThan(100);
    expect(s.confidence).toBeGreaterThanOrEqual(0.5);
  }, 30_000);

  it("tonapi client rejects a garbage jetton (→ UNKNOWN upstream, never SAFE)", async () => {
    const p = new TonApiSecurityProvider();
    const r = await p.analyzeToken("EQgarbage", "ton");
    expect(r.status).not.toBe("SAFE");
  }, 30_000);

  it("DexScreener ton filter returns live USDT-TON pair with volume", async () => {
    const p = new DexScreenerProvider("https://api.dexscreener.com", 0, "ton");
    const m = await p.getMarketSnapshot(USDT_TON, "ton");
    expect(m.priceUsd).toBeGreaterThan(0.9);
    expect(m.priceUsd).toBeLessThan(1.1); // it's a stablecoin
    expect(m.volumeUsd24h).toBeGreaterThan(0);

    const l = await p.getLiquiditySnapshot(USDT_TON, "ton");
    expect(l.liquidityUsd).toBeGreaterThan(100_000);
    expect(l.poolAgeMs).toBeGreaterThan(0);
  }, 30_000);

  it("GeckoTerminal discovery poll yields ton pools (or empty, never throws)", async () => {
    const p = new GeckoTerminalDiscoveryProvider();
    await expect(p.pollOnce()).resolves.toBeUndefined();
  }, 30_000);

  // Copy-trade wallet feed — live-verified 2026-09-21. A known-active wallet's
  // event stream parses into swaps without throwing; empty is valid.
  it("tonapi account events parse into wallet swaps (copy-trade feed)", async () => {
    // top USDT-TON holder (exchange hot wallet — always active, verified 2026-09-21)
    const wallet = "0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3";
    const { getWalletSwaps } = await import("@autonomous-trader/providers");
    const swaps = await getWalletSwaps(sharedClient, wallet);
    expect(Array.isArray(swaps)).toBe(true);
    for (const s of swaps) {
      expect(s.jettonMaster.startsWith("EQ")).toBe(true);
      expect(s.side === "BUY" || s.side === "SELL").toBe(true);
    }
  }, 30_000);
});
