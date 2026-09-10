import type {
  Chain,
  SecurityAssessment,
  MarketSnapshot,
  LiquiditySnapshot,
  HolderSnapshot,
  TokenDiscoveredEvent,
  ProviderHealth,
  QuoteResult,
  ExecutionResult,
  TradeIntent,
} from "@autonomous-trader/shared";

// ─── Base provider ────────────────────────────────────────────────────────────
export interface BaseProvider {
  readonly name: string;
  readonly version: string;
  getHealth(): Promise<ProviderHealth>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

// ─── Token discovery ──────────────────────────────────────────────────────────
export interface TokenDiscoveryProvider extends BaseProvider {
  /** Subscribe to new token events. Returns unsubscribe function. */
  subscribe(handler: (event: TokenDiscoveredEvent) => void): () => void;
  /** Poll for recently discovered tokens since a given time. */
  getRecentTokens(since: Date, limit?: number): Promise<TokenDiscoveredEvent[]>;
}

// ─── Market data ──────────────────────────────────────────────────────────────
export interface MarketDataProvider extends BaseProvider {
  getMarketSnapshot(tokenAddress: string, chain: Chain): Promise<MarketSnapshot>;
  getMarketSnapshots(tokenAddresses: string[], chain: Chain): Promise<MarketSnapshot[]>;
  subscribeToPrice(
    tokenAddress: string,
    chain: Chain,
    handler: (snapshot: MarketSnapshot) => void,
  ): () => void;
}

// ─── Liquidity ────────────────────────────────────────────────────────────────
export interface LiquidityProvider extends BaseProvider {
  getLiquiditySnapshot(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot>;
  getPools(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot[]>;
  estimateSlippage(
    tokenAddress: string,
    chain: Chain,
    tradeValueUsd: number,
    side: "BUY" | "SELL",
  ): Promise<{ slippageBps: number; priceImpactBps: number; liquidityUsd: number }>;
}

// ─── Token security ───────────────────────────────────────────────────────────
export interface TokenSecurityProvider extends BaseProvider {
  analyzeToken(tokenAddress: string, chain: Chain): Promise<SecurityAssessment>;
  /** Batch analysis — cheaper per-token on providers that support it. */
  analyzeTokens(tokenAddresses: string[], chain: Chain): Promise<SecurityAssessment[]>;
}

// ─── Holder analytics ─────────────────────────────────────────────────────────
export interface HolderAnalyticsProvider extends BaseProvider {
  getHolderSnapshot(tokenAddress: string, chain: Chain): Promise<HolderSnapshot>;
}

// ─── Chain data (RPC) ─────────────────────────────────────────────────────────
export interface ChainDataProvider extends BaseProvider {
  getTokenSupply(mintAddress: string): Promise<{ amount: bigint; decimals: number }>;
  getAccountBalance(publicKey: string): Promise<bigint>; // lamports
  getTransaction(signature: string): Promise<ChainTransaction | null>;
  getRecentBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  simulateTransaction(serializedTx: Uint8Array): Promise<SimulationResult>;
}

export interface ChainTransaction {
  signature: string;
  slot: number;
  blockTime?: number;
  err: unknown;
  meta?: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    logMessages?: string[];
  };
}

export interface SimulationResult {
  success: boolean;
  logs: string[];
  unitsConsumed?: number;
  error?: string;
}

// ─── Swap / quote ─────────────────────────────────────────────────────────────
export interface SwapQuoteProvider extends BaseProvider {
  getQuote(request: SwapQuoteRequest): Promise<QuoteResult>;
}

export interface SwapQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  chain: Chain;
}

// ─── Trade execution ──────────────────────────────────────────────────────────
export interface TradeExecutionProvider extends BaseProvider {
  buildSwapTransaction(
    quote: QuoteResult,
    walletPublicKey: string,
  ): Promise<{ transaction: Uint8Array; lastValidBlockHeight: number }>;

  submitTransaction(
    signedTransaction: Uint8Array,
    intent: TradeIntent,
  ): Promise<{ signature: string }>;

  getTransactionStatus(signature: string): Promise<TransactionStatus>;
}

export interface TransactionStatus {
  signature: string;
  status: "pending" | "confirmed" | "finalized" | "failed" | "not_found";
  slot?: number;
  confirmations?: number;
  error?: string;
}

// ─── Transaction monitoring ───────────────────────────────────────────────────
export interface TransactionMonitoringProvider extends BaseProvider {
  monitorTransaction(
    signature: string,
    timeoutMs: number,
    onUpdate: (status: TransactionStatus) => void,
  ): Promise<TransactionStatus>;
}

// ─── Provider registry ────────────────────────────────────────────────────────
export interface ProviderRegistry {
  discovery: TokenDiscoveryProvider;
  marketData: MarketDataProvider;
  liquidity: LiquidityProvider;
  security: TokenSecurityProvider;
  holders: HolderAnalyticsProvider;
  chain: ChainDataProvider;
  quote: SwapQuoteProvider;
  execution: TradeExecutionProvider;
  monitoring: TransactionMonitoringProvider;
}
