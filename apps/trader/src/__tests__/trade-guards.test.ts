import { describe, expect, it } from "vitest";
import { DataFreshnessConfigSchema, MarketConfigSchema, type Position } from "@autonomous-trader/shared";
import { createCandidate, type TokenCandidate } from "@autonomous-trader/scanner";
import { currentObservation, entryCooldownActive, entryDataQuality, entryRejections, resolveActionPosition, tokenKey } from "../trade-guards.js";

const at = new Date("2026-09-25T00:00:00Z");
const now = at.getTime();
const marketConfig = MarketConfigSchema.parse({});
const freshness = DataFreshnessConfigSchema.parse({});
const target = { tokenAddress: "t", chain: "base" as const };
function candidate(): TokenCandidate {
  const c = createCandidate("t", "base", "test");
  const common = { ...target, observedAt: at, provider: "test", confidence: 0.9 };
  return {
    ...c, status: "TRADE_CANDIDATE",
    market: { ...common, price: 1, priceUsd: 1, volumeUsd5m: 100, volumeUsd1h: 500 } as TokenCandidate["market"],
    liquidity: { ...common, liquidityUsd: 30_000, poolAgeMs: 900_000, estimatedSlippageBps500: 100, liquidityChange5m: 0 } as TokenCandidate["liquidity"],
    security: { ...target, status: "SAFE", score: 90, confidence: 0.9, checkedAt: at, dataTimestamp: at, ageMs: 0, reasons: [], providerResults: [] },
    holders: { ...common, totalHolders: 500, top10Pct: 10, insiderPct: 0, sniperPct: 0, bundlerPct: 0, concentrationChange5m: 0 } as TokenCandidate["holders"],
  } as TokenCandidate;
}
function rejects(c: TokenCandidate | undefined) {
  return entryRejections(c, target, marketConfig, freshness, 20_000, now);
}
function position(id: string, chain: Position["chain"] = "base", status: Position["status"] = "OPEN"): Position {
  return { id, tokenAddress: "t", chain, status } as Position;
}

describe("AI host guards", () => {
  it("entry cooldown cannot prevent EXIT/TIGHTEN or another chain", () => {
    const cooldowns = new Map([[tokenKey("base", "t"), now + 600_000]]);
    expect(entryCooldownActive({ ...target, type: "ENTER" }, cooldowns, now)).toBe(true);
    for (const type of ["EXIT", "TIGHTEN"]) expect(entryCooldownActive({ ...target, type }, cooldowns, now)).toBe(false);
    expect(entryCooldownActive({ ...target, chain: "bsc", type: "ENTER" }, cooldowns, now)).toBe(false);
  });

  it("rejects mismatched and ambiguous positions, including wrong-chain IDs", () => {
    const positions = [position("one"), position("two"), position("other", "bsc")];
    expect(resolveActionPosition(target, positions).reason).toContain("ambiguous");
    expect(resolveActionPosition({ ...target, positionId: "other" }, positions).reason).toContain("identity");
    expect(resolveActionPosition({ ...target, tokenAddress: "wrong", positionId: "one" }, positions).position).toBeNull();
    expect(resolveActionPosition({ ...target, positionId: "one" }, positions).position?.id).toBe("one");
    expect(resolveActionPosition(target, [position("partial", "base", "PARTIAL_EXIT")]).position?.id).toBe("partial");
    expect(resolveActionPosition(target, [position("pending", "base", "CLOSING")]).position).toBeNull();
  });

  it("requires current scanner eligibility, not just model conviction", () => {
    expect(rejects(candidate())).toEqual([]);
    expect(rejects(undefined)).toContain("scanner candidate not eligible");
    for (const status of ["REJECTED", "CLOSED", "OBSERVING", "WATCHLIST"] as const) {
      expect(rejects({ ...candidate(), status })).toContain("scanner candidate not eligible");
    }
  });

  it("aligns admission with the existing emergency liquidity floor", () => {
    const c = candidate();
    c.liquidity!.liquidityUsd = 17_623;
    expect(rejects(c).some((r) => r.includes("LIQUIDITY_TOO_LOW"))).toBe(true);
  });

  it("rejects stale, wrong-chain, future and non-finite observations", () => {
    const c = candidate();
    c.market!.observedAt = new Date(now - freshness.priceMs - 1);
    expect(rejects(c)).toContain("stale or mismatched observations");
    c.market!.observedAt = at;
    c.market!.priceUsd = Infinity;
    expect(rejects(c)).toContain("invalid observation numbers");
    expect(currentObservation({ ...target, observedAt: new Date(now + 1) }, "t", "base", 1000, now)).toBe(false);
    expect(currentObservation({ ...target, observedAt: at }, "t", "bsc", 1000, now)).toBe(false);
  });

  it("retains but explicitly labels the existing missing-security policy", () => {
    const c = candidate();
    c.security = { ...c.security!, status: "UNKNOWN", confidence: 0.2,
      reasons: [{ code: "NO_DATA", severity: "LOW", message: "No indexed security data" }] };
    expect(rejects(c)).toEqual([]);
    expect(entryDataQuality(c)).toContain("security-unverified");
  });
});
