/**
 * Autonomous Trading Loop
 *
 * The main decision cycle:
 * 1. Check emergency state
 * 2. Get top trade candidates from scanner
 * 3. Run strategy ensemble
 * 4. Run risk engine
 * 5. Execute approved trades (paper/shadow/live)
 * 6. Monitor open positions for exits
 *
 * Runs continuously. Every exit is logged. Zero manual approvals in normal flow.
 *
 * Multi-chain: TRADING_CHAIN accepts a comma list ("solana,ton,bsc"). One
 * ChainRuntime per chain (providers, scanner, execution router, positions,
 * equity book, regime). Shared across chains: journal, emergency controller,
 * idempotency guard, risk engine, alerter, AI veto, performance trackers.
 * ponytail: risk limits are per-chain books — aggregate cross-chain exposure
 * is not gated; upgrade = a portfolio aggregator feeding the risk engine.
 */
import {
  loadConfig,
  configureLogger,
  createLogger,
  generateTradeIntentId,
  type Chain,
  type PortfolioSnapshot,
  type TradeIntent,
} from "@autonomous-trader/shared";
import {
  RiskEngine,
  EmergencyController,
  InMemoryEmergencyPersistence,
  PgEmergencyPersistence,
  StrategyPerformanceTracker,
  Database,
  JournalRepository,
  createNullJournal,
  classifyRegime,
  SolPriceSampler,
  type RegimeResult,
} from "@autonomous-trader/core";
import { readFileSync } from "node:fs";
import {
  createProviderRegistry,
  isEvmChain,
  EVM_CHAINS,
  type ProviderRegistry,
} from "@autonomous-trader/providers";
import { Scanner, type ScannerConfig } from "@autonomous-trader/scanner";
import { StrategyEngine, FreshMomentumStrategy, MicroScalpStrategy, type StrategyContext } from "@autonomous-trader/strategy";
import {
  createExecutionRouter,
  PgIdempotencyGuard,
  InMemoryIdempotencyGuard,
  FallbackIdempotencyGuard,
  RedisIdempotencyGuard,
  type ExecutionRouter,
} from "@autonomous-trader/execution";
import { PositionManager } from "@autonomous-trader/position";

// ─── Bootstrap ────────────────────────────────────────────────────────────────
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const config = loadConfig();
configureLogger({ level: config.log.level, pretty: config.log.pretty ?? true });
const log = createLogger({ service: "trader", mode: config.trading.mode });

// Structured decision events → dashboard Activity feed (GET /activity SSE)
const { ActivityBus } = await import("./activity-bus.js");
const activity = new ActivityBus();

// Boot guards: chains without a real execution path refuse unsafe modes.
// TON: PAPER + SHADOW (STON.fi quotes verified); LIVE refused — no wallet/signing.
// EVM: PAPER only — no quote aggregator (SHADOW) or signing (LIVE) wired yet.
for (const chain of config.trading.chains) {
  if (chain === "ton" && config.trading.mode === "LIVE") {
    throw new Error(`TRADING_CHAIN=ton does not support LIVE mode yet (got ${config.trading.mode})`);
  }
  if (isEvmChain(chain) && config.trading.mode !== "PAPER") {
    throw new Error(
      `TRADING_CHAIN=${chain} supports PAPER mode only (got ${config.trading.mode}) — ` +
      `wire an EVM quote provider for SHADOW, viem signing for LIVE`,
    );
  }
}

log.info("Autonomous trader starting", {
  mode: config.trading.mode,
  chains: config.trading.chains,
});

// ─── Database + journal (graceful fallback to null journal) ──────────────────
let db: Database | null = null;
let journal: JournalRepository | ReturnType<typeof createNullJournal>;

try {
  db = new Database(config.database.url, config.database.poolMin, config.database.poolMax);
  await db.connect();
  // Self-migrate: schema always current at boot (also covers fresh containers)
  const { runMigrations } = await import("@autonomous-trader/core");
  await runMigrations(db, join(process.cwd(), "infra/migrations"));
  journal = new JournalRepository(db);
} catch (err) {
  db = null;
  log.warn("Database unavailable — running without persistence", {
    error: (err as Error).message || String(err),
    hint: "Run infra/docker/docker-compose.yml + npm run db:migrate for full journaling",
  });
  journal = createNullJournal();
}

// ─── Emergency controller ─────────────────────────────────────────────────────
const emergency = new EmergencyController(
  db ? new PgEmergencyPersistence(db) : new InMemoryEmergencyPersistence(),
  config.trading.mode,
);
await emergency.initialize();

await journal.recordSystemEvent("STARTUP", "Trader starting", { mode: config.trading.mode });

// ─── Idempotency chain: Redis (when REDIS_URL) → Postgres → memory ───────────
// LIVE refuses to boot without a healthy Redis guard (Phase D gate);
// paper/shadow run fine on Pg/memory alone. Shared by all chains.
let redisClient: import("ioredis").Redis | null = null;
if (process.env["REDIS_URL"]) {
  const { Redis: RedisCtor } = await import("ioredis");
  redisClient = new RedisCtor(process.env["REDIS_URL"], { lazyConnect: false, maxRetriesPerRequest: 1 });
  const client = redisClient;
  client.on("error", (e: Error) => log.warn("Redis error (idempotency falls back to Pg)", { error: e.message }));
}
let redisGuard: RedisIdempotencyGuard | null = null;
if (redisClient) {
  redisGuard = new RedisIdempotencyGuard(redisClient as unknown as ConstructorParameters<typeof RedisIdempotencyGuard>[0]);
  if (await redisGuard.healthy()) {
    log.info("Redis idempotency guard connected");
  } else {
    if (config.trading.mode === "LIVE") {
      throw new Error("LIVE mode requires a healthy Redis (REDIS_URL) — refusing to start");
    }
    log.warn("Redis unreachable — idempotency falls back to Postgres");
    redisGuard = null;
  }
}
const pgOrMemoryGuard = db
  ? new FallbackIdempotencyGuard(new PgIdempotencyGuard(db), new InMemoryIdempotencyGuard())
  : new InMemoryIdempotencyGuard();
