/**
 * Snapshot loader — reads the recorded dataset (token_market_snapshots +
 * latest liquidity_snapshots per token) into TokenSeries for replay.
 */
import type { Chain, LiquiditySnapshot, MarketSnapshot } from "@autonomous-trader/shared";
import { Database } from "@autonomous-trader/core";
import type { TokenSeries } from "./replay.js";

interface MarketRow {
  token_address: string;
  observed_at: Date;
  price_usd: string;
  market_cap_usd: string | null;
  volume_usd_1m: string | null; volume_usd_5m: string | null; volume_usd_15m: string | null;
  volume_usd_1h: string | null; volume_usd_24h: string | null;
  price_change_1m: string | null; price_change_5m: string | null; price_change_15m: string | null;
  price_change_1h: string | null; price_change_24h: string | null;
  buy_count_1m: string | null; sell_count_1m: string | null;
  buy_volume_usd_1m: string | null; sell_volume_usd_1m: string | null;
  unique_buyers_1m: string | null; unique_sellers_1m: string | null;
  trade_count_24h: string | null;
  provider: string; confidence: string;
}

interface LiquidityRow {
  token_address: string;
  pool_address: string | null; dex: string | null;
  liquidity_usd: string | null; pool_age_ms: string | null;
  slippage_bps_50: string | null; slippage_bps_500: string | null; slippage_bps_5000: string | null;
  liquidity_change_5m: string | null; liquidity_change_15m: string | null;
  provider: string; confidence: string; observed_at: Date;
}

export async function loadSeries(
  db: Database, chain: Chain, opts: { minRows?: number } = {},
): Promise<TokenSeries[]> {
  const minRows = opts.minRows ?? 20;

  const { rows: market } = await db.query<MarketRow>(
    `SELECT m.* FROM token_market_snapshots m
     JOIN (
       SELECT token_address, COUNT(*) AS n
       FROM token_market_snapshots WHERE chain = $1
       GROUP BY token_address
     ) c ON c.token_address = m.token_address
     WHERE m.chain = $1 AND c.n >= $2
     ORDER BY m.token_address, m.observed_at`,
    [chain, minRows],
  );

  // Latest liquidity row per token (first snapshot ≈ discovery conditions)
  const { rows: liq } = await db.query<LiquidityRow>(
    `SELECT DISTINCT ON (token_address) *
     FROM liquidity_snapshots WHERE chain = $1
     ORDER BY token_address, observed_at ASC`,
    [chain],
  );
  const liqByToken = new Map(liq.map((r) => [r.token_address, r]));

  // holders/security are optional gates — v1 replays without them by skipping
  // such tokens (FreshMomentum requires all layers).
  const { rows: holders } = await db.query<{ token_address: string }>(
    `SELECT DISTINCT ON (token_address) token_address FROM holder_snapshots WHERE chain = $1`,
    [chain],
  );
  const { rows: security } = await db.query<{ token_address: string }>(
    `SELECT DISTINCT ON (token_address) token_address FROM security_assessments WHERE chain = $1`,
    [chain],
  );
  const holdersSet = new Set(holders.map((r) => r.token_address));
  const securitySet = new Set(security.map((r) => r.token_address));

  const rowsByToken = new Map<string, MarketRow[]>();
  for (const r of market) {
    const list = rowsByToken.get(r.token_address);
    if (list) list.push(r); else rowsByToken.set(r.token_address, [r]);
  }
  const out: TokenSeries[] = [];
  for (const [token, rows] of rowsByToken) {
    const l = liqByToken.get(token);
    if (!l || !holdersSet.has(token) || !securitySet.has(token)) continue;
    out.push({
      token, chain,
      rows: rows.map((r) => ({ at: new Date(r.observed_at), market: mapMarket(r, chain) })),
      liquidity: mapLiquidity(token, chain, l),
      // ponytail: placeholder snapshots satisfy the strategy's layer checks
      // with neutral values — replace with real holder/security history when
      // the replay needs those gates to bite
      holders: neutralHolders(token, chain, l.observed_at),
      security: neutralSecurity(token, chain, l.observed_at),
    });
  }
  return out;
}

function num(v: string | null | undefined): number { return v === null || v === undefined ? 0 : parseFloat(v); }

function mapMarket(r: MarketRow, chain: Chain): MarketSnapshot {
  return {
    tokenAddress: r.token_address, chain,
    priceUsd: parseFloat(r.price_usd), price: parseFloat(r.price_usd),
    marketCapUsd: num(r.market_cap_usd),
    volumeUsd1m: num(r.volume_usd_1m), volumeUsd5m: num(r.volume_usd_5m),
    volumeUsd15m: num(r.volume_usd_15m), volumeUsd1h: num(r.volume_usd_1h), volumeUsd24h: num(r.volume_usd_24h),
    priceChange1m: num(r.price_change_1m), priceChange5m: num(r.price_change_5m),
    priceChange15m: num(r.price_change_15m), priceChange1h: num(r.price_change_1h), priceChange24h: num(r.price_change_24h),
    buyCount1m: num(r.buy_count_1m), sellCount1m: num(r.sell_count_1m),
    buyCount5m: 0, sellCount5m: 0, buyCount1h: 0, sellCount1h: 0, // never persisted — absent = 0
    buyVolumeUsd1m: num(r.buy_volume_usd_1m), sellVolumeUsd1m: num(r.sell_volume_usd_1m),
    uniqueBuyers1m: num(r.unique_buyers_1m), uniqueSellers1m: num(r.unique_sellers_1m),
    tradeCount24h: num(r.trade_count_24h), uniqueTraders24h: 0,
    observedAt: new Date(r.observed_at), provider: r.provider, confidence: parseFloat(r.confidence),
  };
}

function mapLiquidity(token: string, chain: Chain, r: LiquidityRow): LiquiditySnapshot {
  return {
    tokenAddress: token, chain,
    poolAddress: r.pool_address ?? "unknown",
    liquidityUsd: num(r.liquidity_usd), poolAgeMs: num(r.pool_age_ms),
    liquidityBase: 0, liquidityQuote: 0,
    baseToken: token, quoteToken: "USDT",
    dex: r.dex ?? "unknown",
    estimatedSlippageBps50: num(r.slippage_bps_50), estimatedSlippageBps500: num(r.slippage_bps_500),
    estimatedSlippageBps5000: num(r.slippage_bps_5000),
    liquidityChange5m: num(r.liquidity_change_5m), liquidityChange15m: num(r.liquidity_change_15m),
    observedAt: new Date(r.observed_at), provider: r.provider, confidence: parseFloat(r.confidence),
  };
}

function neutralHolders(token: string, chain: Chain, at: Date) {
  return {
    tokenAddress: token, chain, totalHolders: 5_000,
    top1Pct: 5, top5Pct: 20, top10Pct: 30, top20Pct: 45,
    creatorPct: 0, insiderPct: 0, sniperPct: 0, bundlerPct: 0, whalePct: 0,
    holderGrowth5m: 0, holderGrowth15m: 0, holderGrowth1h: 0,
    concentrationChange5m: 0, concentrationChange15m: 0,
    observedAt: at, provider: "backtest-neutral", confidence: 0.5,
  };
}

function neutralSecurity(token: string, chain: Chain, at: Date) {
  return {
    tokenAddress: token, chain, status: "SAFE" as const, score: 75,
    reasons: [], providerResults: [],
    checkedAt: at, dataTimestamp: at, ageMs: 0, confidence: 0.5,
  };
}
