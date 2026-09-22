/**
 * Mock providers for paper trading, testing, and development.
 * All mocks are deterministic when seeded, realistic when not.
 */
import type {
  Chain,
  SecurityAssessment,
  MarketSnapshot,
  LiquiditySnapshot,
  HolderSnapshot,
  TokenDiscoveredEvent,
  QuoteResult,
  ExecutionResult,
  TradeIntent,
} from "@autonomous-trader/shared";
import { AbstractProvider } from "./abstract-provider.js";
import type {
  TokenDiscoveryProvider,
  MarketDataProvider,
  LiquidityProvider,
  TokenSecurityProvider,
  HolderAnalyticsProvider,
  ChainDataProvider,
  ChainTransaction,
  SimulationResult,
  SwapQuoteProvider,
  SwapQuoteRequest,
  TradeExecutionProvider,
  TransactionMonitoringProvider,
  TransactionStatus,
} from "./interfaces.js";

// ─── Mock market data ─────────────────────────────────────────────────────────
export class MockMarketDataProvider extends AbstractProvider implements MarketDataProvider {
  readonly name = "mock-market-data";
  readonly version = "1.0.0";

  private prices = new Map<string, number>();

  getPrice(tokenAddress: string): number {
    return this.prices.get(tokenAddress) ?? 0.000001;
  }

  setPrice(tokenAddress: string, price: number): void {
    this.prices.set(tokenAddress, price);
  }

  async getMarketSnapshot(tokenAddress: string, chain: Chain): Promise<MarketSnapshot> {
    const price = this.getPrice(tokenAddress);
    const now = new Date();
    return {
      tokenAddress, chain,
      price,
      priceUsd: price,
      marketCapUsd: price * 1_000_000_000,
      volumeUsd1m: 1000 + Math.random() * 5000,
      volumeUsd5m: 5000 + Math.random() * 25000,
      volumeUsd15m: 15000 + Math.random() * 75000,
      volumeUsd1h: 60000 + Math.random() * 300000,
      volumeUsd24h: 500000 + Math.random() * 2000000,
      priceChange1m: (Math.random() - 0.45) * 2,
      priceChange5m: (Math.random() - 0.45) * 5,
      priceChange15m: (Math.random() - 0.45) * 10,
      priceChange1h: (Math.random() - 0.45) * 20,
      priceChange24h: (Math.random() - 0.45) * 50,
      buyCount1m: Math.floor(5 + Math.random() * 30),
      sellCount1m: Math.floor(3 + Math.random() * 20),
      buyCount5m: Math.floor(25 + Math.random() * 150),
      sellCount5m: Math.floor(15 + Math.random() * 100),
      buyCount1h: Math.floor(150 + Math.random() * 900),
      sellCount1h: Math.floor(100 + Math.random() * 600),
      buyVolumeUsd1m: 600 + Math.random() * 3000,
      sellVolumeUsd1m: 400 + Math.random() * 2000,
      uniqueBuyers1m: Math.floor(3 + Math.random() * 15),
      uniqueSellers1m: Math.floor(2 + Math.random() * 10),
      tradeCount24h: Math.floor(500 + Math.random() * 5000),
      uniqueTraders24h: Math.floor(100 + Math.random() * 1000),
      observedAt: now,
      provider: this.name,
      confidence: 0.95,
    };
  }

  async getMarketSnapshots(tokenAddresses: string[], chain: Chain): Promise<MarketSnapshot[]> {
    return Promise.all(tokenAddresses.map((a) => this.getMarketSnapshot(a, chain)));
  }

  subscribeToPrice(
    tokenAddress: string,
    chain: Chain,
    handler: (snapshot: MarketSnapshot) => void,
  ): () => void {
    const interval = setInterval(() => {
      // Drift price by ±0.5% each tick
      const current = this.getPrice(tokenAddress);
      this.setPrice(tokenAddress, current * (1 + (Math.random() - 0.5) * 0.01));
      void this.getMarketSnapshot(tokenAddress, chain).then(handler);
    }, 2000);
    return () => clearInterval(interval);
  }
}

// ─── Mock liquidity ───────────────────────────────────────────────────────────
export class MockLiquidityProvider extends AbstractProvider implements LiquidityProvider {
  readonly name = "mock-liquidity";
  readonly version = "1.0.0";