const idempotencyGuard = redisGuard
  ? new FallbackIdempotencyGuard(redisGuard, pgOrMemoryGuard)
  : pgOrMemoryGuard;

// Wallet: required for LIVE (Solana-only path), optional otherwise
const { loadWalletFromEnv } = await import("@autonomous-trader/execution");
const wallet = loadWalletFromEnv();
if (wallet) {
  log.info("Trading wallet loaded", { publicKey: wallet.publicKey });
  if (config.trading.walletPublicKey && config.trading.walletPublicKey !== wallet.publicKey) {
    throw new Error("WALLET_PUBLIC_KEY env does not match WALLET_PRIVATE_KEY-derived key");
  }
}
if (config.trading.mode === "LIVE" && !wallet) {
  throw new Error("LIVE mode requires WALLET_PRIVATE_KEY — refusing to start");
}

// ─── Base capital: split evenly across active chains ─────────────────────────
// Legacy key holds the single-chain-era total; per-chain keys hold each book.
// A single-chain setup keeps exact legacy numbers (total/1). A first
// multi-chain boot splits the stored total evenly.
const legacyTotalUsd = parseFloat(process.env["STARTING_CAPITAL_USD"] ?? "10000");
if (db) {
  try {
    const stored = await journal.getSystemState("base_capital_usd");
    if (stored === null) await journal.setSystemState("base_capital_usd", String(legacyTotalUsd));
  } catch { /* null journal path */ }
}

/** stTON (bemo) — DexScreener-indexed TON price proxy, live-verified 2026-09-16.
 *  EVM chains use their wrapped native (WBNB/WETH/WPOL) the same way. */
const TON_REF = "EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k";
function flagshipAddress(chain: Chain): string {
  if (chain === "solana") return ""; // solana samples via Jupiter quote below
  if (chain === "ton") return TON_REF;
  if (isEvmChain(chain)) return EVM_CHAINS[chain].wrappedNative;
  return "";
}

// ─── Per-chain runtime ────────────────────────────────────────────────────────
interface ChainRuntime {
  chain: Chain;
  providers: ProviderRegistry;
  scanner: Scanner;
  router: ExecutionRouter;
  positions: PositionManager;
  shadow: import("./shadow-tracker.js").ShadowTracker;
  fillCalibrator: import("./fill-calibrator.js").FillCalibrator | null;
  portfolio: PortfolioSnapshot;
  baseCapitalUsd: number;
  sampler: SolPriceSampler;
  regime: RegimeResult;
  flagship: string;
}

const scannerConfig: ScannerConfig = {
  market: config.market,
  freshness: config.dataFreshness,
  observationWindowMs: config.market.observationWindowMs,
  refreshIntervalMs: 15_000,
  maxWatchlistSize: 50,
  maxCandidateAgeMs: 4 * 60 * 60 * 1000,
};

async function buildChainRuntime(chain: Chain): Promise<ChainRuntime> {
  const registry = createProviderRegistry(config.providers, chain);
  const { discovery, marketData: market, liquidity, security, holders, quote, execution, monitoring } = registry;
  await Promise.all([
    discovery.initialize(), market.initialize(), liquidity.initialize(),
    security.initialize(), holders.initialize(), quote.initialize(),
    execution.initialize(), monitoring.initialize(), registry.chain.initialize(),
  ]);

  const scanner = new Scanner(
    scannerConfig,
    { discovery, market, liquidity, security, holders },
    log.child({ component: "scanner", chain }),
    db ? (journal as JournalRepository) : null, // snapshot persistence → backtester dataset
  );

  // Base (quote) asset for shadow fills: WSOL on Solana, USDT on TON
  const router = createExecutionRouter(config.trading.mode, {
    quote,
    baseMint: chain === "ton"
      ? "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
      : undefined,
    execution, monitoring, chain: registry.chain,
    walletPublicKey: wallet?.publicKey ?? config.trading.walletPublicKey ?? "mock_wallet",
    signTransaction: wallet
      ? (tx) => wallet.signTransaction(tx)
      : async (tx) => tx, // paper/shadow only — LIVE refuses to boot without wallet above
    logger: log.child({ component: "execution", chain }),
    guard: idempotencyGuard,
  });

  // Fill calibration (roadmap C2): real quotes vs paper fills — STON quotes only
  const { FillCalibrator } = await import("./fill-calibrator.js");
  const fillCalibrator = chain === "ton" && quote.name === "stonfi-quote" && db
    ? new FillCalibrator(
        quote,
        "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
        journal as JournalRepository,
        log.child({ component: "fill-calibrator" }),
      )
    : null;

  const { ShadowTracker } = await import("./shadow-tracker.js");
  const shadow = new ShadowTracker(
    market,
    db ? (journal as JournalRepository) : null,
    log.child({ component: "shadow", chain }),
    15,
    chain,
  );

  // ── Equity book: per-chain portfolio + restart recovery ────────────────────
  let portfolio: PortfolioSnapshot = {
    totalValueUsd: 10_000 / config.trading.chains.length,
    availableCapitalUsd: 10_000 / config.trading.chains.length,
    allocatedUsd: 0,
    openPositions: 0,
    dailyPnlUsd: 0,
    weeklyPnlUsd: 0,
    monthlyPnlUsd: 0,
    allTimePnlUsd: 0,
    currentDrawdownPct: 0,
    peakValueUsd: 10_000 / config.trading.chains.length,
    snapshotAt: new Date(),
  };
  let baseCapitalUsd = legacyTotalUsd / config.trading.chains.length;

  if (db) {
    try {
      const stored = await journal.getSystemState(`base_capital_usd:${chain}`);
      if (stored !== null) {
        baseCapitalUsd = parseFloat(stored);
      } else {
        await journal.setSystemState(`base_capital_usd:${chain}`, String(baseCapitalUsd));
      }
    } catch { /* null journal path */ }
  }

  const positions = new PositionManager(
    router,
    log.child({ component: "position", chain }),
  );

  if (db) {
    try {
      const restored = await journal.getOpenPositions(config.trading.mode, chain);
      for (const p of restored) positions.restorePosition(p);

      const snap = await journal.getLatestPortfolioSnapshot(config.trading.mode, chain);
      if (snap) {
        portfolio = { ...snap, snapshotAt: new Date() };
      }
      // Allocated capital is authoritative from live positions, not the snapshot
      portfolio.allocatedUsd = positions.getTotalExposureUsd();
      portfolio.openPositions = positions.getOpenPositions().length;
      portfolio.availableCapitalUsd = portfolio.totalValueUsd - portfolio.allocatedUsd;

      if (restored.length > 0) {
        log.warn("State restored after restart", {
          chain,
          positions: restored.length,
          allocatedUsd: portfolio.allocatedUsd.toFixed(2),
          peakValueUsd: portfolio.peakValueUsd.toFixed(2),
          drawdownPct: portfolio.currentDrawdownPct.toFixed(2),
        });
        alerter.alert("WARNING", "restart-with-positions",
          `[${chain}] Restarted with ${restored.length} open position(s) restored from journal. ` +
          `Allocated $${portfolio.allocatedUsd.toFixed(2)}, drawdown ${portfolio.currentDrawdownPct.toFixed(1)}%.`);
        await journal.recordSystemEvent("STARTUP", "Restored positions after restart", {
          count: restored.length,
          chain,
        });
      }
    } catch (err) {
      log.error("State restore failed — continuing with fresh portfolio (positions in DB unmanaged!)", {
        chain,
        error: (err as Error).message,
      });
    }
  }

  return {
    chain,
    providers: registry,
    scanner,
    router,
    positions,
    shadow,
    fillCalibrator,
    portfolio,
    baseCapitalUsd,
    sampler: new SolPriceSampler(60, 60_000),
    regime: { regime: "UNKNOWN", solTrendPct1h: 0, volatilityPct: 0, confidence: 0, reasons: ["not yet sampled"] },
    flagship: flagshipAddress(chain),
  };
}

