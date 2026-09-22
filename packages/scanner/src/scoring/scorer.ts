/**
 * Candidate scorer — produces normalized 0–100 scores per dimension.
 * Weights are configurable; defaults are conservative starting points.
 *
 * Data-missing dimensions (provider never indexed the token — see
 * isSecurityDataMissing / isHolderDataMissing) return null and are EXCLUDED
 * from the composite with weight renormalization, instead of scoring 0:
 * a zero-drag composite made unverified tokens mathematically unpromotable.
 * ponytail: paper-phase tolerance; drop this when every chain has full
 * provider coverage.
 */
import { isHolderDataMissing, isSecurityDataMissing } from "@autonomous-trader/shared";
import type { TokenCandidate, CandidateScores } from "../lifecycle/candidate.js";

export interface ScoringWeights {
  security: number;
  liquidity: number;
  holder: number;
  momentum: number;
  marketQuality: number;
  execution: number;
  risk: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  security: 0.25,
  liquidity: 0.20,
  holder: 0.20,
  momentum: 0.15,
  marketQuality: 0.10,
  execution: 0.05,
  risk: 0.05,
};

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

export function scoreCandidate(
  candidate: TokenCandidate,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): CandidateScores {
  const security  = scoreSecurityDimension(candidate);
  const liquidity = scoreLiquidityDimension(candidate);
  const holder    = scoreHolderDimension(candidate);
  const momentum  = scoreMomentumDimension(candidate);
  const marketQuality = scoreMarketQualityDimension(candidate);
  const execution = scoreExecutionDimension(candidate);
  const risk      = scoreRiskDimension(candidate);

  // null dims (data-missing) drop out; composite = weighted mean of what we have
  const parts: Array<[value: number, weight: number]> = [
    [security, weights.security],
    [liquidity, weights.liquidity],
    [holder, weights.holder],
    [momentum, weights.momentum],
    [marketQuality, weights.marketQuality],
    [execution, weights.execution],
    [risk, weights.risk],
  ].filter((p): p is [number, number] => p[0] !== null);
  const activeWeight = parts.reduce((s, [, w]) => s + w, 0);
  const opportunity = activeWeight > 0
    ? clamp(parts.reduce((s, [v, w]) => s + v * w, 0) / activeWeight)
    : 0;

  return {
    security: security ?? 0, liquidity, holder: holder ?? 0, momentum,
    marketQuality, execution, risk, opportunity,
    computedAt: new Date(),
  };
}

// ─── Dimension scorers ────────────────────────────────────────────────────────
// security/holder return null when the dimension is data-missing.

function scoreSecurityDimension(c: TokenCandidate): number | null {
  if (!c.security) return 0;
  if (isSecurityDataMissing(c.security)) return null;
  const { status, score, confidence } = c.security;
  if (status === "REJECT") return 0;
  if (status === "UNKNOWN") return clamp(score * 0.3 * confidence);
  if (status === "WARNING") return clamp(score * 0.6);
  return clamp(score * confidence);
}

function scoreLiquidityDimension(c: TokenCandidate): number {
  if (!c.liquidity) return 0;
  const liq = c.liquidity;

  // Liquidity score: $50k = 50pts, $500k = 90pts, $5M = 100pts
  const liqScore = Math.min(100, Math.log10(Math.max(1, liq.liquidityUsd / 50_000)) * 45 + 50);

  // Slippage penalty: low slippage is good
  const slipScore = Math.max(0, 100 - liq.estimatedSlippageBps500 / 3);

  // Liquidity trend: growing = bonus, draining = penalty
  const trendScore = 50 + clamp(liq.liquidityChange5m * 2, -50, 50);

  // Pool age: young pools are risky
  const ageMinutes = liq.poolAgeMs / 60_000;
  const ageScore = ageMinutes < 5 ? 20 : ageMinutes < 30 ? 60 : 100;

  return clamp((liqScore * 0.4 + slipScore * 0.3 + trendScore * 0.2 + ageScore * 0.1));
}

