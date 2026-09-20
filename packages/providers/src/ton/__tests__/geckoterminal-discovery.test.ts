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

const USDT = "ton_EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const STTON = "ton_EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k";

function hotPool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ton_HOTPOOL1",
    attributes: {
      address: "EQHOTPOOL1",
      reserve_in_usd: 450_000,
      volume_usd: { h24: 214_570, h1: 4_991 },
      price_change_percentage: { h1: 2.5, h24: -16.7 },
    },
    relationships: {
      base_token: { data: { id: "ton_EQHOTJETTON1" } },
      quote_token: { data: { id: NATIVE } },
    },
    ...overrides,
  };
}

describe("GeckoTerminalDiscoveryProvider.processHotPool", () => {
  it("emits top-volume movers with positive 1h momentum", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    const events: unknown[] = [];
    p.subscribe((e) => events.push(e));

    const ev = p.processHotPool(hotPool() as never);

    expect(ev?.tokenAddress).toBe("EQHOTJETTON1");
    expect(ev?.source).toBe("geckoterminal:hot");
    expect(ev?.initialLiquidityUsd).toBe(450_000);
    expect(events).toHaveLength(1);
  });

  it("skips USDT, stTON and native-TON bases", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    for (const baseId of [USDT, STTON, NATIVE]) {
      expect(p.processHotPool(hotPool({
        id: `ton_POOL_${baseId}`,
        relationships: { base_token: { data: { id: baseId } }, quote_token: { data: { id: NATIVE } } },
      }) as never)).toBeNull();
    }
  });

  it("skips pools below hotMinReserveUsd and non-positive 1h change", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    expect(p.processHotPool(hotPool({
      id: "ton_LOWRES", attributes: { ...hotPool().attributes, reserve_in_usd: 49_999 },
    }) as never)).toBeNull();
    expect(p.processHotPool(hotPool({
      id: "ton_DOWN", attributes: { ...hotPool().attributes, price_change_percentage: { h1: -1.2, h24: -9 } },
    }) as never)).toBeNull();
    expect(p.processHotPool(hotPool({
      id: "ton_NULLH1", attributes: { ...hotPool().attributes, price_change_percentage: { h1: null, h24: 3 } },
    }) as never)).toBeNull();
  });

  it("dedupes across polls and shares the seen-set with new-pool discovery", () => {
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    expect(p.processHotPool(hotPool() as never)).not.toBeNull();
    expect(p.processHotPool(hotPool() as never)).toBeNull();
  });

  it("pollHotPools fetches the h24-volume sort endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [hotPool()] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new GeckoTerminalDiscoveryProvider("http://gt.test");
    const events: unknown[] = [];
    p.subscribe((e) => events.push(e));

    await p.pollHotPools();

    expect(events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gt.test/api/v2/networks/ton/pools?sort=h24_volume_usd_desc&page=1",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("backs off after a 429 instead of hammering, retries after the window", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);
      const p = new GeckoTerminalDiscoveryProvider("http://gt.test");

      await p.pollOnce();   // 429 → 30s backoff
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await p.pollOnce();   // skipped — inside backoff
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 31_000);
      await p.pollOnce();   // window elapsed → retries
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
