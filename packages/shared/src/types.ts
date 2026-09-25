// ─── Chain ────────────────────────────────────────────────────────────────────
/** EVM family = cheap-gas chains — all ride the same GeckoTerminal/DexScreener/
 *  GoPlus adapters, parameterized by network. All EVM chains are PAPER-only
 *  (boot-guarded in the trader: no quote aggregator or signing path). */
export const CHAIN_VALUES = [
  "solana", "ton",
  "bsc", "base", "polygon", "arbitrum",
  "ethereum", "avalanche", "optimism", "linea", "mantle", "blast", "zksync", "scroll",
] as const;
export type Chain = (typeof CHAIN_VALUES)[number];

// ─── Token lifecycle ──────────────────────────────────────────────────────────
export type TokenLifecycleStatus =
  | "DISCOVERED"
  | "OBSERVING"
  | "SCREENING"
  | "ELIGIBLE"
  | "WATCHLIST"
  | "TRADE_CANDIDATE"
  | "ENTERED"
  | "OPEN"
  | "EXITING"
  | "CLOSED"
  | "REJECTED"
  | "ARCHIVED";

// ─── Order lifecycle ──────────────────────────────────────────────────────────
export type OrderStatus =
  | "CREATED"
  | "VALIDATING"
  | "SIMULATING"
  | "SIGNED"
  | "SUBMITTED"
  | "CONFIRMING"
  | "CONFIRMED"
  | "FAILED"
  | "UNKNOWN"
  | "CANCELLED";

// ─── Position lifecycle ───────────────────────────────────────────────────────
export type PositionStatus =
  | "OPENING"
  | "OPEN"
  | "PARTIAL_EXIT"
  | "CLOSING"
  | "CLOSED"
  | "ERROR";

// ─── Security ─────────────────────────────────────────────────────────────────
export type SecurityStatus = "SAFE" | "WARNING" | "REJECT" | "UNKNOWN";

