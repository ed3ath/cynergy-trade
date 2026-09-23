/**
 * GeckoTerminal poll-based discovery (same skeleton as Raydium). Works for any
 * GT network — ton, bsc, base, polygon, arbitrum — via the `network` cfg.
 *
 * Two polls:
 *  1. new pools — GET /api/v2/networks/<net>/new_pools (default 30s)
 *  2. hot pools — GET /api/v2/networks/<net>/pools?sort=h24_volume_usd_desc (120s);
 *     fresh pools are overwhelmingly dust, so top h24-volume movers with
 *     positive 1h momentum feed the watchlist too (recipe verified 2026-09-16)
 *
 * Free, no key, ~30 req/min shared per IP across ALL networks. In practice GT
 * throttles sustained polling far below the documented limit — 2/min + 0.5/min
 * per chain got chronic HTTP 429s with 3 chains (observed 2026-09-23, all day,
 * discovery coverage degraded). 1/min + 0.25/min per chain + backoff keeps
 * the shared per-IP penalty from re-triggering across chains.
 *
 * Emits the base token of each pool (address after the "<network>_" prefix in
 * relationship ids). Pools whose base is on the skip list (native coin, wrapped
 * native, major stables) are skipped — we trade the memes, not the gas asset.
 *
 * ponytail: DEX-native pool-creation websockets when a chain graduates past
 * paper — adapter boundary stays, scanner sees the same events.
 */
import type { Chain, TokenDiscoveredEvent } from "@autonomous-trader/shared";
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
  /** GeckoTerminal network slug ("ton", "bsc", "base", …). */
  network: string;
  /** Chain stamped on emitted events. */
  chain: Chain;
  /** Base-token ids (GT "<network>_<addr>" form) never worth trading:
   *  native coin, wrapped native, major stables. */
  skipBaseTokenIds: string[];
  pollIntervalMs: number;  // default 60s (1/min — GT real limit ≪ documented 30/min)
  maxSeenPools: number;    // LRU cap, default 50_000
  /** Pools below this reserve never pass scanner gates — skip early, save downstream calls. */
  minReserveUsd: number;
  /** Hot-pool poll (top h24-volume movers, not just new pools). */
  hotPoolsEnabled: boolean;
  hotPoolsIntervalMs: number;  // default 240s
  /** Minimum pool reserve for a hot pool (50k = scanner's own liquidity gate). */
  hotMinReserveUsd: number;
  /** Minimum 1h price change % for a hot pool — momentum must be positive. */
  hotMinH1ChangePct: number;   // default 0
}

const DEFAULTS: GeckoTerminalDiscoveryConfig = {
  network: "ton",
  chain: "ton",
  skipBaseTokenIds: [TON_NATIVE_ID, USDT_TON_ID, STTON_ID],
  // GT throttles sustained polling far harder than the documented 30/min:
  // 15s polls 429'd all day (2026-09-16); 30s/120s still drew chronic 429s
  // with 3 chains sharing the per-IP budget (2026-09-23). Halved again.
  pollIntervalMs: 60_000,
  maxSeenPools: 50_000,
  // dust pre-filter only — pools below this never grow into candidates; the
  // scanner still applies its own minLiquidityUsd gate (50k) on live data.
  minReserveUsd: 5_000,
  hotPoolsEnabled: true,
  hotPoolsIntervalMs: 240_000,
  hotMinReserveUsd: 50_000,
  hotMinH1ChangePct: 0,
};

/** Deterministic per-chain poll offset: chains sharing GT's per-IP limit must
 *  not fire in lockstep. Identical intervals from one boot aligned every
 *  chain's requests and 429'd them all together each hot-pool cycle
 *  (observed 2026-09-22 with ton,bsc,base). */
export function gtStaggerMs(chain: string, spreadMs = 15_000): number {
  let h = 0;
  for (const c of chain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % spreadMs; // < half the 30s poll interval — full poll cadence preserved
}

export class GeckoTerminalDiscoveryProvider extends AbstractProvider implements TokenDiscoveryProvider {
  readonly name = "geckoterminal-discovery";
  readonly version = "1.0.0";

  private handlers: Array<(e: TokenDiscoveredEvent) => void> = [];
  private seenPools = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private hotTimer?: ReturnType<typeof setInterval>;
  private staggerTimer?: ReturnType<typeof setTimeout>;
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
    const stagger = gtStaggerMs(this.cfg.chain ?? this.cfg.network);
    this.staggerTimer = setTimeout(() => {
      this.pollTimer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs);
      if (this.cfg.hotPoolsEnabled) {
        this.hotTimer = setInterval(() => void this.pollHotPools(), this.cfg.hotPoolsIntervalMs);
      }
    }, stagger);
    this.log.info("GeckoTerminal discovery polling started", {
      network: this.cfg.network,
      chain: this.cfg.chain,
      intervalMs: this.cfg.pollIntervalMs,
      hotPools: this.cfg.hotPoolsEnabled,
      staggerMs: stagger,
    });
  }

  override async shutdown(): Promise<void> {
    if (this.staggerTimer) clearTimeout(this.staggerTimer);
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
      const res = await fetch(`${this.baseUrl}/api/v2/networks/${this.cfg.network}/new_pools`, {
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
        `${this.baseUrl}/api/v2/networks/${this.cfg.network}/pools?sort=h24_volume_usd_desc&page=1`,
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
    if (this.cfg.skipBaseTokenIds.includes(baseId)) return null;

    if (this.seenPools.has(poolId)) return null;
    this.seenPools.add(poolId);
    if (this.seenPools.size > this.cfg.maxSeenPools) this.seenPools.clear();

    const reserve = Number(pool.attributes?.reserve_in_usd ?? "0");
    if (!Number.isFinite(reserve) || reserve < this.cfg.hotMinReserveUsd) return null;

    const h1 = pool.attributes?.price_change_percentage?.h1;
    if (h1 == null || !Number.isFinite(Number(h1)) || Number(h1) <= this.cfg.hotMinH1ChangePct) return null;

    const event: TokenDiscoveredEvent = {
      tokenAddress: baseId.slice(this.cfg.network.length + 1),
      chain: this.cfg.chain,
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
    // skip list covers native coin + stables — a meme trade neither
    if (this.cfg.skipBaseTokenIds.includes(baseId)) return null;

    if (this.seenPools.has(poolId)) return null;
    this.seenPools.add(poolId);
    if (this.seenPools.size > this.cfg.maxSeenPools) this.seenPools.clear();

    const reserve = Number(pool.attributes?.reserve_in_usd ?? "0");
    if (!Number.isFinite(reserve) || reserve < this.cfg.minReserveUsd) return null;

    const dex = pool.relationships?.dex?.data?.id ?? "unknown-dex";
    const event: TokenDiscoveredEvent = {
      tokenAddress: baseId.slice(this.cfg.network.length + 1),
      chain: this.cfg.chain,
      firstSeenAt: pool.attributes?.pool_created_at
        ? new Date(pool.attributes.pool_created_at)
        : new Date(),
      source: `geckoterminal:${dex}`,
      pool: pool.attributes?.address ?? poolId,
      initialLiquidityUsd: reserve,
    };
    this.log.debug("Pool discovered", { token: event.tokenAddress, chain: event.chain, pool: event.pool, dex });
    this.handlers.forEach((h) => h(event));
    return event;
  }
}
