/**
 * TonApi holder concentration math — deterministic unit tests.
 * Filters hard-reject when totalHolders < 50 or snapshot confidence too low,
 * so the failure paths must produce zeroed low-confidence snapshots.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TonApiHoldersProvider } from "../tonapi-holders.js";
import { TonApiClient } from "../tonapi-client.js";

/** Alternates jetton (supply) vs holders responses on the shared client. */
function stubFetch(responses: unknown[]): void {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(responses[i++] ?? {}), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  ));
}

function provider(): TonApiHoldersProvider {
  return new TonApiHoldersProvider(new TonApiClient("http://tonapi.test", 0));
}

afterEach(() => vi.unstubAllGlobals());

describe("TonApiHoldersProvider", () => {
  it("computes top-N concentration from balances / total_supply", async () => {
    stubFetch([
      { total_supply: "1000", holders_count: 500 }, // jetton
      { addresses: [                                              // holders, desc
        { address: "a1", balance: "300" },
        { address: "a2", balance: "200" },
        { address: "a3", balance: "150" },
        { address: "a4", balance: "100" },
        { address: "a5", balance: "80" },
        { address: "a6", balance: "70" },
        { address: "a7", balance: "40" },
        { address: "a8", balance: "30" },
        { address: "a9", balance: "20" },
        { address: "a10", balance: "10" },
      ] },
    ]);

    const s = await provider().getHolderSnapshot("EQx", "ton");

    expect(s.totalHolders).toBe(500);
    expect(s.top1Pct).toBeCloseTo(30);
    expect(s.top5Pct).toBeCloseTo(83);   // 300+200+150+100+80
    expect(s.top10Pct).toBeCloseTo(100); // all 1000 accounted
    expect(s.confidence).toBe(0.7);
  });

  it("zero supply → zeroed snapshot at conf 0.1 (filters reject safely)", async () => {
    stubFetch([
      { total_supply: "0", holders_count: 0 },
      { addresses: [{ address: "a1", balance: "0" }] },
    ]);

    const s = await provider().getHolderSnapshot("EQx", "ton");
    expect(s.totalHolders).toBe(0);
    expect(s.top10Pct).toBe(0);
    expect(s.confidence).toBe(0.1);
  });

  it("fetch failure → zeroed snapshot, never a fake pass", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));

    const s = await provider().getHolderSnapshot("EQx", "ton");
    expect(s.totalHolders).toBe(0);
    expect(s.confidence).toBe(0.1);
  });
});
