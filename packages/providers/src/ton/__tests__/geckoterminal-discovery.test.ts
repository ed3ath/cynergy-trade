/**
 * GeckoTerminal TON discovery — payload → TokenDiscoveredEvent mapping.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeckoTerminalDiscoveryProvider } from "../geckoterminal-discovery.js";

const NATIVE = "ton_EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

function pool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ton_POOL1",
    attributes: { address: "EQPOOL1", pool_created_at: "2026-09-15T21:21:35Z", reserve_in_usd: "12000" },
    relationships: {
      base_token: { data: { id: "ton_EQJETTON1" } },
      quote_token: { data: { id: NATIVE } },
      dex: { data: { id: "stonfi" } },
    },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("GeckoTerminalDiscoveryProvider.processPool", () => {
  it("emits base jetton with ton_ prefix stripped, pool + reserve mapped", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    const events: unknown[] = [];
    p.subscribe((e) => events.push(e));

    const ev = p.processPool(pool() as never);

    expect(ev).not.toBeNull();
    expect(ev?.tokenAddress).toBe("EQJETTON1");
    expect(ev?.chain).toBe("ton");
    expect(ev?.pool).toBe("EQPOOL1");
    expect(ev?.initialLiquidityUsd).toBe(12_000);
    expect(ev?.source).toBe("geckoterminal:stonfi");
    expect(events).toHaveLength(1); // handlers fanned out
  });

  it("skips pools where base is native TON", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    const ev = p.processPool(pool({
      relationships: {
        base_token: { data: { id: NATIVE } },
        quote_token: { data: { id: "ton_EQJETTON1" } },
        dex: { data: { id: "stonfi" } },
      },
    }) as never);
    expect(ev).toBeNull();
  });

  it("skips dust pools below minReserveUsd (saves tonapi calls)", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    const ev = p.processPool(pool({
      attributes: { address: "EQPOOL1", reserve_in_usd: "4.7673" },
    }) as never);
    expect(ev).toBeNull();
  });

  it("dedupes the same pool across polls", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    expect(p.processPool(pool() as never)).not.toBeNull();
    expect(p.processPool(pool() as never)).toBeNull();
  });

  it("pollOnce fetches and fans out (live payload shape)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [pool()] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    ));
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    const events: unknown[] = [];
    p.subscribe((e) => events.push(e));

    await p.pollOnce();

    expect(events).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://gt.test/api/v2/networks/ton/new_pools",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });
});
