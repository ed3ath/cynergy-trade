import {
  isHolderDataMissing, isSecurityDataMissing,
  type Chain, type DataFreshnessConfig, type MarketConfig, type Position,
} from "@autonomous-trader/shared";
import { runFilters, type TokenCandidate } from "@autonomous-trader/scanner";

export function tokenKey(chain: Chain, token: string): string {
  return `${chain}:${token}`;
}

export function entryCooldownActive(
  action: { type: string; chain: Chain; tokenAddress: string },
  cooldowns: ReadonlyMap<string, number>,
  now = Date.now(),
): boolean {
  return action.type === "ENTER" && (cooldowns.get(tokenKey(action.chain, action.tokenAddress)) ?? 0) > now;
}

export function resolveActionPosition(
  action: { tokenAddress: string; chain: Chain; positionId?: string },
  positions: readonly Position[],
): { position: Position; reason: null } | { position: null; reason: string } {
  const managed = positions.filter((p) => p.status === "OPEN" || p.status === "PARTIAL_EXIT");
  const matches = managed.filter((p) => action.positionId ? p.id === action.positionId
    : p.tokenAddress === action.tokenAddress && p.chain === action.chain);
  if (matches.length !== 1) return { position: null, reason: matches.length > 1 ? "ambiguous position; positionId required" : "position not found" };
  const position = matches[0]!;
  if (position.tokenAddress !== action.tokenAddress || position.chain !== action.chain) {
    return { position: null, reason: "position identity mismatch" };
  }
  return { position, reason: null };
}

export function currentObservation(
  observation: { tokenAddress: string; chain: Chain; observedAt: Date },
  token: string,
  chain: Chain,
  ttlMs: number,
  now = Date.now(),
): boolean {
  const at = observation.observedAt?.getTime();
  return observation.tokenAddress === token && observation.chain === chain
    && Number.isFinite(at) && at <= now && now - at <= ttlMs;
}

/** Reuses scanner policy; the caller supplies refreshed observations without
 * mutating scanner lifecycle state while an AI proposal is being applied. */
export function entryRejections(
  candidate: TokenCandidate | undefined,
  target: { tokenAddress: string; chain: Chain },
  marketConfig: MarketConfig,
  freshness: DataFreshnessConfig,
  minimumLiquidityUsd: number,
  now = Date.now(),
): string[] {
  if (!candidate || candidate.status !== "TRADE_CANDIDATE") return ["scanner candidate not eligible"];
  if (candidate.tokenAddress !== target.tokenAddress || candidate.chain !== target.chain) return ["candidate identity mismatch"];
  const { market, liquidity, security, holders } = candidate;
  if (!market || !liquidity || !security || !holders) return ["required observations missing"];
  const observations = [
    [market, freshness.priceMs], [liquidity, freshness.liquidityMs],
    [holders, freshness.holderMs],
    [{ ...security, observedAt: security.dataTimestamp }, freshness.securityMs],
  ] as const;
  if (observations.some(([s, ttl]) => !currentObservation(s, target.tokenAddress, target.chain, ttl, now))) {
    return ["stale or mismatched observations"];
  }
  if ([market, liquidity, security, holders].some((s) =>
    Object.values(s).some((v) => typeof v === "number" && !Number.isFinite(v))
    || !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1)) {
    return ["invalid observation numbers"];
  }
  if (market.priceUsd <= 0 || market.volumeUsd5m < 0 || market.volumeUsd1h < 0
      || holders.totalHolders < 0 || liquidity.liquidityUsd < 0) return ["invalid observation values"];
  return runFilters(candidate, { ...marketConfig, minLiquidityUsd: Math.max(marketConfig.minLiquidityUsd, minimumLiquidityUsd) });
}

export function entryDataQuality(candidate: TokenCandidate): string[] {
  const flags: string[] = [];
  if (!candidate.security || isSecurityDataMissing(candidate.security)) flags.push("security-unverified");
  else if (candidate.security.status !== "SAFE") flags.push(`security-${candidate.security.status.toLowerCase()}`);
  if (!candidate.holders || isHolderDataMissing(candidate.holders)) flags.push("holders-unverified");
  if (candidate.market?.provider.startsWith("mock")) flags.push("mock-market-data");
  return flags;
}