  async getLiquiditySnapshot(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot> {
    const liq = 75_000 + Math.random() * 425_000;
    return {
      tokenAddress, chain,
      poolAddress: `pool_${tokenAddress.slice(0, 8)}`,
      liquidityUsd: liq,
      liquidityBase: liq / 2,
      liquidityQuote: liq / 2,
      poolAgeMs: 30 * 60 * 1000 + Math.random() * 5 * 60 * 60 * 1000,
      baseToken: tokenAddress,
      quoteToken: "So11111111111111111111111111111111111111112",
      dex: "raydium",
      estimatedSlippageBps50: 5 + Math.random() * 15,
      estimatedSlippageBps500: 20 + Math.random() * 50,
      estimatedSlippageBps5000: 100 + Math.random() * 200,
      liquidityChange5m: (Math.random() - 0.5) * 5,
      liquidityChange15m: (Math.random() - 0.5) * 10,
      observedAt: new Date(),
      provider: this.name,
      confidence: 0.9,
    };
  }

  async getPools(tokenAddress: string, chain: Chain): Promise<LiquiditySnapshot[]> {
    return [await this.getLiquiditySnapshot(tokenAddress, chain)];
  }

  async estimateSlippage(
    _tokenAddress: string,
    _chain: Chain,
    tradeValueUsd: number,
    _side: "BUY" | "SELL",
  ): Promise<{ slippageBps: number; priceImpactBps: number; liquidityUsd: number }> {
    const liquidityUsd = 100_000;
    const impact = (tradeValueUsd / liquidityUsd) * 10_000; // simplified model
    return { slippageBps: impact * 0.5, priceImpactBps: impact, liquidityUsd };
  }
}

// ─── Mock security ────────────────────────────────────────────────────────────
export class MockSecurityProvider extends AbstractProvider implements TokenSecurityProvider {
  readonly name = "mock-security";
  readonly version = "1.0.0";

  private overrides = new Map<string, "SAFE" | "WARNING" | "REJECT">();

  setOverride(tokenAddress: string, status: "SAFE" | "WARNING" | "REJECT"): void {
    this.overrides.set(tokenAddress, status);
  }

  async analyzeToken(tokenAddress: string, chain: Chain): Promise<SecurityAssessment> {
    const status = this.overrides.get(tokenAddress) ?? "SAFE";
    return {
      tokenAddress, chain, status,
      score: status === "SAFE" ? 85 + Math.random() * 15 : status === "WARNING" ? 40 : 10,
      reasons: status === "SAFE" ? [] : [{ code: "MOCK_WARN", message: "Mock warning", severity: "MEDIUM" }],
      providerResults: [],
      checkedAt: new Date(),
      dataTimestamp: new Date(),
      ageMs: 0,
      confidence: 0.9,
    };
  }

  async analyzeTokens(tokenAddresses: string[], chain: Chain): Promise<SecurityAssessment[]> {
    return Promise.all(tokenAddresses.map((a) => this.analyzeToken(a, chain)));
  }
}

// ─── Mock holder analytics ────────────────────────────────────────────────────
export class MockHolderAnalyticsProvider extends AbstractProvider implements HolderAnalyticsProvider {
  readonly name = "mock-holders";
  readonly version = "1.0.0";

  async getHolderSnapshot(tokenAddress: string, chain: Chain): Promise<HolderSnapshot> {
    return {
      tokenAddress, chain,
      totalHolders: Math.floor(100 + Math.random() * 2000),
      top1Pct: 5 + Math.random() * 15,
      top5Pct: 15 + Math.random() * 25,
      top10Pct: 25 + Math.random() * 35,
      top20Pct: 40 + Math.random() * 40,
      creatorPct: 1 + Math.random() * 5,
      insiderPct: 2 + Math.random() * 8,
      sniperPct: 1 + Math.random() * 5,
      bundlerPct: 0.5 + Math.random() * 3,
      whalePct: 10 + Math.random() * 20,
      holderGrowth5m: Math.random() * 3,
      holderGrowth15m: Math.random() * 8,
      holderGrowth1h: Math.random() * 20,
      concentrationChange5m: (Math.random() - 0.5) * 2,
      concentrationChange15m: (Math.random() - 0.5) * 5,
      observedAt: new Date(),
      provider: this.name,
      confidence: 0.85,
    };
  }
}

// ─── Mock chain data ──────────────────────────────────────────────────────────
export class MockChainDataProvider extends AbstractProvider implements ChainDataProvider {
  readonly name = "mock-chain";
  readonly version = "1.0.0";

  async getTokenSupply(_mintAddress: string): Promise<{ amount: bigint; decimals: number }> {
    return { amount: 1_000_000_000_000_000n, decimals: 6 };
  }