// ─── Alerting (spec §65) — critical events only, Telegram transport ──────────
const { Alerter } = await import("./alerter.js");
const alertBotToken = process.env["ALERT_TELEGRAM_BOT_TOKEN"];
const alertChatId = process.env["ALERT_TELEGRAM_CHAT_ID"];
const alertCfg = { dedupeWindowMs: 10 * 60_000 } as import("./alerter.js").AlerterConfig;
if (alertBotToken) alertCfg.botToken = alertBotToken;
if (alertChatId) alertCfg.chatId = alertChatId;
const alerter = new Alerter(alertCfg, log.child({ component: "alerter" }));
if (alerter.isEnabled) log.info("Telegram alerting enabled");
if (!alerter.isEnabled && config.trading.mode === "LIVE") {
  log.warn("LIVE mode without alerting configured (ALERT_TELEGRAM_BOT_TOKEN/CHAT_ID)");
}

const runtimes: ChainRuntime[] = [];
for (const chain of config.trading.chains) {
  runtimes.push(await buildChainRuntime(chain));
}
const usingRealData = Boolean(config.providers.helius.apiKey || config.providers.birdeye.apiKey)
  || config.trading.chains.some((c) => c !== "solana"); // ton/evm stacks are real, keyless
log.info("Chain runtimes created", {
  chains: runtimes.map((r) => r.chain),
  helius: Boolean(config.providers.helius.apiKey),
  birdeye: Boolean(config.providers.birdeye.apiKey),
  goplus: config.providers.goplus.enabled,
  jupiter: config.providers.jupiter.enabled,
  realData: usingRealData,
});

const [maybePrimary] = runtimes;
if (maybePrimary === undefined) throw new Error("TRADING_CHAIN resolved to zero chains — refusing to start");
const primary: ChainRuntime = maybePrimary;
function runtimeFor(chain: Chain): ChainRuntime {
  return runtimes.find((r) => r.chain === chain) ?? primary;
}

/** Aggregate portfolio: sum of per-chain books (display/metrics only). */
function aggregatePortfolio(): PortfolioSnapshot {
  const sum = (f: (p: PortfolioSnapshot) => number): number =>
    runtimes.reduce((s, rt) => s + f(rt.portfolio), 0);
  return {
    totalValueUsd: sum((p) => p.totalValueUsd),
    availableCapitalUsd: sum((p) => p.availableCapitalUsd),
    allocatedUsd: sum((p) => p.allocatedUsd),
    openPositions: runtimes.reduce((s, rt) => s + rt.positions.getOpenPositions().length, 0),
    dailyPnlUsd: sum((p) => p.dailyPnlUsd),
    weeklyPnlUsd: sum((p) => p.weeklyPnlUsd),
    monthlyPnlUsd: sum((p) => p.monthlyPnlUsd),
    allTimePnlUsd: sum((p) => p.allTimePnlUsd),
    currentDrawdownPct: (() => {
      const peak = sum((p) => p.peakValueUsd);
      return peak > 0 ? Math.max(0, ((peak - sum((p) => p.totalValueUsd)) / peak) * 100) : 0;
    })(),
    peakValueUsd: sum((p) => p.peakValueUsd),
    snapshotAt: new Date(),
  };
}

// ─── Strategy + risk + performance (shared across chains) ────────────────────
const strategyEngine = new StrategyEngine(log.child({ component: "strategy" }));
strategyEngine.register(new FreshMomentumStrategy());
strategyEngine.register(new MicroScalpStrategy());

const performanceTracker = new StrategyPerformanceTracker();
const riskEngine = new RiskEngine(
  config.risk,
  () => emergency.isKillSwitchActive(),
  () => emergency.isStopNewEntries(),
);

