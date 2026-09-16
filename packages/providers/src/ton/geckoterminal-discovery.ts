/**
 * TON discovery — GeckoTerminal, poll-based (same skeleton as Raydium).
 *
 * Two polls:
 *  1. new pools — GET /api/v2/networks/ton/new_pools (15s)
 *  2. hot pools — GET /api/v2/networks/ton/pools?sort=h24_volume_usd_desc (60s);
 *     fresh TON pools are overwhelmingly dust, so top h24-volume movers with
 *     positive 1h momentum feed the watchlist too (recipe verified 2026-09-16)
 *
 * Free, no key, ~30 req/min → 4/min + 1/min is safe.
 *
 * Emits the base jetton of each pool (address after the "ton_" prefix in
 * relationship ids). Pools where the base is native TON (zero address), USDT
 * or stTON are skipped — we trade jettons, not the native coin or stables.
 *
 * ponytail: STON.fi/DeDust pool-creation websockets when TON graduates past
 * paper — adapter boundary stays, scanner sees the same events.
 */
import type { TokenDiscoveredEvent } from "@autonomous-trader/shared";
import { createLogger, type Logger } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { TokenDiscoveryProvider } from "../interfaces.js";

/** Native TON in DexScreener/GeckoTerminal token ids — the zero address. */
const TON_NATIVE_ID = "ton_EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
/** USDT-TON jetton — dominates hot-pool volume, nothing to trade there. */
const USDT_TON_ID = "ton_EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
/** stTON (bemo) — liquid staking wrapper, price tracks TON by design. */
const STTON_ID = "ton_EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k";

interface GtPool {
  id: string;
  attributes?: {
    address?: string;
    pool_created_at?: string;
    reserve_in_usd?: string | number;
    volume_usd?: { h24?: string | number; h1?: string | number };
    price_change_percentage?: { h1?: string | number | null; h24?: string | number | null };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

export interface GeckoTerminalDiscoveryConfig {
  pollIntervalMs: number;  // default 15s (4/min vs 30/min limit)
  maxSeenPools: number;    // LRU cap, default 50_000
  /** Pools below this reserve never pass scanner gates — skip early, save tonapi calls. */
  minReserveUsd: number;
  /** Hot-pool poll (top h24-volume movers, not just new pools). */
  hotPoolsEnabled: boolean;
  hotPoolsIntervalMs: number;  // default 60s
  /** Minimum pool reserve for a hot pool (default 80k — recipe 2026-09-16). */
  hotMinReserveUsd: number;
  /** Minimum 1h price change % for a hot pool — momentum must be positive. */
  hotMinH1ChangePct: number;   // default 0
}

const DEFAULTS: GeckoTerminalDiscoveryConfig = {
  // GT throttles sustained polling harder than the documented 30/min — a 15s
  // new-pool poll ran all day and got the IP 429'd (verified 2026-09-16).
  // 2/min + 0.5/min with backoff stays well inside the real limit.
  pollIntervalMs: 30_000,
  maxSeenPools: 50_000,
  // dust pre-filter only — pools below this never grow into candidates; the
  // scanner still applies its own minLiquidityUsd gate (50k) on live data.
  minReserveUsd: 5_000,
  hotPoolsEnabled: true,
  hotPoolsIntervalMs: 120_000,
  hotMinReserveUsd: 80_000,
  hotMinH1ChangePct: 0,
};

export class GeckoTerminalDiscoveryProvider extends AbstractProvider implements TokenDiscoveryProvider {
  readonly name = "geckoterminal-discovery";
  readonly version = "1.0.0";

  private handlers: Array<(e: TokenDiscoveredEvent) => void> = [];
  private seenPools = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private hotTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private pollingHot = false;
  /** Shared 429/timeout backoff — hammering a throttled GT extends the penalty. */
  private backoffUntil = 0;
  private consecutiveFails = 0;
  private readonly log: Logger;
  private readonly cfg: GeckoTerminalDiscoveryConfig;

  constructor(
    private readonly baseUrl = "https://api.geckoterminal.com",
    cfg: Partial<GeckoTerminalDiscoveryConfig> = {},
  ) {
    super();
    this.cfg = { ...DEFAULTS, ...cfg };
    this.log = createLogger({ component: "geckoterminal-discovery" });
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    this.pollTimer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs);
    if (this.cfg.hotPoolsEnabled) {
      this.hotTimer = setInterval(() => void this.pollHotPools(), this.cfg.hotPoolsIntervalMs);
    }
    this.log.info("GeckoTerminal TON discovery polling started", {
      network: "ton",
      intervalMs: this.cfg.pollIntervalMs,
      hotPools: this.cfg.hotPoolsEnabled,
    });
  }

  override async shutdown(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.hotTimer) clearInterval(this.hotTimer);
    await super.shutdown();
  }

  subscribe(handler: (event: TokenDiscoveredEvent) => void): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  async getRecentTokens(_since: Date, _limit?: number): Promise<TokenDiscoveredEvent[]> {
    return []; // polling provider has no historical replay
  }

