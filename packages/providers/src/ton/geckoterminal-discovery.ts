/**
 * TON new-pool discovery — GeckoTerminal, poll-based (same skeleton as Raydium).
 *
 * Endpoint live-verified 2026-09-16:
 *   GET https://api.geckoterminal.com/api/v2/networks/ton/new_pools
 * Free, no key, ~30 req/min → 15s poll = 4/min is safe.
 *
 * Emits the base jetton of each new pool (address after the "ton_" prefix in
 * relationship ids). Pools where the base is native TON (zero address) are
 * skipped — we trade jettons, not the native coin.
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

interface GtPool {
  id: string;
  attributes?: {
    address?: string;
    pool_created_at?: string;
    reserve_in_usd?: string | number;
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
}

const DEFAULTS: GeckoTerminalDiscoveryConfig = {
  pollIntervalMs: 15_000,
  maxSeenPools: 50_000,
  // dust pre-filter only — pools below this never grow into candidates; the
  // scanner still applies its own minLiquidityUsd gate (50k) on live data.
  minReserveUsd: 5_000,
};

export class GeckoTerminalDiscoveryProvider extends AbstractProvider implements TokenDiscoveryProvider {
  readonly name = "geckoterminal-discovery";
  readonly version = "1.0.0";

  private handlers: Array<(e: TokenDiscoveredEvent) => void> = [];
  private seenPools = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
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
    this.log.info("GeckoTerminal TON discovery polling started", {
      network: "ton",
      intervalMs: this.cfg.pollIntervalMs,
    });
  }

  override async shutdown(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
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
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await fetch(`${this.baseUrl}/api/v2/networks/ton/new_pools`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
      const body = (await res.json()) as { data?: GtPool[] };
      for (const pool of body.data ?? []) this.processPool(pool);
    } catch (err) {
      this.log.warn("Discovery poll failed", { error: (err as Error).message });
    } finally {
      this.polling = false;
    }
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
