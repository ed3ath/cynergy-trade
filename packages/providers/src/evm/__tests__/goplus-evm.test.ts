/**
 * GoPlus EVM security/holders mapping — deterministic unit tests over the
 * live-verified response shape (captured 2026-09-21, verify-provider-api skill).
 * WBNB is the canonical clean fixture; flags are flat "0"/"1" strings.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoPlusEvmHoldersProvider, GoPlusEvmSecurityProvider } from "../goplus-evm.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

function stubFetch(result: Record<string, unknown> | null): void {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ code: 1, message: "OK", result }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  ));
}

/** Live WBNB payload trimmed to the fields the provider reads. */
function wbnbFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_name: "Wrapped BNB",
    token_symbol: "WBNB",
    is_honeypot: "0",
    cannot_buy: "0",
    transfer_pausable: "0",
    is_mintable: "0",
    hidden_owner: "0",
    selfdestruct: "0",
    is_blacklisted: "0",
    slippage_modifiable: "0",
    personal_slippage_modifiable: "0",
    is_anti_whale: "0",
    anti_whale_modifiable: "0",
    is_open_source: "1",
    external_call: "0",
    buy_tax: "0",
    sell_tax: "0",
    owner_percent: "0",
    creator_percent: "0.000000",
    holder_count: "8279813",
    trust_list: "1",
    is_in_dex: "1",
    holders: [
      { address: "0x8f73…", balance: "220347.94", percent: "0.141450077857829668", is_locked: 0 },
      { address: "0x9b00…", balance: "116682.65", percent: "0.074903218142850083", is_locked: 0 },
      { address: "0x6bca…", balance: "89725.56", percent: "0.057598396760336626", is_locked: 0 },
      { address: "0x16b9…", balance: "51046.19", percent: "0.032768575879673735", is_locked: 0 },
      { address: "0x59a6…", balance: "30000", percent: "0.019258189154535382", is_locked: 0 },
      { address: "0x3080…", balance: "22174.67", percent: "0.014234800159679827", is_locked: 0 },
      { address: "0x1cea…", balance: "20000", percent: "0.0128", is_locked: 0 },
      { address: "0x2cea…", balance: "18000", percent: "0.0115", is_locked: 0 },
      { address: "0x3cea…", balance: "16000", percent: "0.0102", is_locked: 0 },
      { address: "0x4cea…", balance: "14000", percent: "0.0090", is_locked: 0 },
    ],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("GoPlusEvmSecurityProvider", () => {
  const p = new GoPlusEvmSecurityProvider(56, "http://goplus.test");

  it("WBNB fixture: clean + trust_list → SAFE", async () => {
    stubFetch({ [WBNB.toLowerCase()]: wbnbFixture() });
    const r = await p.analyzeToken(WBNB, "bsc");
    expect(r.status).toBe("SAFE");
    expect(r.confidence).toBe(0.9);
    expect(r.reasons).toHaveLength(0);
  });

  it("honeypot → REJECT with CRITICAL reason", async () => {
    stubFetch({ [WBNB.toLowerCase()]: wbnbFixture({ is_honeypot: "1" }) });
    const r = await p.analyzeToken(WBNB, "bsc");
    expect(r.status).toBe("REJECT");
    expect(r.reasons.map((x) => x.code)).toContain("HONEYPOT");
  });

  it("mintable + slippage modifiable → WARNING (HIGH, not CRITICAL)", async () => {
    stubFetch({ [WBNB.toLowerCase()]: wbnbFixture({ is_mintable: "1", slippage_modifiable: "1" }) });
    const r = await p.analyzeToken(WBNB, "bsc");
    expect(r.status).toBe("WARNING");
    expect(r.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["MINTABLE", "SLIPPAGE_MODIFIABLE"]));
  });

  it("sell tax >10% → HIGH reason", async () => {
    stubFetch({ [WBNB.toLowerCase()]: wbnbFixture({ sell_tax: "12.5" }) });
    const r = await p.analyzeToken(WBNB, "bsc");
    expect(r.reasons.map((x) => x.code)).toContain("SELL_TAX_HIGH");
    expect(r.status).toBe("WARNING");
  });

  it("top-10 unlocked concentration >60% → WARNING", async () => {
    stubFetch({ [WBNB.toLowerCase()]: wbnbFixture({
      holders: wbnbFixture().holders!.map((h, i) => ({ ...h, percent: i === 0 ? "0.70" : "0.001" })),
    }) });
    const r = await p.analyzeToken(WBNB, "bsc");
    expect(r.reasons.map((x) => x.code)).toContain("TOP10_UNLOCKED_CONCENTRATED");
  });

  it("no result for token → UNKNOWN, never SAFE", async () => {
    stubFetch(null);
    const r = await p.analyzeToken("0xdead", "bsc");
    expect(r.status).toBe("UNKNOWN");
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("HTTP 500 → UNKNOWN, never SAFE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const r = await p.analyzeToken(WBNB, "bsc");
    expect(r.status).toBe("UNKNOWN");
    expect(r.reasons.map((x) => x.code)).toContain("PROVIDER_ERROR");
  });
});

describe("GoPlusEvmHoldersProvider", () => {
  const p = new GoPlusEvmHoldersProvider(56, "http://goplus.test");

  it("percent is a decimal fraction — top1 = 14.15% for the WBNB fixture", async () => {
    stubFetch({ [WBNB.toLowerCase()]: wbnbFixture() });
    const r = await p.getHolderSnapshot(WBNB, "bsc");
    expect(r.totalHolders).toBe(8_279_813);
    expect(r.top1Pct).toBeCloseTo(14.145, 2);
    expect(r.top10Pct).toBeCloseTo(
      wbnbFixture().holders!.reduce((s, h) => s + parseFloat(h.percent) * 100, 0), 2,
    );
    expect(r.top20Pct).toBe(r.top10Pct); // top-10 only from API
    expect(r.confidence).toBe(0.7);
  });

  it("creator_percent fraction → pct", async () => {
    stubFetch({ [WBNB.toLowerCase()]: wbnbFixture({ creator_percent: "0.05" }) });
    const r = await p.getHolderSnapshot(WBNB, "bsc");
    expect(r.creatorPct).toBeCloseTo(5, 5);
  });

  it("no data → zeroed low-confidence snapshot (filters reject safely)", async () => {
    stubFetch(null);
    const r = await p.getHolderSnapshot("0xdead", "bsc");
    expect(r.totalHolders).toBe(0);
    expect(r.confidence).toBe(0.1);
  });
});