function scoreHolderDimension(c: TokenCandidate): number | null {
  if (!c.holders) return 0;
  if (isHolderDataMissing(c.holders)) return null;
  const h = c.holders;

  // Concentration penalty: lower top10 is better
  const concentrationScore = clamp(100 - h.top10Pct);

  // Bad actor penalty
  const badActorPenalty = (h.insiderPct * 1.5 + h.sniperPct * 1.2 + h.bundlerPct);
  const cleanScore = clamp(100 - badActorPenalty);

  // Holder count: more holders = better
  const holderCountScore = Math.min(100, Math.log10(Math.max(1, h.totalHolders)) * 33);

  // Holder growth: positive growth is good
  const growthScore = clamp(50 + h.holderGrowth5m * 5, 0, 100);

  // Concentration trend: increasing concentration is bad
  const trendPenalty = Math.max(0, h.concentrationChange5m * 3);
  const trendScore = clamp(100 - trendPenalty);

  return clamp(
    concentrationScore * 0.25 +
    cleanScore * 0.30 +
    holderCountScore * 0.20 +
    growthScore * 0.15 +
    trendScore * 0.10,
  );
}

function scoreMomentumDimension(c: TokenCandidate): number {
  if (!c.market) return 0;
  const m = c.market;

  // Price momentum: positive is good, but not explosive (could be dump)
  const pc5m = clamp(m.priceChange5m, -100, 100);
  const pc15m = clamp(m.priceChange15m, -100, 100);

  // Balanced momentum: 5–20% in 5m is ideal. >50% is suspicious.
  const momentumScore5m = pc5m < 0 ? clamp(50 + pc5m)
    : pc5m < 5  ? 55
    : pc5m < 20 ? 70 + (pc5m - 5) * 2
    : pc5m < 50 ? 100 - (pc5m - 20) * 0.5
    : 40; // too explosive

  const momentumScore15m = pc15m < 0 ? clamp(50 + pc15m * 0.5)
    : pc15m < 30 ? 60 + pc15m
    : 90 - (pc15m - 30) * 0.5;

  // Buy pressure
  const buySellRatio = m.sellCount1m > 0 ? m.buyCount1m / m.sellCount1m : 2;
  const buyPressureScore = clamp(Math.min(100, buySellRatio * 40));

  // Volume acceleration
  const volAccel = m.volumeUsd5m > 0 ? m.volumeUsd1m / (m.volumeUsd5m / 5) : 1;
  const volAccelScore = clamp(Math.min(100, volAccel * 50));

  return clamp(
    momentumScore5m * 0.30 +
    clamp(momentumScore15m) * 0.25 +
    buyPressureScore * 0.25 +
    volAccelScore * 0.20,
  );
}

function scoreMarketQualityDimension(c: TokenCandidate): number {
  if (!c.market) return 0;
  const m = c.market;

  const traderDiversity = Math.min(100, Math.log10(Math.max(1, m.uniqueTraders24h)) * 40);
  const volumeScore = Math.min(100, Math.log10(Math.max(1, m.volumeUsd24h / 1000)) * 33);
  const confidenceScore = m.confidence * 100;

  return clamp(traderDiversity * 0.4 + volumeScore * 0.4 + confidenceScore * 0.2);
}

function scoreExecutionDimension(c: TokenCandidate): number {
  if (!c.liquidity) return 0;
  const liq = c.liquidity;
  // Can we get in AND out?
  const slipScore = Math.max(0, 100 - liq.estimatedSlippageBps500 / 2);
  const liqScore = Math.min(100, liq.liquidityUsd / 5_000);
  return clamp((slipScore + liqScore) / 2);
}

function scoreRiskDimension(c: TokenCandidate): number {
  // Higher = lower risk = better
  let risk = 80;

  if (c.security?.status === "WARNING") risk -= 20;
  if (c.holders && c.holders.concentrationChange5m > 3) risk -= 15;
  if (c.liquidity && c.liquidity.liquidityChange5m < -10) risk -= 20;
  if (c.market && Math.abs(c.market.priceChange1m) > 15) risk -= 10;

  return clamp(risk);
}
