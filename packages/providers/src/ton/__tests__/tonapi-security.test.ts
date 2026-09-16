/**
 * TonApi security mapping — deterministic unit tests.
 * Money-adjacent: a wrong mapping here either blocks every TON trade or
 * passes a rug. USDT case is the canonical mintable-legit fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TonApiSecurityProvider } from "../tonapi-security.js";
import { TonApiClient } from "../tonapi-client.js";

const USDT_TON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ));
}

function provider(): TonApiSecurityProvider {
  return new TonApiSecurityProvider(new TonApiClient("http://tonapi.test", 0));
}

afterEach(() => vi.unstubAllGlobals());

describe("TonApiSecurityProvider", () => {
  it("USDT fixture: mintable + whitelist → WARNING, never REJECT (legit issuers mint)", async () => {
    // live shape captured 2026-09-16 from tonapi.io
    stubFetch({
      mintable: true,
      total_supply: "1429976002510000",
      admin: { address: "0:6440fe", is_scam: false, is_wallet: true },
      verification: "whitelist",
      holders_count: 3_433_740,
      metadata: { name: "Tether USD", symbol: "USD₮", decimals: "6" },
    });

    const r = await provider().analyzeToken(USDT_TON, "ton");

    expect(r.status).toBe("WARNING"); // MINTABLE is MEDIUM, not CRITICAL
    expect(r.reasons.map((x) => x.code)).toContain("MINTABLE");
    expect(r.confidence).toBe(0.85);
    expect(r.score).toBe(85); // 100 - 20 (mintable) + 5 (whitelist)
  });

  it("admin.is_scam → REJECT", async () => {
    stubFetch({
      mintable: false,
      total_supply: "1000",
      admin: { address: "0:bad", is_scam: true },
      verification: "none",
      metadata: { name: "X", symbol: "X" },
    });

    const r = await provider().analyzeToken("EQbad", "ton");
    expect(r.status).toBe("REJECT");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("verification blacklist → REJECT", async () => {
    stubFetch({
      mintable: false, total_supply: "1000",
      admin: { is_scam: false }, verification: "blacklist",
      metadata: { name: "X", symbol: "X" },
    });

    const r = await provider().analyzeToken("EQbad", "ton");
    expect(r.status).toBe("REJECT");
  });

  it("clean unverified jetton → SAFE at low-but-passing confidence", async () => {
    stubFetch({
      mintable: false, total_supply: "1000",
      admin: { is_scam: false }, verification: "none",
      metadata: { name: "X", symbol: "X" },
    });

    const r = await provider().analyzeToken("EQok", "ton");
    expect(r.status).toBe("SAFE");
    expect(r.confidence).toBe(0.55); // must stay ≥ 0.5 or the scanner hard-rejects
  });

  it("HTTP failure → UNKNOWN, never SAFE", async () => {
    stubFetch({}, 500);

    const r = await provider().analyzeToken("EQx", "ton");
    expect(r.status).toBe("UNKNOWN");
    expect(r.confidence).toBe(0.2);
  });

  it("missing metadata → WARNING", async () => {
    stubFetch({ mintable: false, total_supply: "1000", verification: "none" });

    const r = await provider().analyzeToken("EQx", "ton");
    expect(r.status).toBe("WARNING");
    expect(r.reasons.map((x) => x.code)).toContain("METADATA_MISSING");
  });
});