  /** One poll cycle — public for testing. */
  async pollOnce(): Promise<void> {
    if (this.polling || Date.now() < this.backoffUntil) return;
    this.polling = true;
    try {
      const res = await fetch(`${this.baseUrl}/api/v2/networks/ton/new_pools`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
      const body = (await res.json()) as { data?: GtPool[] };
      for (const pool of body.data ?? []) this.processPool(pool);
      this.onPollSuccess();
    } catch (err) {
      this.onPollFailure(err as Error, "Discovery poll failed");
    } finally {
      this.polling = false;
    }
  }

  /**
   * Hot-pool poll: top h24-volume movers (not just brand-new pools — fresh TON
   * pools are overwhelmingly dust). Endpoint live-verified 2026-09-16:
   *   GET /api/v2/networks/ton/pools?sort=h24_volume_usd_desc
   * Public for testing.
   */
  async pollHotPools(): Promise<void> {
    if (this.pollingHot || Date.now() < this.backoffUntil) return;
    this.pollingHot = true;
    try {
      const res = await fetch(
        `${this.baseUrl}/api/v2/networks/ton/pools?sort=h24_volume_usd_desc&page=1`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
      const body = (await res.json()) as { data?: GtPool[] };
      for (const pool of body.data ?? []) this.processHotPool(pool);
      this.onPollSuccess();
    } catch (err) {
      this.onPollFailure(err as Error, "Hot-pool poll failed");
    } finally {
      this.pollingHot = false;
    }
  }

  private onPollSuccess(): void {
    this.consecutiveFails = 0;
  }

  /** 30s → 1m → 2m → 4m → 5m cap — both polls share the penalty window. */
  private onPollFailure(err: Error, what: string): void {
    this.consecutiveFails++;
    const backoffMs = Math.min(5 * 60_000, 30_000 * 2 ** (this.consecutiveFails - 1));
    this.backoffUntil = Date.now() + backoffMs;
    this.log.warn(`${what} — backing off`, {
      error: err.message,
      consecutiveFails: this.consecutiveFails,
      backoffMs,
    });
  }

  /** Exported for testing. */
  processHotPool(pool: GtPool): TokenDiscoveredEvent | null {
    const poolId = pool.id ?? pool.attributes?.address;
    const baseId = pool.relationships?.base_token?.data?.id;
    if (!poolId || !baseId) return null;
    if (baseId === TON_NATIVE_ID || baseId === USDT_TON_ID || baseId === STTON_ID) return null;

    if (this.seenPools.has(poolId)) return null;
    this.seenPools.add(poolId);
    if (this.seenPools.size > this.cfg.maxSeenPools) this.seenPools.clear();

    const reserve = Number(pool.attributes?.reserve_in_usd ?? "0");
    if (!Number.isFinite(reserve) || reserve < this.cfg.hotMinReserveUsd) return null;

    const h1 = pool.attributes?.price_change_percentage?.h1;
    if (h1 == null || !Number.isFinite(Number(h1)) || Number(h1) <= this.cfg.hotMinH1ChangePct) return null;

    const event: TokenDiscoveredEvent = {
      tokenAddress: baseId.slice("ton_".length),
      chain: "ton",
      firstSeenAt: new Date(),
      source: "geckoterminal:hot",
      pool: pool.attributes?.address ?? poolId,
      initialLiquidityUsd: reserve,
    };
    this.log.debug("Hot pool discovered", {
      jetton: event.tokenAddress,
      pool: event.pool,
      reserveUsd: reserve,
      h1ChangePct: h1,
    });
    this.handlers.forEach((h) => h(event));
    return event;
  }

  /** Exported for testing. */
  processPool(pool: GtPool): TokenDiscoveredEvent | null {
    const poolId = pool.id ?? pool.attributes?.address;
    const baseId = pool.relationships?.base_token?.data?.id;
    if (!poolId || !baseId) return null;
    if (baseId === TON_NATIVE_ID) return null; // native TON as base — not a jetton trade

    if (this.seenPools.has(poolId)) return null;
    this.seenPools.add(poolId);
    if (this.seenPools.size > this.cfg.maxSeenPools) this.seenPools.clear();

    const reserve = Number(pool.attributes?.reserve_in_usd ?? "0");
    if (!Number.isFinite(reserve) || reserve < this.cfg.minReserveUsd) return null;

    const dex = pool.relationships?.dex?.data?.id ?? "unknown-dex";
    const event: TokenDiscoveredEvent = {
      tokenAddress: baseId.slice("ton_".length),
      chain: "ton",
      firstSeenAt: pool.attributes?.pool_created_at
        ? new Date(pool.attributes.pool_created_at)
        : new Date(),
      source: `geckoterminal:${dex}`,
      pool: pool.attributes?.address ?? poolId,
      initialLiquidityUsd: reserve,
    };
    this.log.debug("TON pool discovered", { jetton: event.tokenAddress, pool: event.pool, dex });
    this.handlers.forEach((h) => h(event));
    return event;
  }
}
