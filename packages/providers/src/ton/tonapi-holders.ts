/**
 * TON holder analytics — tonapi.io jetton holders.
 * Endpoint live-verified 2026-09-16: GET /v2/jettons/<addr>/holders?limit=N →
 * addresses[] sorted by balance desc; total supply from GET /v2/jettons/<addr>.
 * Birdeye-only fields (insider/sniper/bundler) are 0 — filters treat 0 as pass.
 */
import type { Chain, HolderSnapshot } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { HolderAnalyticsProvider } from "../interfaces.js";
import { TonApiClient } from "./tonapi-client.js";

export class TonApiHoldersProvider extends AbstractProvider implements HolderAnalyticsProvider {
  readonly name = "tonapi-holders";
  readonly version = "1.0.0";

  constructor(private readonly client: TonApiClient = new TonApiClient()) {
    super();
  }

  async getHolderSnapshot(tokenAddress: string, chain: Chain): Promise<HolderSnapshot> {
    const now = new Date();

    try {
      // both calls share the 1 rps serial queue
      const [jetton, holders] = await Promise.all([
        this.client.getJetton(tokenAddress),
        this.client.getHolders(tokenAddress, 20),
      ]);

      const supply = Number(jetton.total_supply ?? "0");
      if (!Number.isFinite(supply) || supply <= 0 || !Array.isArray(holders) || holders.length === 0) {
        return emptySnapshot(tokenAddress, chain, now, this.name, 0.1);
      }

      const pct = (i: number): number =>
        (Number(holders[i]?.balance ?? "0") / supply) * 100;
      const top = (n: number): number => {
        let s = 0;
        for (let i = 0; i < Math.min(n, holders.length); i++) s += pct(i);
        return s;
      };

      return {
        tokenAddress,
        chain,
        totalHolders: jetton.holders_count ?? holders.length,
        top1Pct: top(1),
        top5Pct: top(5),
        top10Pct: top(10),
        top20Pct: top(20),
        creatorPct: 0,
        insiderPct: 0,
        sniperPct: 0,
        bundlerPct: 0,
        whalePct: 0,
        holderGrowth5m: 0,
        holderGrowth15m: 0,
        holderGrowth1h: 0,
        concentrationChange5m: 0,
        concentrationChange15m: 0,
        observedAt: now,
        provider: this.name,
        confidence: 0.7,
      };
    } catch {
      // missing data = zeroed low-confidence snapshot → filters reject safely
      return emptySnapshot(tokenAddress, chain, now, this.name, 0.1);
    }
  }
}

function emptySnapshot(
  tokenAddress: string, chain: Chain, now: Date, provider: string, confidence: number,
): HolderSnapshot {
  return {
    tokenAddress, chain,
    totalHolders: 0, top1Pct: 0, top5Pct: 0, top10Pct: 0, top20Pct: 0,
    creatorPct: 0, insiderPct: 0, sniperPct: 0, bundlerPct: 0, whalePct: 0,
    holderGrowth5m: 0, holderGrowth15m: 0, holderGrowth1h: 0,
    concentrationChange5m: 0, concentrationChange15m: 0,
    observedAt: now, provider, confidence,
  };
}
