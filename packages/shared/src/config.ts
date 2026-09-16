import { z } from "zod";

// ─── Trading mode ─────────────────────────────────────────────────────────────
export const TradingModeSchema = z.enum(["PAPER", "SHADOW", "LIVE"]);
export type TradingMode = z.infer<typeof TradingModeSchema>;

// ─── Risk config ──────────────────────────────────────────────────────────────
export const RiskConfigSchema = z.object({
  version: z.string().default("risk-v1"),
  maxDailyLossUsd: z.number().positive(),
  maxWeeklyLossUsd: z.number().positive(),
  maxDrawdownPct: z.number().positive().max(100),
  maxDrawdownEmergencyPct: z.number().positive().max(100),
  maxPositionRiskPct: z.number().positive().max(100),
  maxPositionValueUsd: z.number().positive(),
  maxTokenExposureUsd: z.number().positive(),
  maxTotalExposureUsd: z.number().positive(),
  maxStrategyExposurePct: z.number().positive().max(100),
  maxSlippageBps: z.number().positive(),
  maxPriceImpactBps: z.number().positive(),
  minLiquidityUsd: z.number().positive(),
  maxConcurrentPositions: z.number().int().positive(),
  maxTransactionCostUsd: z.number().positive(),
  baseRiskPct: z.number().positive().max(100).default(0.5),
  minRiskPct: z.number().positive().max(100).default(0.1),
  maxRiskPct: z.number().positive().max(100).default(2.0),
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

// ─── Market config ────────────────────────────────────────────────────────────
export const MarketConfigSchema = z.object({
  minLiquidityUsd: z.number().positive().default(50_000),
  maxSlippageBps: z.number().positive().default(300),
  maxPriceImpactBps: z.number().positive().default(500),
  minPoolAgeMs: z.number().positive().default(5 * 60 * 1000), // 5 min
  maxTop10ConcentrationPct: z.number().positive().max(100).default(80),
  maxInsiderPct: z.number().positive().max(100).default(30),
  maxSniperPct: z.number().positive().max(100).default(20),
  maxBundlerPct: z.number().positive().max(100).default(15),
  minHolders: z.number().int().positive().default(50),
  observationWindowMs: z.number().positive().default(3 * 60 * 1000), // 3 min
});
export type MarketConfig = z.infer<typeof MarketConfigSchema>;

// ─── Data freshness TTLs (ms) ────────────────────────────────────────────────
export const DataFreshnessConfigSchema = z.object({
  priceMs: z.number().positive().default(10_000),        // 10s
  liquidityMs: z.number().positive().default(30_000),    // 30s
  holderMs: z.number().positive().default(120_000),      // 2min
  securityMs: z.number().positive().default(300_000),    // 5min
  walletProfileMs: z.number().positive().default(600_000), // 10min
});
export type DataFreshnessConfig = z.infer<typeof DataFreshnessConfigSchema>;

// ─── Provider configs ─────────────────────────────────────────────────────────
export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().positive().default(10_000),
  maxRetries: z.number().int().nonnegative().default(3),
  retryDelayMs: z.number().positive().default(1_000),
  rateLimitPerMin: z.number().positive().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProvidersConfigSchema = z.object({
  helius: ProviderConfigSchema.default({}),
  birdeye: ProviderConfigSchema.default({}),
  goplus: ProviderConfigSchema.default({}),
  jupiter: ProviderConfigSchema.default({}),
  jito: ProviderConfigSchema.default({}),
  tonapi: ProviderConfigSchema.default({}),       // free tier ~1 rps, no key
  geckoterminal: ProviderConfigSchema.default({}), // free, no key, ~30 req/min
});
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

// ─── Execution config ─────────────────────────────────────────────────────────
export const ExecutionConfigSchema = z.object({
  provider: z.enum(["jupiter", "mock"]).default("mock"),
  priorityFeeLamports: z.number().int().nonnegative().default(5000),
  confirmationTimeoutMs: z.number().positive().default(60_000),
  maxRetransmits: z.number().int().nonnegative().default(3),
  useJito: z.boolean().default(false),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

// ─── AI config ────────────────────────────────────────────────────────────────
export const AIConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["anthropic", "mock"]).default("mock"),
  model: z.string().default("claude-opus-4-5"),
  maxCandidatesPerCycle: z.number().int().positive().default(10),
  maxCostPerDayUsd: z.number().positive().default(5.0),
});
export type AIConfig = z.infer<typeof AIConfigSchema>;

// ─── Root config ──────────────────────────────────────────────────────────────
export const AppConfigSchema = z.object({
  trading: z.object({
    mode: TradingModeSchema.default("PAPER"),
    chain: z.enum(["solana", "ton"]).default("solana"),
    walletPublicKey: z.string().optional(),
    /** Manually inject tokens into the scanner (TRADER_SEED_TOKENS, comma-sep) —
     *  for testing the full pipeline on liquid tokens when discovery finds only dust. */
    seedTokens: z.array(z.string().min(1)).default([]),
  }),
  risk: RiskConfigSchema,
  market: MarketConfigSchema.default({}),
  dataFreshness: DataFreshnessConfigSchema.default({}),
  providers: ProvidersConfigSchema.default({}),
  execution: ExecutionConfigSchema.default({}),
  ai: AIConfigSchema.default({}),
  database: z.object({
    url: z.string().default("postgresql://trader:trader@localhost:5432/trader"),
    poolMin: z.number().int().positive().default(2),
    poolMax: z.number().int().positive().default(10),
  }),
  redis: z.object({
    url: z.string().default("redis://localhost:6379"),
  }),
  server: z.object({
    port: z.number().int().positive().default(3000),
    host: z.string().default("0.0.0.0"),
  }),
  log: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    pretty: z.boolean().default(false),
  }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── Config loader ────────────────────────────────────────────────────────────
/**
 * Loads config from environment variables and optional JSON override.
 * All secrets come from env; structural config may come from a file.
 */
export function loadConfig(overrides: Partial<Record<string, unknown>> = {}): AppConfig {
  const raw = {
    trading: {
      mode: process.env["TRADING_MODE"] ?? "PAPER",
      chain: process.env["TRADING_CHAIN"] ?? "solana",
      walletPublicKey: process.env["WALLET_PUBLIC_KEY"],
      seedTokens: (process.env["TRADER_SEED_TOKENS"] ?? "")
        .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    },
    risk: {
      version: process.env["RISK_VERSION"] ?? "risk-v1",
      maxDailyLossUsd: parseFloat(process.env["MAX_DAILY_LOSS_USD"] ?? "100"),
      maxWeeklyLossUsd: parseFloat(process.env["MAX_WEEKLY_LOSS_USD"] ?? "300"),
      maxDrawdownPct: parseFloat(process.env["MAX_DRAWDOWN_PCT"] ?? "10"),
      maxDrawdownEmergencyPct: parseFloat(process.env["MAX_DRAWDOWN_EMERGENCY_PCT"] ?? "20"),
      maxPositionRiskPct: parseFloat(process.env["MAX_POSITION_RISK_PCT"] ?? "1"),
      maxPositionValueUsd: parseFloat(process.env["MAX_POSITION_VALUE_USD"] ?? "500"),
      maxTokenExposureUsd: parseFloat(process.env["MAX_TOKEN_EXPOSURE_USD"] ?? "1000"),
      maxTotalExposureUsd: parseFloat(process.env["MAX_TOTAL_EXPOSURE_USD"] ?? "2000"),
      maxStrategyExposurePct: parseFloat(process.env["MAX_STRATEGY_EXPOSURE_PCT"] ?? "50"),
      maxSlippageBps: parseInt(process.env["MAX_SLIPPAGE_BPS"] ?? "300", 10),
      maxPriceImpactBps: parseInt(process.env["MAX_PRICE_IMPACT_BPS"] ?? "500", 10),
      minLiquidityUsd: parseFloat(process.env["MIN_LIQUIDITY_USD"] ?? "50000"),
      maxConcurrentPositions: parseInt(process.env["MAX_CONCURRENT_POSITIONS"] ?? "5", 10),
      maxTransactionCostUsd: parseFloat(process.env["MAX_TRANSACTION_COST_USD"] ?? "2"),
      baseRiskPct: parseFloat(process.env["BASE_RISK_PCT"] ?? "0.5"),
      minRiskPct: parseFloat(process.env["MIN_RISK_PCT"] ?? "0.1"),
      maxRiskPct: parseFloat(process.env["MAX_RISK_PCT"] ?? "2.0"),
    },
    providers: {
      helius: { enabled: true, apiKey: process.env["HELIUS_API_KEY"] },
      birdeye: { enabled: true, apiKey: process.env["BIRDEYE_API_KEY"] },
      goplus: { enabled: true, apiKey: process.env["GOPLUS_API_KEY"] },
      jupiter: { enabled: true },
      jito: { enabled: false },
      tonapi: { enabled: true },
      geckoterminal: { enabled: true },
    },
    database: {
      url: process.env["DATABASE_URL"] ?? "postgresql://trader:trader@localhost:5432/trader",
    },
    redis: {
      url: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    },
    log: {
      level: process.env["LOG_LEVEL"] ?? "info",
      pretty: process.env["LOG_PRETTY"] === "true",
    },
    server: {
      port: parseInt(process.env["SERVER_PORT"] ?? "3000", 10),
      host: process.env["SERVER_HOST"] ?? "0.0.0.0",
    },
    ...overrides,
  };

  return AppConfigSchema.parse(raw);
}
