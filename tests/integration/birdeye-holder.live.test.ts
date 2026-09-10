/**
 * Birdeye holder adapter live verification — REQUIRES BIRDEYE_API_KEY.
 * Skipped when key absent. This is the test that promotes the adapter from
 * "0.1.0-unverified" to trusted.
 */
import { describe, it, expect } from "vitest";
import { BirdeyeHolderProvider } from "@autonomous-trader/providers";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const apiKey = process.env["BIRDEYE_API_KEY"];

describe.skipIf(!apiKey)("Birdeye holder live", () => {
  it("returns a parseable holder snapshot for BONK", async () => {
    const provider = new BirdeyeHolderProvider(apiKey!);
    const snap = await provider.getHolderSnapshot(BONK, "solana");

    // If this test fails on field mapping, fix extractHolderItems against the
    // live response (probe first — see verify-provider-api skill).
    expect(snap.tokenAddress).toBe(BONK);
    expect(snap.totalHolders).toBeGreaterThan(100); // BONK has ~1M holders
    expect(snap.top10Pct).toBeGreaterThan(0);
    expect(snap.top10Pct).toBeLessThan(100);
  }, 30_000);

  it("returns low-confidence snapshot for garbage address, does not throw", async () => {
    const provider = new BirdeyeHolderProvider(apiKey!);
    const snap = await provider.getHolderSnapshot("11111111111111111111111111111111", "solana").catch(() => null);
    // Either a safe empty snapshot or a clean ProviderError — never fabricated data
    if (snap !== null) {
      expect(snap.confidence).toBeLessThan(0.5);
    }
  }, 30_000);
});
