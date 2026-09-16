/**
 * DexScreener market + liquidity provider.
 * Endpoint verified 2026-09-12: GET https://api.dexscreener.com/latest/dex/tokens/<mint>
 * Free, no key. Unknown mint → 200 with pairs:[] (mapped to ProviderError → UNKNOWN).
 * Not available from this API: 1m/15m granularity, unique-trader counts, slippage
 * estimates, liquidity change rates — those fields are 0, confidence reflects it.
 */
import { ProviderError } from "@autonomous-trader/shared";
import type {
  Chain,
  MarketSnapshot,
  LiquiditySnapshot,
} from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { MarketDataProvider, LiquidityProvider } from "../interfaces.js";

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  marketCap?: number;
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  pairCreatedAt?: number;
}

export class DexScreenerProvider extends AbstractProvider
  implements MarketDataProvider, LiquidityProvider {
  readonly name = "dexscreener";
  readonly version = "1.0.0";

  /** market + liquidity are fetched from the same pair payload — cache it briefly. */
  private readonly pairCache = new Map<string, { at: number; pair: DexPair | null }>();
  private readonly pairCacheMs: number;

  constructor(
    private readonly baseUrl = "https://api.dexscreener.com",
    pairCacheMs = 5_000,
    private readonly chainFilter: Chain = "solana",
  ) {
    super();
    this.pairCacheMs = pairCacheMs;
  }

  async getMarketSnapshot(tokenAddress: string, chain: Chain): Promise<MarketSnapshot> {
    const p = await this.bestPair(tokenAddress);
    return {
      tokenAddress,
      chain,
      poolAddress: p.pairAddress,
      price: parseFloat(p.priceUsd ?? "0"),
      priceUsd: parseFloat(p.priceUsd ?? "0"),
      marketCapUsd: p.marketCap ?? 0,
      volumeUsd1m: 0,
      volumeUsd5m: p.volume?.m5 ?? 0,
      volumeUsd15m: 0,
      volumeUsd1h: p.volume?.h1 ?? 0,
      volumeUsd24h: p.volume?.h24 ?? 0,
      priceChange1m: 0,
      priceChange5m: p.priceChange?.m5 ?? 0,
      priceChange15m: 0,
      priceChange1h: p.priceChange?.h1 ?? 0,
      priceChange24h: p.priceChange?.h24 ?? 0,
      buyCount1m: 0,
      sellCount1m: 0,
      buyVolumeUsd1m: 0,
      sellVolumeUsd1m: 0,
      uniqueBuyers1m: 0,
      uniqueSellers1m: 0,
      tradeCount24h: (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0),
      uniqueTraders24h: 0,
      observedAt: new Date(),
      provider: this.name,
      confidence: 0.7, // single source, no 1m/15m granularity
    };
  }

  async getMarketSnapshots(tokenAddresses: string[], chain: Chain): Promise<MarketSnapshot[]> {
    // DexScreener has a multi-address search but per-token endpoints are the
    // verified path; sequential with the shared cache keeps call count honest.
    const snaps: MarketSnapshot[] = [];
    for (const t of tokenAddresses) {
      try {
        snaps.push(await this.getMarketSnapshot(t, chain));
      } catch {
        /* one bad mint must not fail the batch */
      }
    }
    return snaps;
  }

  /** Poll-based price subscription — 30s poll, caller gets the unsubscribe fn. */
  subscribeToPrice(
    tokenAddress: string,
    chain: Chain,
    handler: (snapshot: MarketSnapshot) => void,
  ): () => void {
    const interval = setInterval(() => {
      void this.getMarketSnapshot(tokenAddress, chain).then(handler).catch(() => undefined);
    }, 30_000);
    return () => clearInterval(interval);
  }

  async getLiquiditySnapshot(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot> {
    const p = await this.bestPair(tokenAddress);
    return {
      tokenAddress,
      chain,
      poolAddress: p.pairAddress,
      liquidityUsd: p.liquidity?.usd ?? 0,
      liquidityBase: p.liquidity?.base ?? 0,
      liquidityQuote: p.liquidity?.quote ?? 0,
      poolAgeMs: p.pairCreatedAt ? Date.now() - p.pairCreatedAt : 0,
      baseToken: p.baseToken.address,
      quoteToken: p.quoteToken.address ?? "",
      dex: p.dexId,
      estimatedSlippageBps50: 0,
      estimatedSlippageBps500: 0,
      estimatedSlippageBps5000: 0,
      liquidityChange5m: 0, // not exposed by API — drain detection stays Birdeye-only
      liquidityChange15m: 0,
      observedAt: new Date(),
      provider: this.name,
      confidence: 0.7,
    };
  }

  async getPools(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot[]> {
    return [await this.getLiquiditySnapshot(tokenAddress, chain)];
  }

  /**
   * Constant-product approximation over the best pool's TVL — good enough for
   * the gate; Jupiter quotes remain the execution-time source of truth.
   */
  async estimateSlippage(
    tokenAddress: string,
    chain: Chain,
    tradeValueUsd: number,
    _side: "BUY" | "SELL",
  ): Promise<{ slippageBps: number; priceImpactBps: number; liquidityUsd: number }> {
    const liq = await this.getLiquiditySnapshot(tokenAddress, chain);
    const liquidityUsd = liq.liquidityUsd;
    // priceImpact ≈ tradeValue / liquidity for a balanced pool (small-trade regime)
    const priceImpactBps = liquidityUsd > 0 ? (tradeValueUsd / liquidityUsd) * 10_000 : 100_000;
    return { slippageBps: priceImpactBps, priceImpactBps, liquidityUsd };
  }

  /** Highest-liquidity pair on the configured chain; throws on no data (→ UNKNOWN, never SAFE). */
  private async bestPair(tokenAddress: string): Promise<DexPair> {
    const cached = this.pairCache.get(tokenAddress);
    if (cached && Date.now() - cached.at < this.pairCacheMs) {
      if (!cached.pair) throw new ProviderError(`DexScreener: no pair for ${tokenAddress}`, this.name);
      return cached.pair;
    }

    const pair = await this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/latest/dex/tokens/${tokenAddress}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) throw new ProviderError("DexScreener rate limited", this.name);
      if (!res.ok) {
        throw new ProviderError(`DexScreener HTTP ${res.status}`, this.name);
      }
      const body = (await res.json()) as { pairs?: DexPair[] };
      const chainPairs = (body.pairs ?? []).filter((p) => p.chainId === this.chainFilter);
      if (chainPairs.length === 0) {
        return null; // unknown token — cache the miss too
      }
      return chainPairs.reduce((best, p) =>
        (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best);
    }, { maxRetries: 2 });

    this.pairCache.set(tokenAddress, { at: Date.now(), pair });
    if (!pair || !pair.priceUsd) {
      throw new ProviderError(`DexScreener: no price for ${tokenAddress}`, this.name);
    }
    return pair;
  }
}