// ─── AI veto agent (optional, veto-only LLM second opinion) ──────────────────
// OpenAI-compatible /chat/completions endpoint. Can only REJECT candidates;
// APPROVE = no objection, risk engine still gates everything after it.
// Tools = read-only data pulls (fresh snapshots + history) — no trade actions.
// Providers dispatch by chain param to the matching runtime.
const { AiVetoAgent } = await import("./ai-agent.js");
const aiAgent = config.ai.enabled
  ? new AiVetoAgent(
      config.ai,
      log.child({ component: "ai" }),
      {
        getMarketSnapshot: (t, chain) => runtimeFor(chain).providers.marketData.getMarketSnapshot(t, chain),
        getSecurityAnalysis: (t, chain) => runtimeFor(chain).providers.security.analyzeToken(t, chain),
        getLiquiditySnapshot: (t, chain) => runtimeFor(chain).providers.liquidity.getLiquiditySnapshot(t, chain),
        getMarketHistory: async (t, _chain) => {
          if (!db) return [];
          // last 30 snapshots, compact — bounded token spend per tool call
          return ((journal as JournalRepository).getMarketSnapshotHistory(t) as Promise<unknown[]>)
            .then((rows) => rows.slice(-30));
        },
      },
    )
  : null;
if (aiAgent) {
  log.info("AI veto agent enabled", {
    provider: config.ai.provider,
    model: config.ai.model,
    baseUrl: config.ai.baseUrl,
  });
}

// ─── Reporting ────────────────────────────────────────────────────────────────
const { ReportTracker, buildDailyReport, formatReportText } = await import("./report.js");
const reportTracker = new ReportTracker();

function emitDailyReport(): void {
  const report = buildDailyReport(
    reportTracker, aggregatePortfolio(),
    runtimes.flatMap((rt) => rt.positions.getOpenPositions()),
    performanceTracker, config.trading.mode,
  );
  log.info("Daily report", { report: JSON.stringify(report) });
  console.info(formatReportText(report));
  void journal.recordSystemEvent("DAILY_REPORT", formatReportText(report), {
    netPnlUsd: report.netPnlUsd,
    trades: report.trades,
  }).catch(() => undefined);
}

// Daily at 00:01 UTC
function scheduleDailyReport(): void {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1));
  setTimeout(() => {
    emitDailyReport();
    scheduleDailyReport(); // 24h apart — DST-immune via UTC recompute
  }, next.getTime() - now.getTime());
}

// ─── Market regime (spec §48) — per chain ─────────────────────────────────────
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzyXbapC8G4wEGGkZwyTDt1v";

/**
 * Sample the chain's flagship asset price and reclassify regime.
 * Solana: SOL/USD via Jupiter quote (free, no key).
 * TON: stTON priceUsd via DexScreener (tracks TON; no quote provider exists).
 * EVM: wrapped-native priceUsd via DexScreener (tracks the gas coin).
 */
async function updateRegime(rt: ChainRuntime): Promise<void> {
  try {
    if (rt.chain === "solana") {
      const q = await rt.providers.quote.getQuote({
        inputMint: WSOL, outputMint: USDC,
        amount: 1_000_000_000n, // 1 SOL
        slippageBps: 100,
        chain: "solana",
      });
      // outputAmount is 6-dec USDC for 1 SOL → price = raw/1e6
      rt.sampler.add(Number(q.outputAmount) / 1e6);
    } else {
      const snap = await rt.providers.marketData.getMarketSnapshot(rt.flagship, rt.chain);
      rt.sampler.add(snap.priceUsd);
    }
  } catch {
    // price failure — keep last samples; UNKNOWN-ish handling via confidence
  }

  rt.regime = classifyRegime({
    solPrices: rt.sampler.prices(),
    drawdownPct: rt.portfolio.currentDrawdownPct,
    maxDrawdownPct: config.risk.maxDrawdownPct,
    dailyLossUsd: Math.max(0, -rt.portfolio.dailyPnlUsd),
    maxDailyLossUsd: config.risk.maxDailyLossUsd,
    recentWinRate: performanceTracker.getStats("strategy-fresh-momentum").sampleSize >= 30
      ? performanceTracker.getStats("strategy-fresh-momentum").winRate
      : null,
  });
}