export interface SecurityReason {
  code: string;
  message: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface ProviderSecurityResult {
  provider: string;
  status: SecurityStatus;
  rawData: unknown;
  checkedAt: Date;
  latencyMs: number;
}

export interface SecurityAssessment {
  tokenAddress: string;
  chain: Chain;
  status: SecurityStatus;
  score: number; // 0–100, higher = safer
  reasons: SecurityReason[];
  providerResults: ProviderSecurityResult[];
  checkedAt: Date;
  dataTimestamp: Date;
  ageMs: number;
  confidence: number; // 0–1
}

// ─── Market data ──────────────────────────────────────────────────────────────
export interface MarketSnapshot {
  tokenAddress: string;
  chain: Chain;
  poolAddress?: string;
  price: number;
  priceUsd: number;
  marketCapUsd?: number;
  volumeUsd1m: number;
  volumeUsd5m: number;
  volumeUsd15m: number;
  volumeUsd1h: number;
  volumeUsd24h: number;
  priceChange1m: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange1h: number;
  priceChange24h: number;
  buyCount1m: number;
  sellCount1m: number;
  /** Window trade counts (DexScreener txns.m5/h1; 0 when provider lacks them). */
  buyCount5m: number;
  sellCount5m: number;
  buyCount1h: number;
  sellCount1h: number;
  buyVolumeUsd1m: number;
  sellVolumeUsd1m: number;
  uniqueBuyers1m: number;
  uniqueSellers1m: number;
  tradeCount24h: number;
  uniqueTraders24h: number;
  observedAt: Date;
  provider: string;
  confidence: number;
}

// ─── Liquidity ────────────────────────────────────────────────────────────────
export interface LiquiditySnapshot {
  tokenAddress: string;
  chain: Chain;
  poolAddress: string;
  liquidityUsd: number;
  liquidityBase: number;
  liquidityQuote: number;
  poolAgeMs: number;
  baseToken: string;
  quoteToken: string;
  /** Display-only passthrough (DexScreener baseToken) — not persisted. */
  baseTokenSymbol?: string;
  baseTokenName?: string;
  dex: string;
  estimatedSlippageBps50: number;  // bps slippage for $50 trade
  estimatedSlippageBps500: number;
  estimatedSlippageBps5000: number;
  liquidityChange5m: number;
  liquidityChange15m: number;
  observedAt: Date;
  provider: string;
  confidence: number;
}

// ─── Holder distribution ──────────────────────────────────────────────────────
export interface HolderSnapshot {
  tokenAddress: string;
  chain: Chain;
  totalHolders: number;
  top1Pct: number;
  top5Pct: number;
  top10Pct: number;
  top20Pct: number;
  creatorPct: number;
  insiderPct: number;
  sniperPct: number;
  bundlerPct: number;
  whalePct: number;
  holderGrowth5m: number;
  holderGrowth15m: number;
  holderGrowth1h: number;
  concentrationChange5m: number;
  concentrationChange15m: number;
  observedAt: Date;
  provider: string;
  confidence: number;
}

// ─── Data-missing detection ───────────────────────────────────────────────────
/**
 * True when the security provider never indexed the token (UNKNOWN carrying
 * only NO_DATA/PROVIDER_ERROR) — distinct from a provider that LOOKED and
 * returned uncertain findings. GoPlus returns this for brand-new EVM pools.
 * Still UNKNOWN, never SAFE: used to skip hard rejects and re-normalize
 * scoring, with a sizing penalty at the risk engine.
 * ponytail: paper-phase tolerance; before EVM SHADOW/LIVE require a provider
 * that verifies (or re-check GoPlus once it indexes the token).
 */
export function isSecurityDataMissing(a: SecurityAssessment): boolean {
  return a.status === "UNKNOWN"
    && a.reasons.length > 0
    && a.reasons.every((r) => r.code === "NO_DATA" || r.code === "PROVIDER_ERROR");
}

/** True for a zeroed low-confidence holder snapshot — provider returned no
 *  data (GoPlus hasn't indexed the token). 0 holders with real confidence is
 *  NOT data-missing and still rejects. */
export function isHolderDataMissing(h: HolderSnapshot): boolean {
  return h.totalHolders <= 0 && h.confidence <= 0.1;
}

// ─── Features ─────────────────────────────────────────────────────────────────
export interface FeatureValue {
  name: string;
  value: number;
  dataTimestamp: Date;
  observedAt: Date;
  provider: string;
  ageMs: number;
  confidence: number; // 0–1
}

export type FeatureSet = Record<string, FeatureValue>;

// ─── Strategy ─────────────────────────────────────────────────────────────────
export type StrategyDecisionType = "ENTER" | "SKIP" | "REJECT";

export interface StrategyDecision {
  strategyId: string;
  strategyVersion: string;
  tokenAddress: string;
  decision: StrategyDecisionType;
  confidence: number;
  reasons: string[];
  risks: string[];
  invalidationConditions: string[];
  suggestedEntryPrice?: number;
  suggestedStopLoss?: number;
  suggestedTakeProfit1?: number;
  suggestedTakeProfit2?: number;
  /** Trailing stop % from high-water mark (scalping uses tighter trails). */
  suggestedTrailingStopPct?: number;
  evaluatedAt: Date;
}

// ─── AI assessment ────────────────────────────────────────────────────────────
export type AIDecision = "TRADE" | "WATCH" | "REJECT";

export interface AITradeAssessment {
  tokenAddress: string;
  decision: AIDecision;
  confidence: number; // 0–1
  setupType: string;
  reasons: string[];
  risks: string[];
  invalidationConditions: string[];
  rankScore: number; // relative ranking score
  assessedAt: Date;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

// ─── Risk ─────────────────────────────────────────────────────────────────────
export type RiskDecisionType = "APPROVED" | "REJECTED" | "REDUCED";

export interface RiskDecision {
  tradeIntentId: string;
  decision: RiskDecisionType;
  rejectionReasons: string[];
  approvedPositionSizeUsd: number;
  approvedRiskFraction: number;
  maxSlippageBps: number;
  riskVersion: string;
  decidedAt: Date;
}

// ─── Execution ────────────────────────────────────────────────────────────────
export type TradeSide = "BUY" | "SELL";
export type TradeMode = "PAPER" | "SHADOW" | "LIVE";

export interface TradeIntent {
  id: string;
  tokenAddress: string;
  chain: Chain;
  side: TradeSide;
  mode: TradeMode;
  strategyId: string;
  strategyVersion: string;
  riskVersion: string;
  positionSizeUsd: number;
  /** PAPER SELL only: exact synthetic token-nano quantity (1 token = 1e9).
   *  SHADOW/LIVE amounts remain in their provider's native units. */
  paperTokenQuantity?: bigint;
  positionId?: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  reason: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface QuoteResult {
  provider: string;
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  outputAmount: bigint;
  expectedPrice: number;
  priceImpactBps: number;
  slippageBps: number;
  routeSteps: string[];
  validUntil: Date;
  estimatedFeeLamports: bigint;
  rawQuote: unknown;
}

export interface ExecutionResult {
  tradeIntentId: string;
  orderId: string;
  status: OrderStatus;
  txSignature?: string;
  inputAmount: bigint;
  outputAmount: bigint;
  executedPrice: number;
  actualSlippageBps: number;
  feesLamports: bigint;
  feeUsd: number;
  confirmedAt?: Date;
  error?: string;
  mode: TradeMode;
}

/** Confirmed PAPER cash flow. Null realization fields mean legacy accounting
 *  cannot be reconciled; they must never be interpreted as zero net PnL. */
export interface PaperFillAccounting {
  cashDeltaUsd: number;
  realizedPnlDeltaUsd: number | null;
  realizedGrossPnlDeltaUsd: number | null;
  soldCostBasisUsd: number | null;
  allocatedEntryFeeUsd: number | null;
}

// ─── Position ─────────────────────────────────────────────────────────────────
export interface Position {
  id: string;
  tokenAddress: string;
  chain: Chain;
  status: PositionStatus;
  mode: TradeMode;
  strategyId: string;
  entryPrice: number;
  currentPrice: number;
  /** Remaining cost basis, excluding entry fees. */
  sizeUsd: number;
  /** Remaining quantity; synthetic token-nano only in PAPER mode. */
  sizeTokens: bigint;
  /** Absent/1 is legacy, never implicitly upgraded during restoration. */
  accountingVersion?: 1 | 2;
  initialSizeUsd?: number;
  initialSizeTokens?: bigint;
  entryFeeUsd?: number;
  remainingEntryFeeUsd?: number;
  realizedPnlUsd?: number;
  realizedGrossPnlUsd?: number;
  totalFeesUsd?: number;
  entryOrderId?: string;
  exitOrderId?: string;
  closedAt?: Date;
  dataQuality?: string[];
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  trailingStopPct?: number;
  peakPrice: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  drawdownFromPeakPct: number;
  entryTxSignature?: string;
  exitReason?: string;
  /** Per-position time stop (ms) — copy-trade scalp/short-term profiles.
   *  Not persisted (no DB column): restored positions fall back to the
   *  strategyId→profile lookup, then the 2h manager default. */
  timeStopMs?: number;
  openedAt: Date;
  updatedAt: Date;
}

// ─── Portfolio ────────────────────────────────────────────────────────────────
export interface PortfolioSnapshot {
  totalValueUsd: number;
  availableCapitalUsd: number;
  allocatedUsd: number;
  openPositions: number;
  dailyPnlUsd: number;
  weeklyPnlUsd: number;
  monthlyPnlUsd: number;
  allTimePnlUsd: number;
  currentDrawdownPct: number;
  peakValueUsd: number;
  snapshotAt: Date;
}

// ─── Market regime ────────────────────────────────────────────────────────────
export type MarketRegime =
  | "BULL"
  | "BEAR"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "RISK_OFF"
  | "UNKNOWN";

// ─── Discovery event ──────────────────────────────────────────────────────────
export interface TokenDiscoveredEvent {
  tokenAddress: string;
  chain: Chain;
  firstSeenAt: Date;
  source: string;
  pool?: string;
  initialPrice?: number;
  initialLiquidityUsd?: number;
  metadata?: Record<string, unknown>;
}

// ─── Provider health ──────────────────────────────────────────────────────────
export interface ProviderHealth {
  providerName: string;
  providerVersion: string;
  isAvailable: boolean;
  latencyMs: number;
  lastSuccessAt?: Date;
  lastErrorAt?: Date;
  errorRate: number; // 0–1 over recent window
  rateLimitRemaining?: number;
  dataFreshnessMs?: number;
  checkedAt: Date;
}

// ─── System events ────────────────────────────────────────────────────────────
export type SystemEventType =
  | "STARTUP"
  | "SHUTDOWN"
  | "KILL_SWITCH_ACTIVATED"
  | "KILL_SWITCH_DEACTIVATED"
  | "DAILY_LOSS_LIMIT_HIT"
  | "DRAWDOWN_LIMIT_HIT"
  | "PROVIDER_FAILURE"
  | "PROVIDER_RECOVERED"
  | "EXECUTION_FAILURE"
  | "STRATEGY_DISABLED"
  | "STRATEGY_ENABLED"
  | "MODE_CHANGED"
  | "RISK_LIMIT_CHANGED";

export interface SystemEvent {
  id: string;
  type: SystemEventType;
  message: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

// ─── Errors ───────────────────────────────────────────────────────────────────
export class TradingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TradingError";
  }
}

export class ProviderError extends TradingError {
  constructor(
    message: string,
    public readonly provider: string,
    context?: Record<string, unknown>,
  ) {
    super(message, "PROVIDER_ERROR", { provider, ...context });
    this.name = "ProviderError";
  }
}

export class RiskRejectionError extends TradingError {
  constructor(reasons: string[]) {
    super(`Trade rejected by risk engine: ${reasons.join(", ")}`, "RISK_REJECTION", { reasons });
    this.name = "RiskRejectionError";
  }
}

export class ExecutionError extends TradingError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "EXECUTION_ERROR", context);
    this.name = "ExecutionError";
  }
}

export class StaleDataError extends TradingError {
  constructor(feature: string, ageMs: number, maxAgeMs: number) {
    super(
      `Data too stale for ${feature}: age=${ageMs}ms max=${maxAgeMs}ms`,
      "STALE_DATA",
      { feature, ageMs, maxAgeMs },
    );
    this.name = "StaleDataError";
  }
}
