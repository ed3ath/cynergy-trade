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
import { readFileSync } from "node:fs";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const config = loadConfig();
configureLogger({ level: config.log.level, pretty: config.log.pretty ?? true });
const log = createLogger({ service: "trader", mode: config.trading.mode });

// TON support is paper-only: no verified TON quote/execution/signing path exists yet
if (config.trading.chain === "ton" && config.trading.mode !== "PAPER") {
  throw new Error(`TRADING_CHAIN=ton supports PAPER mode only (got ${config.trading.mode})`);
}

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

// ─── Providers — real adapters when API keys set, mocks otherwise ───────────
const registry = createProviderRegistry(config.providers, config.trading.chain);
const { discovery, marketData: market, liquidity, security, holders, quote, execution, monitoring, chain } = registry;

const usingRealData = Boolean(config.providers.helius.apiKey || config.providers.birdeye.apiKey)
  || config.trading.chain === "ton"; // tonapi/geckoterminal/dexscreener are real, no keys needed
log.info("Provider registry created", {
  chain: config.trading.chain,
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

const scanner = new Scanner(
  scannerConfig,
  { discovery, market, liquidity, security, holders },
  log.child({ component: "scanner" }),
  db ? (journal as JournalRepository) : null, // snapshot persistence → backtester dataset
);

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

// ─── Shadow-decision tracking (signal quality, spec §43) ────────────────────
const { ShadowTracker } = await import("./shadow-tracker.js");
const shadowTracker = new ShadowTracker(
  market,
  db ? (journal as JournalRepository) : null,
  log.child({ component: "shadow" }),
  15,
  config.trading.chain,
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

// ─── Portfolio state ──────────────────────────────────────────────────────────
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

// Base capital (deposits excluded): mark-to-market formula is
//   totalValue = baseCapital + allTimeRealizedPnl + Σ unrealizedPnl
// Persisted so the formula survives restarts without drift.
let baseCapitalUsd = parseFloat(process.env["STARTING_CAPITAL_USD"] ?? "10000");

// Restart recovery: restore open positions + portfolio baseline from journal.
// Without this, a restart orphans open positions with no exit engine watching.
if (db) {
  try {
    // Base capital: persisted once, exact across restarts
    const storedBase = await journal.getSystemState("base_capital_usd");
    if (storedBase !== null) {
      baseCapitalUsd = parseFloat(storedBase);
    } else {
      await journal.setSystemState("base_capital_usd", String(baseCapitalUsd));
    }

    const restored = await journal.getOpenPositions(config.trading.mode, config.trading.chain);
    for (const p of restored) positionManager.restorePosition(p);

    const snap = await journal.getLatestPortfolioSnapshot(config.trading.mode, config.trading.chain);
    if (snap) {
      portfolio = { ...snap, snapshotAt: new Date() };
    }
    // Allocated capital is authoritative from live positions, not the snapshot
    portfolio.allocatedUsd = positionManager.getTotalExposureUsd();
    portfolio.openPositions = positionManager.getOpenPositions().length;
    portfolio.availableCapitalUsd = portfolio.totalValueUsd - portfolio.allocatedUsd;

    if (restored.length > 0) {
      log.warn("State restored after restart", {
        positions: restored.length,
        allocatedUsd: portfolio.allocatedUsd.toFixed(2),
        peakValueUsd: portfolio.peakValueUsd.toFixed(2),
        drawdownPct: portfolio.currentDrawdownPct.toFixed(2),
      });
      alerter.alert("WARNING", "restart-with-positions",
        `Restarted with ${restored.length} open position(s) restored from journal. ` +
        `Allocated $${portfolio.allocatedUsd.toFixed(2)}, drawdown ${portfolio.currentDrawdownPct.toFixed(1)}%.`);
      await journal.recordSystemEvent("STARTUP", "Restored positions after restart", {
        count: restored.length,
      });
    }
  } catch (err) {
    log.error("State restore failed — continuing with fresh portfolio (positions in DB unmanaged!)", {
      error: (err as Error).message,
    });
  }
}

// ─── Market regime (spec §48) ─────────────────────────────────────────────────
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** stTON (bemo) — DexScreener-indexed TON price proxy, live-verified 2026-09-16. */
const TON_REF = "EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k";
const solSampler = new SolPriceSampler(60, 60_000);
let currentRegime: RegimeResult = {
  regime: "UNKNOWN", solTrendPct1h: 0, volatilityPct: 0, confidence: 0, reasons: ["not yet sampled"],
};

/**
 * Sample the chain's flagship asset price and reclassify regime.
 * Solana: SOL/USD via Jupiter quote (free, no key).
 * TON: stTON priceUsd via DexScreener (tracks TON; no quote provider exists).
 */
async function updateRegime(): Promise<void> {
  try {
    if (config.trading.chain === "ton") {
      const snap = await market.getMarketSnapshot(TON_REF, "ton");
      solSampler.add(snap.priceUsd);
    } else {
      const q = await quote.getQuote({
        inputMint: WSOL, outputMint: USDC,
        amount: 1_000_000_000n, // 1 SOL
        slippageBps: 100,
        chain: "solana",
      });
      // outputAmount is 6-dec USDC for 1 SOL → price = raw/1e6
      solSampler.add(Number(q.outputAmount) / 1e6);
    }
  } catch {
    // price failure — keep last samples; UNKNOWN-ish handling via confidence
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
let killSwitchAlerted = false;
let pnlDayKey = utcDayKey(new Date());
let pnlWeekKey = utcWeekKey(new Date());

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

async function decisionCycle(): Promise<void> {
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

  // 0. Refresh market regime (SOL trend/vol + drawdown state)
  await updateRegime();

  // 0.5 Evaluate matured shadow decisions (signal-quality evidence)
  await shadowTracker.evaluateDue();

  // 1. Portfolio: PnL window rollover (UTC), then mark-to-market
  const openPositions = positionManager.getOpenPositions();

  // Rollover daily/weekly PnL windows (spec §36 — "daily loss" means daily)
  const today = utcDayKey(new Date());
  if (today !== pnlDayKey) {
    pnlDayKey = today;
    portfolio.dailyPnlUsd = 0;
    log.info("Daily PnL window rolled", { day: today });
  }
  const thisWeek = utcWeekKey(new Date());
  if (thisWeek !== pnlWeekKey) {
    pnlWeekKey = thisWeek;
    portfolio.weeklyPnlUsd = 0;
  }

  // Mark-to-market: unrealized swings now feed drawdown/loss gates immediately
  const unrealizedTotal = openPositions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  portfolio.totalValueUsd = baseCapitalUsd + portfolio.allTimePnlUsd + unrealizedTotal;
  if (portfolio.totalValueUsd > portfolio.peakValueUsd) {
    portfolio.peakValueUsd = portfolio.totalValueUsd;
  }
  portfolio.currentDrawdownPct = portfolio.peakValueUsd > 0
    ? Math.max(0, ((portfolio.peakValueUsd - portfolio.totalValueUsd) / portfolio.peakValueUsd) * 100)
    : 0;

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

        // Walk token SM to CLOSED and queue cooldown-gated watchlist re-entry
        scanner.markExited(position.tokenAddress, exitSignal.reason);

        // Realize PnL into the PnL ledgers. totalValue/drawdown are NOT touched
        // here — the mark-to-market formula in step 1 owns them (unrealized was
        // already reflected; realized just moves it into allTimePnlUsd).
        const realizedPnl = position.unrealizedPnlUsd;
        portfolio.dailyPnlUsd += realizedPnl;
        portfolio.weeklyPnlUsd += realizedPnl;
        portfolio.monthlyPnlUsd += realizedPnl;
        portfolio.allTimePnlUsd += realizedPnl;

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
          alerter.alert("CRITICAL", "daily-loss-limit",
            `Daily loss limit hit: ${portfolio.dailyPnlUsd.toFixed(2)} USD. New entries stopped automatically.`);
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
      alerter.alert("CRITICAL", `position-monitor-error:${position.id}`,
        `Position monitoring FAILED for ${position.tokenAddress}: ${(err as Error).message}. ` +
        `Position is unmanaged until this resolves — investigate immediately.`);
    }
  }

  // 3. Evaluate new trade candidates (if not stopped)
  if (emergency.isStopNewEntries()) return;

  const candidates = scanner.getTradeCandidates();
  log.debug("Evaluating trade candidates", { count: candidates.length });

  for (const candidate of candidates.slice(0, 5)) { // cap per cycle
    try {
      // Never re-enter a token we already hold — re-entry goes through the
      // scanner's CLOSED→WATCHLIST cooldown path after the position exits.
      // Without this, a restart re-seed re-promotes held tokens and pyramids.
      if (positionManager.getTokenExposureUsd(candidate.tokenAddress) > 0) continue;

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
      if (!ensembleResult.anyEnter || !ensembleResult.bestDecision) {
        for (const d of ensembleResult.decisions) {
          log.info("Strategy did not enter candidate", {
            token: candidate.tokenAddress,
            strategy: d.strategyId,
            decision: d.decision,
            reason: (d.risks.length ? d.risks : d.reasons).join("; "),
          });
        }
        continue;
      }

      const strategyDecision = ensembleResult.bestDecision;
      const stats = performanceTracker.getStats(strategyDecision.strategyId);

      // Shadow-track every ENTER signal at decision price — signal quality
      // evidence independent of risk approval or execution (spec §43)
      if (candidate.market && candidate.market.priceUsd > 0) {
        await shadowTracker.record({
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
    scanner: scanner.getActivity(),
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
    shadow_signals_total: shadowTracker.getStats().signals,
    shadow_evaluated_total: shadowTracker.getStats().evaluated,
    shadow_avg_return_pct: round(shadowTracker.getStats().avgReturnPct),
    shadow_signal_win_rate: round(shadowTracker.getStats().winRate * 100),
  }),
  getReport: () => buildDailyReport(
    reportTracker, portfolio, positionManager.getOpenPositions(),
    performanceTracker, config.trading.mode,
  ),
  getHistory: () =>
    db
      ? (journal as JournalRepository).getPortfolioHistory(config.trading.mode, 500, config.trading.chain)
      : Promise.resolve([]),
  getTrades: () =>
    db
      ? (journal as JournalRepository).getClosedTrades(config.trading.mode, config.trading.chain, 50)
      : Promise.resolve([]),
  getMarket: () => scanner.getMarketFeed(),
  getTokenDetail: async (token: string) => {
    const detail = scanner.getMarketDetail(token);
    if (!detail) return null;
    const history = db
      ? await (journal as JournalRepository).getMarketSnapshotHistory(token)
      : [];
    return { ...detail, history };
  },
  dashboardHtml: loadDashboardHtml(),
  logTailer,
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

// Seed tokens enter the exact same pipeline as discovered ones (TRADER_SEED_TOKENS)
if (config.trading.seedTokens.length > 0) {
  for (const t of config.trading.seedTokens) scanner.seedToken(t, config.trading.chain);
  log.info("Seeded tokens into scanner", { tokens: config.trading.seedTokens, chain: config.trading.chain });
}

const CYCLE_INTERVAL_MS = 10_000; // 10s decision cycle
const cycleTimer = setInterval(() => void decisionCycle(), CYCLE_INTERVAL_MS);

// Periodic portfolio snapshot (every 5 min)
const snapshotTimer = setInterval(() => {
  portfolio.snapshotAt = new Date();
  void journal.recordPortfolioSnapshot(portfolio, config.trading.mode, config.trading.chain).catch(() => undefined);
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
