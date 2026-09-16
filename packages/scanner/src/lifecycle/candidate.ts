/**
 * Token candidate — the central object flowing through the scanner pipeline.
 * Accumulates data as it progresses through lifecycle stages.
 */
import type {
  Chain,
  TokenLifecycleStatus,
  SecurityAssessment,
  MarketSnapshot,
  LiquiditySnapshot,
  HolderSnapshot,
  FeatureSet,
} from "@autonomous-trader/shared";

export interface TokenCandidate {
  readonly tokenAddress: string;
  readonly chain: Chain;
  status: TokenLifecycleStatus;
  firstSeenAt: Date;
  lastUpdatedAt: Date;
  discoverySource: string;
  discoveryPool?: string;

  // Data layers — populated progressively
  security?: SecurityAssessment;
  market?: MarketSnapshot;
  liquidity?: LiquiditySnapshot;
  holders?: HolderSnapshot;

  // Computed
  features: FeatureSet;
  scores: CandidateScores;

  // Rejection tracking
  rejectionReasons: string[];
  /** When the candidate was last rejected — drives the revive cooldown. */
  rejectedAt?: Date;

  // Observation window
  observationStartedAt?: Date;
  observationEndsAt?: Date;

  // How many times data has been refreshed
  refreshCount: number;
}

export interface CandidateScores {
  security: number;   // 0–100
  liquidity: number;  // 0–100
  holder: number;     // 0–100
  momentum: number;   // 0–100
  marketQuality: number; // 0–100
  execution: number;  // 0–100
  risk: number;       // 0–100
  opportunity: number; // composite 0–100
  computedAt?: Date;
}

export const EMPTY_SCORES: CandidateScores = {
  security: 0, liquidity: 0, holder: 0, momentum: 0,
  marketQuality: 0, execution: 0, risk: 0, opportunity: 0,
};

export function createCandidate(
  tokenAddress: string,
  chain: Chain,
  source: string,
  pool?: string,
): TokenCandidate {
  const candidate: TokenCandidate = {
    tokenAddress,
    chain,
    status: "DISCOVERED",
    firstSeenAt: new Date(),
    lastUpdatedAt: new Date(),
    discoverySource: source,
    features: {},
    scores: { ...EMPTY_SCORES },
    rejectionReasons: [],
    refreshCount: 0,
  };
  if (pool !== undefined) candidate.discoveryPool = pool;
  return candidate;
}