// ─── Main decision loop ───────────────────────────────────────────────────────
let killSwitchAlerted = false;
let pnlDayKey = utcDayKey(new Date());
let pnlWeekKey = utcWeekKey(new Date());
let performanceTrades = 0;

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** ISO week key YYYY-Www — resets weekly PnL on Monday 00:00 UTC. */
function utcWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Thu = new Date(jan4);
  week1Thu.setUTCDate(jan4.getUTCDate() - jan4DayNum + 3);
  const week = 1 + Math.round((date.getTime() - week1Thu.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

async function decisionCycle(rt: ChainRuntime): Promise<void> {
  // 0. Refresh market regime (flagship trend/vol + drawdown state)
  await updateRegime(rt);

  // 0.5 Evaluate matured shadow decisions (signal-quality evidence)
  await rt.shadow.evaluateDue();

  // 1. Portfolio: mark-to-market
  const openPositions = rt.positions.getOpenPositions();

  // Mark-to-market: unrealized swings now feed drawdown/loss gates immediately
  const unrealizedTotal = openPositions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  rt.portfolio.totalValueUsd = rt.baseCapitalUsd + rt.portfolio.allTimePnlUsd + unrealizedTotal;
  if (rt.portfolio.totalValueUsd > rt.portfolio.peakValueUsd) {
    rt.portfolio.peakValueUsd = rt.portfolio.totalValueUsd;
  }
  rt.portfolio.currentDrawdownPct = rt.portfolio.peakValueUsd > 0
    ? Math.max(0, ((rt.portfolio.peakValueUsd - rt.portfolio.totalValueUsd) / rt.portfolio.peakValueUsd) * 100)
    : 0;

  rt.portfolio.openPositions = openPositions.length;
  rt.portfolio.allocatedUsd = rt.positions.getTotalExposureUsd();
  rt.portfolio.availableCapitalUsd = rt.portfolio.totalValueUsd - rt.portfolio.allocatedUsd;

  // 2. Monitor exits for open positions
  for (const position of openPositions) {
    try {
      const marketSnap = await rt.providers.marketData.getMarketSnapshot(position.tokenAddress, position.chain);
      const liqSnap    = await rt.providers.liquidity.getLiquiditySnapshot(position.tokenAddress, position.chain);

      const exitSignal = rt.positions.updateAndCheckExit(position.id, {
        market: marketSnap,
        liquidity: liqSnap,
        timestampMs: Date.now(),
      });

      if (exitSignal) {
        log.info("Exit signal triggered", {
          chain: rt.chain,
          positionId: position.id,
          token: position.tokenAddress,
          reason: exitSignal.reason,
          urgency: exitSignal.urgency,
        });
        activity.publish("exit", `exit signal · ${exitSignal.reason} (${exitSignal.urgency})`,
          { token: position.tokenAddress, data: { pnlPct: position.unrealizedPnlPct } });
        if (exitSignal.urgency === "EMERGENCY") {
          alerter.alert("WARNING", `emergency-exit:${position.tokenAddress}`,
            `EMERGENCY EXIT ${position.tokenAddress}: ${exitSignal.reason} ` +
            `(pnl ${position.unrealizedPnlPct.toFixed(1)}%)`);
        }

        const exitIntent: TradeIntent = {
          id: generateTradeIntentId(),
          tokenAddress: position.tokenAddress,
          chain: position.chain,
          side: "SELL",
          mode: config.trading.mode,
          strategyId: position.strategyId,
          strategyVersion: "1.0.0",
          riskVersion: config.risk.version,
          positionSizeUsd: position.sizeUsd,
          maxSlippageBps: config.risk.maxSlippageBps,
          maxPriceImpactBps: config.risk.maxPriceImpactBps,
          reason: exitSignal.reason,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
        };

        const exitResult = await rt.positions.exitPosition(position.id, exitSignal, marketSnap.priceUsd, exitIntent);

        // Record exit in journal
        await journal.recordTradeIntent(exitIntent);
        await journal.recordExecutionResult(exitResult, exitIntent);
        rt.fillCalibrator?.record(exitIntent, exitResult); // C2: real quote vs paper fill
        const closedPosition = rt.positions.getPosition(position.id);
        if (closedPosition) {
          await journal.updatePosition(closedPosition);
          await journal.recordPositionEvent(position.id, "EXIT", marketSnap.priceUsd, exitResult.executedPrice * Number(exitResult.outputAmount) / 1e6 - position.sizeUsd, {
            reason: exitSignal.reason,
            urgency: exitSignal.urgency,
          });
        }

        // Walk token SM to CLOSED and queue cooldown-gated watchlist re-entry
        rt.scanner.markExited(position.tokenAddress, exitSignal.reason);

        // Realize PnL into the PnL ledgers. totalValue/drawdown are NOT touched
        // here — the mark-to-market formula in step 1 owns them (unrealized was
        // already reflected; realized just moves it into allTimePnlUsd).
        const realizedPnl = position.unrealizedPnlUsd;
        rt.portfolio.dailyPnlUsd += realizedPnl;
        rt.portfolio.weeklyPnlUsd += realizedPnl;
        rt.portfolio.monthlyPnlUsd += realizedPnl;
        rt.portfolio.allTimePnlUsd += realizedPnl;

        // Feed the performance tracker (drives sizing multipliers with shrinkage)
        performanceTracker.record({
          strategyId: position.strategyId,
          pnlUsd: realizedPnl,
          feesUsd: exitResult.feeUsd,
          slippageUsd: position.sizeUsd * (exitResult.actualSlippageBps / 10_000),
          durationMs: Date.now() - position.openedAt.getTime(),
          timestamp: new Date(),
        });
        reportTracker.recordClose({
          strategyId: position.strategyId,
          pnlUsd: realizedPnl,
          feesUsd: exitResult.feeUsd,
          closedAt: new Date(),
        });

        // Daily loss limit → stop new entries. Deliberately global: one chain
        // blowing its book halts entries everywhere (fail-safe over throughput).
        if (rt.portfolio.dailyPnlUsd <= -config.risk.maxDailyLossUsd && !emergency.isStopNewEntries()) {
          await emergency.setStopNewEntries(true);
          await journal.recordSystemEvent("DAILY_LOSS_LIMIT_HIT",
            `[${rt.chain}] Daily loss ${rt.portfolio.dailyPnlUsd.toFixed(2)} reached limit ${-config.risk.maxDailyLossUsd}`);
          log.error("DAILY LOSS LIMIT REACHED — new entries stopped", {
            chain: rt.chain,
            dailyPnl: rt.portfolio.dailyPnlUsd,
          });
          alerter.alert("CRITICAL", "daily-loss-limit",
            `[${rt.chain}] Daily loss limit hit: ${rt.portfolio.dailyPnlUsd.toFixed(2)} USD. New entries stopped automatically.`);
        }

        log.info("Position closed", {
          chain: rt.chain,
          positionId: position.id,
          realizedPnlUsd: realizedPnl.toFixed(2),
          pnlPct: position.unrealizedPnlPct.toFixed(2),
          totalValue: rt.portfolio.totalValueUsd.toFixed(2),
        });
        activity.publish("exit",
          `closed · ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)} (${position.unrealizedPnlPct.toFixed(1)}%)`,
          { token: position.tokenAddress, data: { realizedPnlUsd: realizedPnl, reason: exitSignal.reason } });
      }
    } catch (err) {
      log.error("Position monitoring error", { chain: rt.chain, positionId: position.id, error: (err as Error).message });
      alerter.alert("CRITICAL", `position-monitor-error:${position.id}`,
        `[${rt.chain}] Position monitoring FAILED for ${position.tokenAddress}: ${(err as Error).message}. ` +
        `Position is unmanaged until this resolves — investigate immediately.`);
    }
  }

  // 3. Evaluate new trade candidates (if not stopped)
  if (emergency.isStopNewEntries()) return;

  const candidates = rt.scanner.getTradeCandidates();
  log.debug("Evaluating trade candidates", { chain: rt.chain, count: candidates.length });
  activity.publish("cycle",
    `tick [${rt.chain}] · ${candidates.length} candidate(s) · ${openPositions.length} open · ${rt.regime.regime}`,
    { data: { chain: rt.chain, candidates: candidates.length, open: openPositions.length, regime: rt.regime.regime } });

  for (const candidate of candidates.slice(0, 5)) { // cap per cycle
    try {
      // Never re-enter a token we already hold — re-entry goes through the
      // scanner's CLOSED→WATCHLIST cooldown path after the position exits.
      // Without this, a restart re-seed re-promotes held tokens and pyramids.
      if (rt.positions.getTokenExposureUsd(candidate.tokenAddress) > 0) continue;

      const strategyCtx: StrategyContext = {
        candidate,
        marketRegime: rt.regime.regime,
        portfolioValueUsd: rt.portfolio.totalValueUsd,
        availableCapitalUsd: rt.portfolio.availableCapitalUsd,
        openPositionCount: rt.portfolio.openPositions,
        existingTokenExposureUsd: rt.positions.getTokenExposureUsd(candidate.tokenAddress),
        freshnessConfig: config.dataFreshness,
        marketConfig: config.market,
        timestamp: new Date(),
      };

      const ensembleResult = strategyEngine.evaluate(strategyCtx);
      if (!ensembleResult.anyEnter || !ensembleResult.bestDecision) {
        for (const d of ensembleResult.decisions) {
          const reason = (d.risks.length ? d.risks : d.reasons).join("; ");
          log.info("Strategy did not enter candidate", {
            chain: rt.chain,
            token: candidate.tokenAddress,
            strategy: d.strategyId,
            decision: d.decision,
            reason,
          });
          activity.publish("skip", `${d.decision} · ${reason}`,
            { token: candidate.tokenAddress, data: { score: candidate.scores.opportunity } });
        }
        continue;
      }

      const strategyDecision = ensembleResult.bestDecision;
      const stats = performanceTracker.getStats(strategyDecision.strategyId);

      // AI veto — cached per token, UNKNOWN on any failure (never blocks trading)
      if (aiAgent) {
        const aiVerdict = await aiAgent.veto(candidate);
        if (aiVerdict.verdict === "REJECT") {
          log.info("Candidate vetoed by AI agent", {
            chain: rt.chain,
            token: candidate.tokenAddress,
            confidence: aiVerdict.confidence,
            reason: aiVerdict.reason,
          });
          activity.publish("reject", `ai veto · ${aiVerdict.reason}`,
            { token: candidate.tokenAddress });
          continue;
        }
      }

      // Shadow-track every ENTER signal at decision price — signal quality
      // evidence independent of risk approval or execution (spec §43)
      if (candidate.market && candidate.market.priceUsd > 0) {
        await rt.shadow.record({
          tokenAddress: candidate.tokenAddress,
          strategyId: strategyDecision.strategyId,
          decisionPrice: candidate.market.priceUsd,
          confidence: strategyDecision.confidence,
          decidedAt: new Date(),
        });
      }

      // Journal the strategy decision with full feature snapshot for reproducibility
      await journal.recordStrategyDecision(strategyDecision, candidate.features, candidate.chain);

      // Build intent
      const intent: TradeIntent = {
        id: generateTradeIntentId(),
        tokenAddress: candidate.tokenAddress,
        chain: candidate.chain,
        side: "BUY",
        mode: config.trading.mode,
        strategyId: strategyDecision.strategyId,
        strategyVersion: strategyDecision.strategyVersion,
        riskVersion: config.risk.version,
        positionSizeUsd: rt.portfolio.totalValueUsd * (config.risk.baseRiskPct / 100),
        maxSlippageBps: config.risk.maxSlippageBps,
        maxPriceImpactBps: config.risk.maxPriceImpactBps,
        reason: strategyDecision.reasons.join("; "),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      };

      // Risk gate
      const liqSnap = candidate.liquidity ?? await rt.providers.liquidity.getLiquiditySnapshot(candidate.tokenAddress, candidate.chain);
      const secAssess = candidate.security ?? await rt.providers.security.analyzeToken(candidate.tokenAddress, candidate.chain);

      const riskResult = riskEngine.evaluate({
        intent,
        portfolio: rt.portfolio,
        liquidity: liqSnap,
        security: secAssess,
        marketRegime: rt.regime.regime,
        strategyConfidence: strategyDecision.confidence,
        strategyPerformanceMultiplier: stats.performanceMultiplier,
        openPositionCount: rt.portfolio.openPositions,
        dailyLossUsd: Math.max(0, -rt.portfolio.dailyPnlUsd),
        weeklyLossUsd: Math.max(0, -rt.portfolio.weeklyPnlUsd),
        currentDrawdownPct: rt.portfolio.currentDrawdownPct,
        existingTokenExposureUsd: rt.positions.getTokenExposureUsd(candidate.tokenAddress),
        existingStrategyExposureUsd: 0,
      });

      // Journal intent + risk decision BEFORE execution (crash-safe audit trail)
      await journal.recordTradeIntent(intent);
      await journal.recordRiskDecision(riskResult.riskDecision);

      if (riskResult.decision === "REJECTED") {
        log.debug("Trade rejected by risk engine", {
          chain: rt.chain,
          token: candidate.tokenAddress,
          reasons: riskResult.rejectionReasons,
        });
        activity.publish("reject", `risk engine · ${riskResult.rejectionReasons.join("; ")}`,
          { token: candidate.tokenAddress });
        continue;
      }

      // Adjust intent size to risk-approved amount
      intent.positionSizeUsd = riskResult.approvedSizeUsd;
      intent.maxSlippageBps = riskResult.maxSlippageBps;

      // Execute
      const currentPrice = candidate.market?.priceUsd ?? 0.000001;
      const execResult = await rt.router.execute(intent, currentPrice);
      await journal.recordExecutionResult(execResult, intent);
      rt.fillCalibrator?.record(intent, execResult); // C2: real quote vs paper fill

      // Open position
      const position = rt.positions.openPosition(
        execResult,
        intent,
        strategyDecision.suggestedStopLoss ?? currentPrice * 0.90,
        strategyDecision.suggestedTakeProfit1,
        strategyDecision.suggestedTakeProfit2,
        strategyDecision.suggestedTrailingStopPct ?? 15, // scalps trail tighter
      );

      rt.portfolio.allocatedUsd += riskResult.approvedSizeUsd;
      rt.portfolio.availableCapitalUsd -= riskResult.approvedSizeUsd;
      rt.portfolio.openPositions++;

      // Journal the position
      await journal.insertPosition(position);
      await journal.recordPositionEvent(position.id, "ENTRY", position.entryPrice, 0, {
        strategy: strategyDecision.strategyId,
        stopLoss: position.stopLoss,
        takeProfit1: position.takeProfit1 ?? null,
        sizeUsd: position.sizeUsd,
      });

      log.info("Trade entered", {
        chain: rt.chain,
        positionId: position.id,
        token: candidate.tokenAddress,
        strategy: strategyDecision.strategyId,
        sizeUsd: intent.positionSizeUsd,
        mode: config.trading.mode,
      });
      activity.publish("enter",
        `BUY [${rt.chain}] $${intent.positionSizeUsd.toFixed(2)} @ ${position.entryPrice.toPrecision(4)}`,
        {
          token: candidate.tokenAddress,
          data: {
            chain: rt.chain,
            sizeUsd: intent.positionSizeUsd, entryPrice: position.entryPrice,
            stopLoss: position.stopLoss, takeProfit1: position.takeProfit1 ?? null,
            reasons: strategyDecision.reasons,
          },
        });

      // Mark candidate as entered in scanner
      rt.scanner.markEntered(candidate.tokenAddress);
      performanceTrades++;

    } catch (err) {
      log.error("Decision cycle error for candidate", {
        chain: rt.chain,
        token: candidate.tokenAddress,
        error: (err as Error).message,
      });
    }
  }
}

/** Outer cycle: emergency check + PnL window rollover (all books), then chains. */
async function decisionCycleAll(): Promise<void> {
  if (emergency.isKillSwitchActive()) {
    if (!killSwitchAlerted) {
      killSwitchAlerted = true;
      alerter.alert("CRITICAL", "kill-switch",
        "KILL SWITCH ACTIVE — trading halted, positions flagged for close. " +
        "Resume via /emergency/resume?confirm=yes when resolved.");
    }
    log.warn("Kill switch active — skipping decision cycle");
    return;
  }
  killSwitchAlerted = false;

  // Rollover daily/weekly PnL windows (spec §36 — "daily loss" means daily)
  const today = utcDayKey(new Date());
  if (today !== pnlDayKey) {
    pnlDayKey = today;
    for (const rt of runtimes) rt.portfolio.dailyPnlUsd = 0;
    log.info("Daily PnL window rolled", { day: today });
  }
  const thisWeek = utcWeekKey(new Date());
  if (thisWeek !== pnlWeekKey) {
    pnlWeekKey = thisWeek;
    for (const rt of runtimes) rt.portfolio.weeklyPnlUsd = 0;
  }

  for (const rt of runtimes) await decisionCycle(rt);
}

// ─── HTTP monitoring + emergency control ──────────────────────────────────────
const { startHttpServer } = await import("./http-server.js");
const { LogTailer } = await import("./log-tailer.js");
// resolve from module path, not cwd — boots correctly from any directory
const logTailer = new LogTailer(
  // src → trader → apps → repo root
  join(fileURLToPath(new URL(".", import.meta.url)), "../../../logs/trader.log"),
);
logTailer.start();
function loadDashboardHtml(): string | undefined {
  try {
    return readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
  } catch {
    log.warn("dashboard.html not found — GET / disabled");
    return undefined;
  }
}
const monitorToken = process.env["MONITOR_TOKEN"];
const httpServerOpts: Parameters<typeof startHttpServer>[0] = {
  port: config.server.port,
  host: config.server.host,
  emergency,
  logger: log.child({ component: "http" }),
  getStatus: () => ({
    portfolio: aggregatePortfolio(),
    positions: runtimes.flatMap((rt) => rt.positions.getOpenPositions()),
    emergency: {
      killSwitch: emergency.isKillSwitchActive(),
      stopNewEntries: emergency.isStopNewEntries(),
      tradingMode: emergency.getTradingMode(),
      disabledStrategies: [...emergency.getState().disabledStrategies],
    },
    regime: {
      current: primary.regime.regime,
      solTrendPct: Math.round(primary.regime.solTrendPct1h * 100) / 100,
      volatilityPct: Math.round(primary.regime.volatilityPct * 100) / 100,
      confidence: Math.round(primary.regime.confidence * 100) / 100,
      reasons: primary.regime.reasons,
      solSamples: primary.sampler.size,
    },
    chains: runtimes.map((rt) => ({
      chain: rt.chain,
      equityUsd: round(rt.portfolio.totalValueUsd),
      positions: rt.positions.getOpenPositions().length,
      regime: rt.regime.regime,
      watchlist: rt.scanner.getWatchlist().length,
    })),
    watchlist: runtimes.flatMap((rt) =>
      rt.scanner.getWatchlist().slice(0, 20).map((c) => ({
        token: c.tokenAddress,
        score: Math.round(c.scores.opportunity),
        status: c.status,
        chain: rt.chain,
      }))),
    scanner: primary.scanner.getActivity(),
    uptimeMs: 0,
    version: "0.1.0",
  }),
  getMetrics: () => {
    const portfolio = aggregatePortfolio();
    const shadowStats = runtimes.map((rt) => rt.shadow.getStats());
    return {
      portfolio_total_value_usd: round(portfolio.totalValueUsd),
      portfolio_available_usd: round(portfolio.availableCapitalUsd),
      portfolio_allocated_usd: round(portfolio.allocatedUsd),
      portfolio_daily_pnl_usd: round(portfolio.dailyPnlUsd),
      portfolio_drawdown_pct: round(portfolio.currentDrawdownPct),
      open_positions: portfolio.openPositions,
      watchlist_size: runtimes.reduce((s, rt) => s + rt.scanner.getWatchlist().length, 0),
      kill_switch_active: emergency.isKillSwitchActive() ? 1 : 0,
      trades_today: performanceTrades,
      shadow_signals_total: shadowStats.reduce((s, x) => s + x.signals, 0),
      shadow_evaluated_total: shadowStats.reduce((s, x) => s + x.evaluated, 0),
      shadow_avg_return_pct: round(shadowStats.reduce((s, x) => s + x.avgReturnPct, 0) / shadowStats.length),
      shadow_signal_win_rate: round(shadowStats.reduce((s, x) => s + x.winRate, 0) / shadowStats.length * 100),
    };
  },
  getReport: () => buildDailyReport(
    reportTracker, aggregatePortfolio(),
    runtimes.flatMap((rt) => rt.positions.getOpenPositions()),
    performanceTracker, config.trading.mode,
  ),
  getHistory: async () => {
    if (!db) return [];
    const histories = await Promise.all(
      runtimes.map((rt) =>
        (journal as JournalRepository).getPortfolioHistory(config.trading.mode, 1440, rt.chain)), // 4h at 10s ticks
    );
    if (runtimes.length === 1) return histories[0];
    // Multi-chain equity curve: bucket per 10s tick, sum the chain books
    const buckets = new Map<number, number>();
    for (const rows of histories) {
      for (const row of rows) {
        const t = Math.round(new Date(row.at).getTime() / 10_000) * 10_000;
        buckets.set(t, (buckets.get(t) ?? 0) + row.totalValueUsd);
      }
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ at: new Date(t).toISOString(), totalValueUsd: round(v) }));
  },
  getTrades: async () => {
    if (!db) return [];
    const trades = await Promise.all(
      runtimes.map((rt) => (journal as JournalRepository).getClosedTrades(config.trading.mode, rt.chain, 50)),
    );
    return trades.flat().sort((a, b) =>
      new Date(b.closedAt ?? 0).getTime() - new Date(a.closedAt ?? 0).getTime());
  },
  getMarket: () => runtimes.flatMap((rt) => rt.scanner.getMarketFeed()),
  getTokenDetail: async (token: string) => {
    let detail: ReturnType<Scanner["getMarketDetail"]> | null = null;
    for (const rt of runtimes) {
      detail = rt.scanner.getMarketDetail(token);
      if (detail) break;
    }
    if (!detail) return null;
    const history = db
      ? await (journal as JournalRepository).getMarketSnapshotHistory(token)
      : [];
    return { ...detail, history };
  },
  dashboardHtml: loadDashboardHtml(),
  logTailer,
  activityBus: activity,
};
if (monitorToken) httpServerOpts.authToken = monitorToken;
const httpServer = startHttpServer(httpServerOpts);
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Startup ──────────────────────────────────────────────────────────────────
for (const rt of runtimes) await rt.scanner.start();
log.info("Scanner started — beginning decision loop");

