/**
 * Feature engine — computes all numeric features from raw data snapshots.
 * Every feature carries timestamp, provider, age, and confidence.
 * Stale features are rejected at decision time.
 */
import type {
  MarketSnapshot,
  LiquiditySnapshot,
  HolderSnapshot,
  SecurityAssessment,
  FeatureSet,
  FeatureValue,
  DataFreshnessConfig,
} from "@autonomous-trader/shared";
import { StaleDataError } from "@autonomous-trader/shared";

function feature(
  name: string,
  value: number,
  snapshot: { observedAt: Date; provider: string },
  confidence = 1.0,
): FeatureValue {
  const now = new Date();
  const ageMs = now.getTime() - snapshot.observedAt.getTime();
  return {
    name,
    value,
    dataTimestamp: snapshot.observedAt,
    observedAt: now,
    provider: snapshot.provider,
    ageMs,
    confidence,
  };
}

export function computeMarketFeatures(snap: MarketSnapshot): Partial<FeatureSet> {
  return {
    price_usd:           feature("price_usd",           snap.priceUsd,           snap),
    price_change_1m:     feature("price_change_1m",     snap.priceChange1m,      snap),
    price_change_5m:     feature("price_change_5m",     snap.priceChange5m,      snap),
    price_change_15m:    feature("price_change_15m",    snap.priceChange15m,     snap),
    price_change_1h:     feature("price_change_1h",     snap.priceChange1h,      snap),
    volume_usd_1m:       feature("volume_usd_1m",       snap.volumeUsd1m,        snap),
    volume_usd_5m:       feature("volume_usd_5m",       snap.volumeUsd5m,        snap),
    volume_usd_15m:      feature("volume_usd_15m",      snap.volumeUsd15m,       snap),
    volume_usd_1h:       feature("volume_usd_1h",       snap.volumeUsd1h,        snap),
    buy_count_1m:        feature("buy_count_1m",        snap.buyCount1m,         snap),
    sell_count_1m:       feature("sell_count_1m",       snap.sellCount1m,        snap),
    buy_volume_usd_1m:   feature("buy_volume_usd_1m",   snap.buyVolumeUsd1m,     snap),
    sell_volume_usd_1m:  feature("sell_volume_usd_1m",  snap.sellVolumeUsd1m,    snap),
    unique_buyers_1m:    feature("unique_buyers_1m",    snap.uniqueBuyers1m,     snap),
    unique_sellers_1m:   feature("unique_sellers_1m",   snap.uniqueSellers1m,    snap),
    trade_count_24h:     feature("trade_count_24h",     snap.tradeCount24h,      snap),
    unique_traders_24h:  feature("unique_traders_24h",  snap.uniqueTraders24h,   snap),
    // Derived
    // Absent trade counts (DexScreener: TON always, Solana without Birdeye) are
    // unknown, not bearish — omit the feature so strategies apply their neutral default
    ...(snap.buyCount1m === 0 && snap.sellCount1m === 0
      ? {}
      : {
          buy_sell_ratio: feature(
            "buy_sell_ratio",
            snap.sellCount1m > 0 ? snap.buyCount1m / snap.sellCount1m : snap.buyCount1m,
            snap,
          ),
        }),
    volume_buy_pct: feature(
      "volume_buy_pct",
      snap.volumeUsd1m > 0 ? (snap.buyVolumeUsd1m / snap.volumeUsd1m) * 100 : 50,
      snap,
    ),
    market_cap_usd: feature("market_cap_usd", snap.marketCapUsd ?? 0, snap),
  };
}

export function computeLiquidityFeatures(snap: LiquiditySnapshot): Partial<FeatureSet> {
  return {
    liquidity_usd:         feature("liquidity_usd",         snap.liquidityUsd,           snap),
    pool_age_minutes:      feature("pool_age_minutes",      snap.poolAgeMs / 60_000,     snap),
    slippage_bps_50:       feature("slippage_bps_50",       snap.estimatedSlippageBps50,  snap),
    slippage_bps_500:      feature("slippage_bps_500",      snap.estimatedSlippageBps500, snap),
    slippage_bps_5000:     feature("slippage_bps_5000",     snap.estimatedSlippageBps5000,snap),
    liquidity_change_5m:   feature("liquidity_change_5m",   snap.liquidityChange5m,       snap),
    liquidity_change_15m:  feature("liquidity_change_15m",  snap.liquidityChange15m,      snap),
  };
}

