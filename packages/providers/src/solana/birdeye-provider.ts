/**
 * Birdeye provider — market data + security.
 * Endpoints verified 2026-09:
 *   GET https://public-api.birdeye.so/defi/token_overview?address=<mint>   (X-API-KEY, X-CHAIN)
 *   GET https://public-api.birdeye.so/defi/token_security?address=<mint>   (X-API-KEY, X-CHAIN)
 */
import type { Chain, MarketSnapshot, LiquiditySnapshot } from "@autonomous-trader/shared";
import { ProviderError } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { MarketDataProvider, LiquidityProvider } from "../interfaces.js";

export class BirdeyeMarketProvider extends AbstractProvider implements MarketDataProvider, LiquidityProvider {
  readonly name = "birdeye";
  readonly version = "1.0.0";

  private readonly baseUrl = "https://public-api.birdeye.so";

  constructor(private readonly apiKey: string) {
    super();
  }

  private async get<T>(path: string): Promise<T> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          "X-API-KEY": this.apiKey,
          "X-CHAIN": "solana",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 429) throw new ProviderError("Birdeye rate limited", this.name);
      if (res.status === 401 || res.status === 403) throw new ProviderError("Birdeye auth failed", this.name);
      if (!res.ok) throw new ProviderError(`Birdeye HTTP ${res.status}`, this.name);

      const body = (await res.json()) as { success?: boolean; data?: T };
      if (!body.success || body.data === undefined) {
        throw new ProviderError("Birdeye response unsuccessful", this.name);
      }
      return body.data;
    }, { maxRetries: 2 });
  }

  async getMarketSnapshot(tokenAddress: string, chain: Chain): Promise<MarketSnapshot> {
    const d = await this.get<BirdeyeOverview>(`/defi/token_overview?address=${tokenAddress}`);

    const now = new Date();
    const snapshot: MarketSnapshot = {
      tokenAddress, chain,
      price: d.price ?? 0,
      priceUsd: d.price ?? 0,
      volumeUsd1m: (d.v24hUSD ?? 0) / 1440,
      volumeUsd5m: (d.v24hUSD ?? 0) / 288,
      volumeUsd15m: (d.v24hUSD ?? 0) / 96,
      volumeUsd1h: d.v1hUSD ?? (d.v24hUSD ?? 0) / 24,
      volumeUsd24h: d.v24hUSD ?? 0,
      priceChange1m: 0,
      priceChange5m: 0,
      priceChange15m: 0,
      priceChange1h: d.priceChange1hPercent ?? 0,
      priceChange24h: d.priceChange24hPercent ?? 0,
      buyCount1m: 0,
      sellCount1m: 0,
      buyCount5m: 0,
      sellCount5m: 0,
      buyCount1h: 0,
      sellCount1h: 0,
      buyVolumeUsd1m: 0,
      sellVolumeUsd1m: 0,
      uniqueBuyers1m: 0,
      uniqueSellers1m: 0,
      tradeCount24h: d.trade24h ?? 0,
      uniqueTraders24h: 0,
      observedAt: now,
      provider: this.name,
      confidence: 0.9,
    };
    if (d.mc !== undefined) snapshot.marketCapUsd = d.mc;
    return snapshot;
  }

  async getMarketSnapshots(tokenAddresses: string[], chain: Chain): Promise<MarketSnapshot[]> {
    // Sequential to respect rate limits on free tier
    const out: MarketSnapshot[] = [];
    for (const addr of tokenAddresses) {
      try {
        out.push(await this.getMarketSnapshot(addr, chain));
      } catch {
        // skip failed tokens in batch
      }
    }
    return out;
  }

  subscribeToPrice(
    _tokenAddress: string,
    _chain: Chain,
    _handler: (snapshot: MarketSnapshot) => void,
  ): () => void {
    // Birdeye has WebSocket streams on paid tiers; poll-based fallback here
    // ponytail: implement Birdeye WS stream when on paid tier
    throw new Error("Birdeye polling subscription not implemented — use polling loop");
  }

  async getLiquiditySnapshot(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot> {
    const d = await this.get<BirdeyeOverview>(`/defi/token_overview?address=${tokenAddress}`);
    const liq = d.liquidity ?? 0;

    return {
      tokenAddress, chain,
      poolAddress: d.address ?? tokenAddress,
      dex: "unknown",
      liquidityUsd: liq,
      liquidityBase: liq / 2,
      liquidityQuote: liq / 2,
      poolAgeMs: 0, // not in overview; filled by pool-specific provider later
      baseToken: tokenAddress,
      quoteToken: "So11111111111111111111111111111111111111112",
      estimatedSlippageBps50: estimateSlippageBps(50, liq),
      estimatedSlippageBps500: estimateSlippageBps(500, liq),
      estimatedSlippageBps5000: estimateSlippageBps(5000, liq),
      liquidityChange5m: 0,
      liquidityChange15m: 0,
      observedAt: new Date(),
      provider: this.name,
      confidence: 0.85,
    };
  }

  async getPools(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot[]> {
    return [await this.getLiquiditySnapshot(tokenAddress, chain)];
  }

  async estimateSlippage(
    tokenAddress: string,
    chain: Chain,
    tradeValueUsd: number,
    _side: "BUY" | "SELL",
  ): Promise<{ slippageBps: number; priceImpactBps: number; liquidityUsd: number }> {
    const snap = await this.getLiquiditySnapshot(tokenAddress, chain);
    const bps = estimateSlippageBps(tradeValueUsd, snap.liquidityUsd);
    return { slippageBps: bps * 0.5, priceImpactBps: bps, liquidityUsd: snap.liquidityUsd };
  }
}

/**
 * Constant-product (x*y=k) slippage estimate: impact ≈ size / (2*liquidity).
 * Conservative starting model — refined with real execution data later.
 */
function estimateSlippageBps(tradeUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 10_000;
  const impact = tradeUsd / (2 * liquidityUsd);
  return Math.min(10_000, impact * 10_000);
}

interface BirdeyeOverview {
  address?: string;
  price?: number;
  mc?: number;
  liquidity?: number;
  v24hUSD?: number;
  v1hUSD?: number;
  priceChange1hPercent?: number;
  priceChange24hPercent?: number;
  trade24h?: number;
  [key: string]: unknown;
}
