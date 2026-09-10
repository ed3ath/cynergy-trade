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
 */
import {
  loadConfig,
  configureLogger,
  createLogger,
  generateTradeIntentId,
  type AppConfig,
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
import {
  createProviderRegistry,
} from "@autonomous-trader/providers";
import { Scanner, type ScannerConfig } from "@autonomous-trader/scanner";
import { StrategyEngine, FreshMomentumStrategy, type StrategyContext } from "@autonomous-trader/strategy";
import {
  createExecutionRouter,
  PgIdempotencyGuard,
  InMemoryIdempotencyGuard,
  FallbackIdempotencyGuard,
} from "@autonomous-trader/execution";
import { PositionManager } from "@autonomous-trader/position";

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const config = loadConfig();
configureLogger({ level: config.log.level, pretty: config.log.pretty ?? true });
const log = createLogger({ service: "trader", mode: config.trading.mode });

log.info("Autonomous trader starting", {
  mode: config.trading.mode,
  chain: config.trading.chain,
});

// ─── Database + journal (graceful fallback to null journal) ──────────────────
let db: Database | null = null;
let journal: JournalRepository | ReturnType<typeof createNullJournal>;

try {
  db = new Database(config.database.url, config.database.poolMin, config.database.poolMax);
  await db.connect();
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

// ─── Providers — real adapters when API keys set, mocks otherwise ───────────
const registry = createProviderRegistry(config.providers);
const { discovery, marketData: market, liquidity, security, holders, quote, execution, monitoring, chain } = registry;

const usingRealData = Boolean(config.providers.helius.apiKey || config.providers.birdeye.apiKey);
log.info("Provider registry created", {
  helius: Boolean(config.providers.helius.apiKey),
  birdeye: Boolean(config.providers.birdeye.apiKey),
  goplus: config.providers.goplus.enabled,
  jupiter: config.providers.jupiter.enabled,
  realData: usingRealData,
});

await Promise.all([
  discovery.initialize(), market.initialize(), liquidity.initialize(),
  security.initialize(), holders.initialize(), quote.initialize(),
  execution.initialize(), monitoring.initialize(), chain.initialize(),
]);

// ─── Scanner ──────────────────────────────────────────────────────────────────
const scannerConfig: ScannerConfig = {
  market: config.market,
  freshness: config.dataFreshness,
  observationWindowMs: config.market.observationWindowMs,
  refreshIntervalMs: 15_000,
  maxWatchlistSize: 50,
  maxCandidateAgeMs: 4 * 60 * 60 * 1000,
};

const scanner = new Scanner(scannerConfig, { discovery, market, liquidity, security, holders }, log.child({ component: "scanner" }));

// ─── Strategy engine ──────────────────────────────────────────────────────────
const strategyEngine = new StrategyEngine(log.child({ component: "strategy" }));
strategyEngine.register(new FreshMomentumStrategy());

// ─── Risk engine ──────────────────────────────────────────────────────────────
const performanceTracker = new StrategyPerformanceTracker();
const riskEngine = new RiskEngine(
  config.risk,
  () => emergency.isKillSwitchActive(),
  () => emergency.isStopNewEntries(),
);

// ─── Execution router ─────────────────────────────────────────────────────────
// Durable idempotency when DB up; memory-only guard otherwise (paper/dev)
const idempotencyGuard = db
  ? new FallbackIdempotencyGuard(new PgIdempotencyGuard(db), new InMemoryIdempotencyGuard())
  : new InMemoryIdempotencyGuard();

// Wallet: required for LIVE, optional otherwise
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

const executionRouter = createExecutionRouter(config.trading.mode, {
  quote, execution, monitoring, chain,
  walletPublicKey: wallet?.publicKey ?? config.trading.walletPublicKey ?? "mock_wallet",
  signTransaction: wallet
    ? (tx) => wallet.signTransaction(tx)
    : async (tx) => tx, // paper/shadow only — LIVE refuses to boot without wallet above
  logger: log.child({ component: "execution" }),
  guard: idempotencyGuard,
});

// ─── Position manager ─────────────────────────────────────────────────────────
const positionManager = new PositionManager(
  executionRouter,
  log.child({ component: "position" }),
);

// ─── Reporting ────────────────────────────────────────────────────────────────
const { ReportTracker, buildDailyReport, formatReportText } = await import("./report.js");
const reportTracker = new ReportTracker();

function emitDailyReport(): void {
  const report = buildDailyReport(
    reportTracker, portfolio, positionManager.getOpenPositions(),
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

// ─── Portfolio state (in-memory; persisted to DB in Phase 1) ─────────────────
// ponytail: load from DB on startup
let portfolio: PortfolioSnapshot = {
  totalValueUsd: 10_000,
  availableCapitalUsd: 10_000,
  allocatedUsd: 0,
  openPositions: 0,
  dailyPnlUsd: 0,
  weeklyPnlUsd: 0,
  monthlyPnlUsd: 0,
  allTimePnlUsd: 0,
  currentDrawdownPct: 0,
  peakValueUsd: 10_000,
  snapshotAt: new Date(),
};

// ─── Market regime (spec §48) ─────────────────────────────────────────────────
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const solSampler = new SolPriceSampler(60, 60_000);
let currentRegime: RegimeResult = {
  regime: "UNKNOWN", solTrendPct1h: 0, volatilityPct: 0, confidence: 0, reasons: ["not yet sampled"],
};

/** Sample SOL/USD from a Jupiter quote (free, no key) and reclassify regime. */
async function updateRegime(): Promise<void> {
  try {
    const q = await quote.getQuote({
      inputMint: WSOL, outputMint: USDC,
      amount: 1_000_000_000n, // 1 SOL
      slippageBps: 100,
      chain: "solana",
    });
    // outputAmount is 6-dec USDC for 1 SOL → price = raw/1e6
    solSampler.add(Number(q.outputAmount) / 1e6);
  } catch {
    // quote failure — keep last samples; UNKNOWN-ish handling via confidence
  }

  currentRegime = classifyRegime({
    solPrices: solSampler.prices(),
    drawdownPct: portfolio.currentDrawdownPct,
    maxDrawdownPct: config.risk.maxDrawdownPct,
    dailyLossUsd: Math.max(0, -portfolio.dailyPnlUsd),
    maxDailyLossUsd: config.risk.maxDailyLossUsd,
    recentWinRate: performanceTracker.getStats("strategy-fresh-momentum").sampleSize >= 30
      ? performanceTracker.getStats("strategy-fresh-momentum").winRate
      : null,
  });
}

// ─── Main decision loop ───────────────────────────────────────────────────────
async function decisionCycle(): Promise<void> {
  if (emergency.isKillSwitchActive()) {
    log.warn("Kill switch active — skipping decision cycle");
    return;
  }

  // 0. Refresh market regime (SOL trend/vol + drawdown state)
  await updateRegime();

  // 1. Update portfolio from open positions
  const openPositions = positionManager.getOpenPositions();
  portfolio.openPositions = openPositions.length;
  portfolio.allocatedUsd = positionManager.getTotalExposureUsd();
  portfolio.availableCapitalUsd = portfolio.totalValueUsd - portfolio.allocatedUsd;

  // 2. Monitor exits for open positions
  for (const position of openPositions) {
    try {
      const marketSnap = await market.getMarketSnapshot(position.tokenAddress, position.chain);
      const liqSnap    = await liquidity.getLiquiditySnapshot(position.tokenAddress, position.chain);

      const exitSignal = positionManager.updateAndCheckExit(position.id, {
        market: marketSnap,
        liquidity: liqSnap,
        timestampMs: Date.now(),
      });

      if (exitSignal) {
        log.info("Exit signal triggered", {
          positionId: position.id,
          token: position.tokenAddress,
          reason: exitSignal.reason,
          urgency: exitSignal.urgency,
        });

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

        const exitResult = await positionManager.exitPosition(position.id, exitSignal, marketSnap.priceUsd, exitIntent);

        // Record exit in journal
        await journal.recordTradeIntent(exitIntent);
        await journal.recordExecutionResult(exitResult, exitIntent);
        const closedPosition = positionManager.getPosition(position.id);
        if (closedPosition) {
          await journal.updatePosition(closedPosition);
          await journal.recordPositionEvent(position.id, "EXIT", marketSnap.priceUsd, exitResult.executedPrice * Number(exitResult.outputAmount) / 1e6 - position.sizeUsd, {
            reason: exitSignal.reason,
            urgency: exitSignal.urgency,
          });
        }

        // Realize PnL into portfolio
        const realizedPnl = position.unrealizedPnlUsd;
        portfolio.totalValueUsd += realizedPnl;
        portfolio.dailyPnlUsd += realizedPnl;
        portfolio.weeklyPnlUsd += realizedPnl;
        portfolio.monthlyPnlUsd += realizedPnl;
        portfolio.allTimePnlUsd += realizedPnl;

        // Track drawdown from peak
        if (portfolio.totalValueUsd > portfolio.peakValueUsd) {
          portfolio.peakValueUsd = portfolio.totalValueUsd;
        }
        portfolio.currentDrawdownPct = portfolio.peakValueUsd > 0
          ? ((portfolio.peakValueUsd - portfolio.totalValueUsd) / portfolio.peakValueUsd) * 100
          : 0;

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

        // Daily loss limit → stop new entries
        if (portfolio.dailyPnlUsd <= -config.risk.maxDailyLossUsd && !emergency.isStopNewEntries()) {
          await emergency.setStopNewEntries(true);
          await journal.recordSystemEvent("DAILY_LOSS_LIMIT_HIT",
            `Daily loss ${portfolio.dailyPnlUsd.toFixed(2)} reached limit ${-config.risk.maxDailyLossUsd}`);
          log.error("DAILY LOSS LIMIT REACHED — new entries stopped", {
            dailyPnl: portfolio.dailyPnlUsd,
          });
        }

        log.info("Position closed", {
          positionId: position.id,
          realizedPnlUsd: realizedPnl.toFixed(2),
          pnlPct: position.unrealizedPnlPct.toFixed(2),
          totalValue: portfolio.totalValueUsd.toFixed(2),
        });
      }
    } catch (err) {
      log.error("Position monitoring error", { positionId: position.id, error: (err as Error).message });
    }
  }

  // 3. Evaluate new trade candidates (if not stopped)
  if (emergency.isStopNewEntries()) return;

  const candidates = scanner.getTradeCandidates();
  log.debug("Evaluating trade candidates", { count: candidates.length });

  for (const candidate of candidates.slice(0, 5)) { // cap per cycle
    try {
      const strategyCtx: StrategyContext = {
        candidate,
        marketRegime: currentRegime.regime,
        portfolioValueUsd: portfolio.totalValueUsd,
        availableCapitalUsd: portfolio.availableCapitalUsd,
        openPositionCount: portfolio.openPositions,
        existingTokenExposureUsd: positionManager.getTokenExposureUsd(candidate.tokenAddress),
        freshnessConfig: config.dataFreshness,
        marketConfig: config.market,
        timestamp: new Date(),
      };

      const ensembleResult = strategyEngine.evaluate(strategyCtx);
      if (!ensembleResult.anyEnter || !ensembleResult.bestDecision) continue;

      const strategyDecision = ensembleResult.bestDecision;
      const stats = performanceTracker.getStats(strategyDecision.strategyId);

      // Journal the strategy decision with full feature snapshot for reproducibility
      await journal.recordStrategyDecision(strategyDecision, candidate.features);

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
        positionSizeUsd: portfolio.totalValueUsd * (config.risk.baseRiskPct / 100),
        maxSlippageBps: config.risk.maxSlippageBps,
        maxPriceImpactBps: config.risk.maxPriceImpactBps,
        reason: strategyDecision.reasons.join("; "),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      };

      // Risk gate
      const liqSnap = candidate.liquidity ?? await liquidity.getLiquiditySnapshot(candidate.tokenAddress, candidate.chain);
      const secAssess = candidate.security ?? await security.analyzeToken(candidate.tokenAddress, candidate.chain);

      const riskResult = riskEngine.evaluate({
        intent,
        portfolio,
        liquidity: liqSnap,
        security: secAssess,
        marketRegime: currentRegime.regime,
        strategyConfidence: strategyDecision.confidence,
        strategyPerformanceMultiplier: stats.performanceMultiplier,
        openPositionCount: portfolio.openPositions,
        dailyLossUsd: Math.max(0, -portfolio.dailyPnlUsd),
        weeklyLossUsd: Math.max(0, -portfolio.weeklyPnlUsd),
        currentDrawdownPct: portfolio.currentDrawdownPct,
        existingTokenExposureUsd: positionManager.getTokenExposureUsd(candidate.tokenAddress),
        existingStrategyExposureUsd: 0,
      });

      // Journal intent + risk decision BEFORE execution (crash-safe audit trail)
      await journal.recordTradeIntent(intent);
      await journal.recordRiskDecision(riskResult.riskDecision);

      if (riskResult.decision === "REJECTED") {
        log.debug("Trade rejected by risk engine", {
          token: candidate.tokenAddress,
          reasons: riskResult.rejectionReasons,
        });
        continue;
      }

      // Adjust intent size to risk-approved amount
      intent.positionSizeUsd = riskResult.approvedSizeUsd;
      intent.maxSlippageBps = riskResult.maxSlippageBps;

      // Execute
      const currentPrice = candidate.market?.priceUsd ?? 0.000001;
      const execResult = await executionRouter.execute(intent, currentPrice);
      await journal.recordExecutionResult(execResult, intent);

      // Open position
      const position = positionManager.openPosition(
        execResult,
        intent,
        strategyDecision.suggestedStopLoss ?? currentPrice * 0.85,
        strategyDecision.suggestedTakeProfit1,
        strategyDecision.suggestedTakeProfit2,
        15, // 15% trailing stop
      );

      portfolio.allocatedUsd += riskResult.approvedSizeUsd;
      portfolio.availableCapitalUsd -= riskResult.approvedSizeUsd;
      portfolio.openPositions++;

      // Journal the position
      await journal.insertPosition(position);
      await journal.recordPositionEvent(position.id, "ENTRY", position.entryPrice, 0, {
        strategy: strategyDecision.strategyId,
        stopLoss: position.stopLoss,
        takeProfit1: position.takeProfit1 ?? null,
        sizeUsd: position.sizeUsd,
      });

      log.info("Trade entered", {
        positionId: position.id,
        token: candidate.tokenAddress,
        strategy: strategyDecision.strategyId,
        sizeUsd: intent.positionSizeUsd,
        mode: config.trading.mode,
      });

      // Mark candidate as entered in scanner
      scanner.markEntered(candidate.tokenAddress);
      performanceTrades++;

    } catch (err) {
      log.error("Decision cycle error for candidate", {
        token: candidate.tokenAddress,
        error: (err as Error).message,
      });
    }
  }
}

// ─── HTTP monitoring + emergency control ──────────────────────────────────────
const { startHttpServer } = await import("./http-server.js");
const monitorToken = process.env["MONITOR_TOKEN"];
const httpServerOpts: Parameters<typeof startHttpServer>[0] = {
  port: config.server.port,
  host: config.server.host,
  emergency,
  logger: log.child({ component: "http" }),
  getStatus: () => ({
    portfolio,
    positions: positionManager.getOpenPositions(),
    emergency: {
      killSwitch: emergency.isKillSwitchActive(),
      stopNewEntries: emergency.isStopNewEntries(),
      tradingMode: emergency.getTradingMode(),
      disabledStrategies: [...emergency.getState().disabledStrategies],
    },
    regime: {
      current: currentRegime.regime,
      solTrendPct: Math.round(currentRegime.solTrendPct1h * 100) / 100,
      volatilityPct: Math.round(currentRegime.volatilityPct * 100) / 100,
      confidence: Math.round(currentRegime.confidence * 100) / 100,
      reasons: currentRegime.reasons,
      solSamples: solSampler.size,
    },
    watchlist: scanner.getWatchlist().slice(0, 20).map((c) => ({
      token: c.tokenAddress,
      score: Math.round(c.scores.opportunity),
      status: c.status,
    })),
    uptimeMs: 0,
    version: "0.1.0",
  }),
  getMetrics: () => ({
    portfolio_total_value_usd: round(portfolio.totalValueUsd),
    portfolio_available_usd: round(portfolio.availableCapitalUsd),
    portfolio_allocated_usd: round(portfolio.allocatedUsd),
    portfolio_daily_pnl_usd: round(portfolio.dailyPnlUsd),
    portfolio_drawdown_pct: round(portfolio.currentDrawdownPct),
    open_positions: positionManager.getOpenPositions().length,
    watchlist_size: scanner.getWatchlist().length,
    kill_switch_active: emergency.isKillSwitchActive() ? 1 : 0,
    trades_today: performanceTrades,
  }),
  getReport: () => buildDailyReport(
    reportTracker, portfolio, positionManager.getOpenPositions(),
    performanceTracker, config.trading.mode,
  ),
};
if (monitorToken) httpServerOpts.authToken = monitorToken;
const httpServer = startHttpServer(httpServerOpts);
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
let performanceTrades = 0;

// ─── Startup ──────────────────────────────────────────────────────────────────
await scanner.start();
log.info("Scanner started — beginning decision loop");

const CYCLE_INTERVAL_MS = 10_000; // 10s decision cycle
const cycleTimer = setInterval(() => void decisionCycle(), CYCLE_INTERVAL_MS);

// Periodic portfolio snapshot (every 5 min)
const snapshotTimer = setInterval(() => {
  portfolio.snapshotAt = new Date();
  void journal.recordPortfolioSnapshot(portfolio, config.trading.mode).catch(() => undefined);
}, 5 * 60_000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  log.info("Shutting down", { signal });
  clearInterval(cycleTimer);
  clearInterval(snapshotTimer);
  httpServer.close();
  await scanner.stop();
  await Promise.all([
    discovery.shutdown(), market.shutdown(), liquidity.shutdown(),
    security.shutdown(), holders.shutdown(), quote.shutdown(),
    execution.shutdown(), monitoring.shutdown(), chain.shutdown(),
  ]);
  await journal.recordSystemEvent("SHUTDOWN", `Received ${signal}`, {
    totalValueUsd: portfolio.totalValueUsd,
    dailyPnlUsd: portfolio.dailyPnlUsd,
  });
  if (db) await db.close();
  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT",  () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Run one cycle immediately on startup
await decisionCycle();
scheduleDailyReport();
log.info("Initial decision cycle complete — running autonomously");