  async getAccountBalance(_publicKey: string): Promise<bigint> {
    return 5_000_000_000n; // 5 SOL in lamports
  }

  async getTransaction(_signature: string): Promise<ChainTransaction | null> {
    return null;
  }

  async getRecentBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: "mock_blockhash_" + Date.now(), lastValidBlockHeight: 999_999_999 };
  }

  async simulateTransaction(_tx: Uint8Array): Promise<SimulationResult> {
    return { success: true, logs: ["Program log: simulation ok"], unitsConsumed: 200_000 };
  }
}

// ─── Mock discovery ───────────────────────────────────────────────────────────
export class MockDiscoveryProvider extends AbstractProvider implements TokenDiscoveryProvider {
  readonly name = "mock-discovery";
  readonly version = "1.0.0";

  private handlers: Array<(e: TokenDiscoveredEvent) => void> = [];
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(private readonly chain: Chain = "solana") {
    super();
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    // Emit a fake new token every 30s in mock mode
    this.intervalHandle = setInterval(() => {
      const fakeAddr = "mock" + Math.random().toString(36).slice(2, 12).padEnd(40, "1");
      const event: TokenDiscoveredEvent = {
        tokenAddress: fakeAddr,
        chain: this.chain,
        firstSeenAt: new Date(),
        source: "mock-discovery",
        pool: "pool_" + fakeAddr.slice(0, 8),
        initialPrice: 0.000001 * (1 + Math.random()),
        initialLiquidityUsd: 50_000 + Math.random() * 500_000,
      };
      this.handlers.forEach((h) => h(event));
    }, 30_000);
  }

  override async shutdown(): Promise<void> {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    await super.shutdown();
  }

  subscribe(handler: (event: TokenDiscoveredEvent) => void): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  async getRecentTokens(since: Date, limit = 50): Promise<TokenDiscoveredEvent[]> {
    return []; // mock — no historical data
  }
}

// ─── Mock quote provider ──────────────────────────────────────────────────────
export class MockSwapQuoteProvider extends AbstractProvider implements SwapQuoteProvider {
  readonly name = "mock-quote";
  readonly version = "1.0.0";

  async getQuote(request: SwapQuoteRequest): Promise<QuoteResult> {
    const slippage = request.slippageBps / 10_000;
    const outputAmount = (request.amount * 998n) / 1000n; // 0.2% fee
    return {
      provider: this.name,
      inputToken: request.inputMint,
      outputToken: request.outputMint,
      inputAmount: request.amount,
      outputAmount,
      expectedPrice: 1.0,
      priceImpactBps: 50,
      slippageBps: request.slippageBps,
      routeSteps: ["mock-dex"],
      validUntil: new Date(Date.now() + 30_000),
      estimatedFeeLamports: 5000n,
      rawQuote: { mock: true },
    };
  }
}

// ─── Mock execution ───────────────────────────────────────────────────────────
export class MockTradeExecutionProvider extends AbstractProvider implements TradeExecutionProvider {
  readonly name = "mock-execution";
  readonly version = "1.0.0";

  private txCounter = 0;

  async buildSwapTransaction(
    _quote: QuoteResult,
    _walletPublicKey: string,
  ): Promise<{ transaction: Uint8Array; lastValidBlockHeight: number }> {
    return { transaction: new Uint8Array([1, 2, 3]), lastValidBlockHeight: 999_999_999 };
  }

  async submitTransaction(
    _signedTransaction: Uint8Array,
    _intent: TradeIntent,
  ): Promise<{ signature: string }> {
    this.txCounter++;
    return { signature: `mock_sig_${this.txCounter}_${Date.now()}` };
  }

  async getTransactionStatus(signature: string): Promise<TransactionStatus> {
    return { signature, status: "confirmed", slot: 100_000, confirmations: 31 };
  }
}

// ─── Mock monitoring ──────────────────────────────────────────────────────────
export class MockTransactionMonitoringProvider extends AbstractProvider implements TransactionMonitoringProvider {
  readonly name = "mock-monitoring";
  readonly version = "1.0.0";

  async monitorTransaction(
    signature: string,
    _timeoutMs: number,
    onUpdate: (status: TransactionStatus) => void,
  ): Promise<TransactionStatus> {
    await new Promise((r) => setTimeout(r, 200)); // simulate brief confirm delay
    const status: TransactionStatus = { signature, status: "confirmed", slot: 100_000, confirmations: 31 };
    onUpdate(status);
    return status;
  }
}