export function computeHolderFeatures(snap: HolderSnapshot): Partial<FeatureSet> {
  return {
    total_holders:          feature("total_holders",         snap.totalHolders,          snap),
    top1_pct:               feature("top1_pct",              snap.top1Pct,               snap),
    top5_pct:               feature("top5_pct",              snap.top5Pct,               snap),
    top10_pct:              feature("top10_pct",             snap.top10Pct,              snap),
    top20_pct:              feature("top20_pct",             snap.top20Pct,              snap),
    creator_pct:            feature("creator_pct",           snap.creatorPct,            snap),
    insider_pct:            feature("insider_pct",           snap.insiderPct,            snap),
    sniper_pct:             feature("sniper_pct",            snap.sniperPct,             snap),
    bundler_pct:            feature("bundler_pct",           snap.bundlerPct,            snap),
    whale_pct:              feature("whale_pct",             snap.whalePct,              snap),
    holder_growth_5m:       feature("holder_growth_5m",      snap.holderGrowth5m,        snap),
    holder_growth_15m:      feature("holder_growth_15m",     snap.holderGrowth15m,       snap),
    holder_growth_1h:       feature("holder_growth_1h",      snap.holderGrowth1h,        snap),
    concentration_chg_5m:   feature("concentration_chg_5m",  snap.concentrationChange5m,  snap),
    concentration_chg_15m:  feature("concentration_chg_15m", snap.concentrationChange15m, snap),
  };
}

export function computeSecurityFeatures(assessment: SecurityAssessment): Partial<FeatureSet> {
  const snap = { observedAt: assessment.checkedAt, provider: assessment.providerResults[0]?.provider ?? "goplus" };
  const statusScore = assessment.status === "SAFE" ? 100 :
                      assessment.status === "WARNING" ? 50 :
                      assessment.status === "UNKNOWN" ? 30 : 0;
  return {
    security_score:      feature("security_score",      assessment.score,   snap, assessment.confidence),
    security_status_num: feature("security_status_num", statusScore,        snap, assessment.confidence),
    security_confidence: feature("security_confidence", assessment.confidence * 100, snap, 1.0),
    security_reason_count: feature("security_reason_count", assessment.reasons.length, snap, 1.0),
    security_critical_count: feature(
      "security_critical_count",
      assessment.reasons.filter((r) => r.severity === "CRITICAL").length,
      snap, 1.0,
    ),
  };
}

/** Merge feature sets — later sets override earlier ones. */
export function mergeFeatures(...sets: Partial<FeatureSet>[]): FeatureSet {
  return Object.assign({}, ...sets) as FeatureSet;
}

/** Check all required features are present and fresh. Throws StaleDataError if not. */
export function assertFreshFeatures(
  features: FeatureSet,
  requiredKeys: string[],
  freshnessConfig: DataFreshnessConfig,
): void {
  const ttls: Record<string, number> = {
    price_usd: freshnessConfig.priceMs,
    price_change_1m: freshnessConfig.priceMs,
    price_change_5m: freshnessConfig.priceMs,
    liquidity_usd: freshnessConfig.liquidityMs,
    slippage_bps_500: freshnessConfig.liquidityMs,
    top10_pct: freshnessConfig.holderMs,
    insider_pct: freshnessConfig.holderMs,
    security_score: freshnessConfig.securityMs,
  };

  for (const key of requiredKeys) {
    const fv = features[key];
    if (!fv) throw new StaleDataError(key, Infinity, 0);
    const maxAge = ttls[key] ?? freshnessConfig.priceMs;
    if (fv.ageMs > maxAge) throw new StaleDataError(key, fv.ageMs, maxAge);
  }
}