// Seed tokens enter the exact same pipeline as discovered ones (TRADER_SEED_TOKENS).
// Seeds apply to every active chain — an address that doesn't exist on a chain
// simply never produces market data and washes out during observation.
if (config.trading.seedTokens.length > 0) {
  for (const rt of runtimes) {
    for (const t of config.trading.seedTokens) rt.scanner.seedToken(t, rt.chain);
  }
  log.info("Seeded tokens into scanner", { tokens: config.trading.seedTokens, chains: config.trading.chains });
}

const CYCLE_INTERVAL_MS = 10_000; // 10s decision cycle
const cycleTimer = setInterval(() => void decisionCycleAll(), CYCLE_INTERVAL_MS);

// Per-tick equity snapshot — every decision cycle, per chain book, like a
// trading platform's equity curve. ~8.6k rows/day/chain; retention job if it
// ever matters.
const snapshotTimer = setInterval(() => {
  for (const rt of runtimes) {
    rt.portfolio.snapshotAt = new Date();
    void journal.recordPortfolioSnapshot(rt.portfolio, config.trading.mode, rt.chain).catch(() => undefined);
  }
}, CYCLE_INTERVAL_MS);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  log.info("Shutting down", { signal });
  clearInterval(cycleTimer);
  clearInterval(snapshotTimer);
  httpServer.close();
  for (const rt of runtimes) {
    await rt.scanner.stop();
    const { discovery, marketData: market, liquidity, security, holders, quote, execution, monitoring } = rt.providers;
    await Promise.all([
      discovery.shutdown(), market.shutdown(), liquidity.shutdown(),
      security.shutdown(), holders.shutdown(), quote.shutdown(),
      execution.shutdown(), monitoring.shutdown(), rt.providers.chain.shutdown(),
    ]);
  }
  const agg = aggregatePortfolio();
  await journal.recordSystemEvent("SHUTDOWN", `Received ${signal}`, {
    totalValueUsd: agg.totalValueUsd,
    dailyPnlUsd: agg.dailyPnlUsd,
  });
  if (db) await db.close();
  redisClient?.disconnect();
  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT",  () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Crash visibility: unhandled rejections/exceptions must land in trader.log,
// not vanish silently (tsx watch exits without a trace otherwise).
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection — trader will exit", { error: String(reason) });
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.error("Unhandled exception — trader will exit", { error: err.message, stack: err.stack });
  process.exit(1);
});

// Run one cycle immediately on startup
await decisionCycleAll();
scheduleDailyReport();
log.info("Initial decision cycle complete — running autonomously");
