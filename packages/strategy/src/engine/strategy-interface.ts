/**
 * TradingStrategy interface + StrategyContext.
 * Every strategy is a pure function over context → decision.
 * No I/O inside a strategy — all data arrives pre-fetched in context.
 */
import type { MarketRegime, StrategyDecision, FeatureSet, DataFreshnessConfig, MarketConfig } from "@autonomous-trader/shared";
import type { TokenCandidate } from "@autonomous-trader/scanner";

export interface StrategyContext {
  candidate: TokenCandidate;
  marketRegime: MarketRegime;
  portfolioValueUsd: number;
  availableCapitalUsd: number;
  openPositionCount: number;
  existingTokenExposureUsd: number;
  freshnessConfig: DataFreshnessConfig;
  marketConfig: MarketConfig;
  timestamp: Date;
}

export interface TradingStrategy {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;

  /**
   * Evaluate a candidate in the given context.
   * Must be deterministic for the same inputs.
   * Must not perform I/O.
   */
  evaluate(ctx: StrategyContext): StrategyDecision;

  /** Minimum opportunity score required before this strategy even runs. */
  readonly minimumOpportunityScore: number;
}
