/**
 * Hard-gate filters — each returns null (pass) or a rejection reason string.
 * Applied before scoring. Fast and cheap.
 */
import { isHolderDataMissing, isSecurityDataMissing, type MarketConfig } from "@autonomous-trader/shared";
import type { TokenCandidate } from "../lifecycle/candidate.js";

export type FilterResult = string | null; // null = pass

export interface Filter {
  readonly name: string;
  check(candidate: TokenCandidate, config: MarketConfig): FilterResult;
}

// ─── Security filter ──────────────────────────────────────────────────────────
export const SecurityFilter: Filter = {
  name: "security",
  check(candidate) {
    const sec = candidate.security;
    if (!sec) return "SECURITY_DATA_MISSING";
    if (sec.status === "REJECT") return `SECURITY_REJECTED`;
    // Data-missing (provider never indexed the token) skips the hard reject —
    // the risk engine still halves size via the security_unverified multiplier.
    if (sec.status === "UNKNOWN" && sec.confidence < 0.5 && !isSecurityDataMissing(sec)) {
      return "SECURITY_UNKNOWN_LOW_CONFIDENCE";
    }
    if (sec.reasons.some((r) => r.severity === "CRITICAL")) return "SECURITY_CRITICAL_REASON";
    return null;
  },
};

// ─── Liquidity filter ─────────────────────────────────────────────────────────
export const LiquidityFilter: Filter = {
  name: "liquidity",
  check(candidate, config) {
    const liq = candidate.liquidity;
    if (!liq) return "LIQUIDITY_DATA_MISSING";
    if (liq.liquidityUsd < config.minLiquidityUsd) {
      return `LIQUIDITY_TOO_LOW:${liq.liquidityUsd.toFixed(0)}<${config.minLiquidityUsd}`;
    }
    if (liq.estimatedSlippageBps500 > config.maxSlippageBps) {
      return `SLIPPAGE_TOO_HIGH:${liq.estimatedSlippageBps500.toFixed(0)}bps`;
    }
    if (liq.poolAgeMs < config.minPoolAgeMs) {
      return `POOL_TOO_NEW:${(liq.poolAgeMs / 60000).toFixed(1)}min`;
    }
    if (liq.liquidityChange5m < -20) {
      return `LIQUIDITY_DRAINING:${liq.liquidityChange5m.toFixed(1)}%/5m`;
    }
    return null;
  },
};

// ─── Holder filter ────────────────────────────────────────────────────────────
export const HolderFilter: Filter = {
  name: "holders",
  check(candidate, config) {
    const h = candidate.holders;
    if (!h) return "HOLDER_DATA_MISSING";
    // Data-missing (zeroed low-confidence snapshot) ≠ 0 holders — skip;
    // the holder dimension is dropped from scoring instead.
    if (h.totalHolders < config.minHolders && !isHolderDataMissing(h)) {
      return `TOO_FEW_HOLDERS:${h.totalHolders}`;
    }
    if (h.top10Pct > config.maxTop10ConcentrationPct) {
      return `TOP10_CONCENTRATION:${h.top10Pct.toFixed(1)}%`;
    }
    if (h.insiderPct > config.maxInsiderPct) {
      return `INSIDER_TOO_HIGH:${h.insiderPct.toFixed(1)}%`;
    }
    if (h.sniperPct > config.maxSniperPct) {
      return `SNIPER_TOO_HIGH:${h.sniperPct.toFixed(1)}%`;
    }
    if (h.bundlerPct > config.maxBundlerPct) {
      return `BUNDLER_TOO_HIGH:${h.bundlerPct.toFixed(1)}%`;
    }
    // Concentration increasing rapidly is a red flag
    if (h.concentrationChange5m > 5) {
      return `CONCENTRATION_INCREASING:+${h.concentrationChange5m.toFixed(1)}%/5m`;
    }
    return null;
  },
};

// ─── Market data filter ───────────────────────────────────────────────────────
export const MarketFilter: Filter = {
  name: "market",
  check(candidate) {
    const m = candidate.market;
    if (!m) return "MARKET_DATA_MISSING";
    // DexScreener never populates m5 volume for TON DEXes (STON.fi/DeDust) —
    // any nonzero volume granularity proves the token trades
    if (m.volumeUsd5m <= 0 && m.volumeUsd1h <= 0) return "ZERO_VOLUME";
    if (m.confidence < 0.5) return "MARKET_DATA_LOW_CONFIDENCE";
    return null;
  },
};

// ─── Default filter pipeline ──────────────────────────────────────────────────
export const DEFAULT_FILTERS: Filter[] = [
  SecurityFilter,
  LiquidityFilter,
  HolderFilter,
  MarketFilter,
];

/** Run all filters. Returns array of rejection reasons (empty = all pass). */
export function runFilters(
  candidate: TokenCandidate,
  config: MarketConfig,
  filters: Filter[] = DEFAULT_FILTERS,
): string[] {
  const reasons: string[] = [];
  for (const filter of filters) {
    const result = filter.check(candidate, config);
    if (result !== null) reasons.push(`${filter.name}:${result}`);
  }
  return reasons;
}
