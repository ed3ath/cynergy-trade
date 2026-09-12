/**
 * Scanner pipeline — orchestrates discovery → observation → screening → watchlist.
 * Runs as a continuous loop. Thread-safe via in-process candidate registry.
 */
import type {
  MarketConfig,
  DataFreshnessConfig,
  TokenDiscoveredEvent,
  Logger,
  MarketSnapshot,
  LiquiditySnapshot,
  HolderSnapshot,
  SecurityAssessment,
} from "@autonomous-trader/shared";
import type {
  TokenDiscoveryProvider,
  MarketDataProvider,
  LiquidityProvider,
  TokenSecurityProvider,
  HolderAnalyticsProvider,
} from "@autonomous-trader/providers";
import { TokenStateMachine } from "@autonomous-trader/core";
import { createCandidate, type TokenCandidate } from "./lifecycle/candidate.js";
import {
  computeMarketFeatures,
  computeLiquidityFeatures,
  computeHolderFeatures,
  computeSecurityFeatures,
  mergeFeatures,
} from "./features/feature-engine.js";
import { runFilters } from "./filters/filters.js";
import { scoreCandidate } from "./scoring/scorer.js";

export interface ScannerConfig {
  market: MarketConfig;
  freshness: DataFreshnessConfig;
  observationWindowMs: number;
  refreshIntervalMs: number;  // how often to refresh watchlist candidates
  maxWatchlistSize: number;
  maxCandidateAgeMs: number;  // archive candidates older than this
  /** Cooldown before an exited token can re-enter the watchlist (default 30min). */
  reentryCooldownMs?: number;
}

/** Persistence sink for time-series snapshots — the backtester's dataset. */
export interface SnapshotStore {
  recordMarketSnapshot(snap: MarketSnapshot): Promise<void>;
  recordLiquiditySnapshot(snap: LiquiditySnapshot): Promise<void>;
  recordHolderSnapshot(snap: HolderSnapshot): Promise<void>;
  recordSecurityAssessment(a: SecurityAssessment): Promise<void>;
}

export class Scanner {
  // tokenAddress → candidate
  private readonly candidates = new Map<string, TokenCandidate>();
  private readonly stateMachines = new Map<string, TokenStateMachine>();

  private running = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private unsubscribeDiscovery?: () => void;
  private lastPersistedAt = new Map<string, number>(); // token → epoch ms
  private readonly reentryQueue = new Map<string, number>(); // token → eligible-at epoch ms

  constructor(
    private readonly config: ScannerConfig,
    private readonly providers: {
      discovery: TokenDiscoveryProvider;
      market: MarketDataProvider;
      liquidity: LiquidityProvider;
      security: TokenSecurityProvider;
      holders: HolderAnalyticsProvider;
    },
    private readonly logger: Logger,
    /** When set, snapshots are persisted (throttled) — required for backtesting data. */
    private readonly snapshotStore: SnapshotStore | null = null,
    /** Minimum ms between persisted snapshot batches per token. */
    private readonly persistThrottleMs = 60_000,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info("Scanner starting");

    // Subscribe to live discovery stream
    this.unsubscribeDiscovery = this.providers.discovery.subscribe((event) => {
      void this.handleDiscovery(event);
    });

    // Periodic refresh of OBSERVING / WATCHLIST candidates
    this.refreshTimer = setInterval(
      () => void this.refreshCandidates(),
      this.config.refreshIntervalMs,
    );

    this.logger.info("Scanner started");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsubscribeDiscovery?.();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.logger.info("Scanner stopped");
  }

  /** All candidates currently on the watchlist, sorted by opportunity score desc. */
  getWatchlist(): TokenCandidate[] {
    return [...this.candidates.values()]
      .filter((c) => c.status === "WATCHLIST" || c.status === "TRADE_CANDIDATE")
      .sort((a, b) => b.scores.opportunity - a.scores.opportunity);
  }

  /** Top-ranked candidates eligible for strategy evaluation. */
  getTradeCandidates(): TokenCandidate[] {
    return this.getWatchlist().filter((c) => c.status === "TRADE_CANDIDATE");
  }

  getCandidate(tokenAddress: string): TokenCandidate | undefined {
    return this.candidates.get(tokenAddress);
  }

  /** Called by execution layer when a position is entered. */
  markEntered(tokenAddress: string): void {
    this.transition(tokenAddress, "ENTERED");
  }

  /**
   * Called when a position closes — walks the token SM to CLOSED and queues
   * it for watchlist re-entry after a cooldown. Security-deterioration exits
   * park the token at REJECTED (never re-entered).
   */
  markExited(tokenAddress: string, reason: string): void {
    if (reason.startsWith("Security")) {
      this.transition(tokenAddress, "REJECTED"); // ENTERED → REJECTED (terminal)
      return;
    }
    // Nothing else advances the token SM past ENTERED, so walk the trade tail here.
    this.transition(tokenAddress, "EXITING");
    this.transition(tokenAddress, "CLOSED");
    this.reentryQueue.set(
      tokenAddress,
      Date.now() + (this.config.reentryCooldownMs ?? 30 * 60_000),
    );
  }

  // ─── Internal pipeline ──────────────────────────────────────────────────────

  private async handleDiscovery(event: TokenDiscoveredEvent): Promise<void> {
    if (this.candidates.has(event.tokenAddress)) return; // already known

    this.logger.debug("Token discovered", {
      token: event.tokenAddress,
      source: event.source,
    });

    const candidate = createCandidate(
      event.tokenAddress,
      event.chain,
      event.source,
      event.pool,
    );
    const sm = new TokenStateMachine("DISCOVERED");
    this.candidates.set(event.tokenAddress, candidate);
    this.stateMachines.set(event.tokenAddress, sm);

    // Begin observation window
    this.transition(event.tokenAddress, "OBSERVING");
    candidate.observationStartedAt = new Date();
    candidate.observationEndsAt = new Date(Date.now() + this.config.observationWindowMs);

    // Do a quick initial data fetch (non-blocking)
    void this.runInitialScreening(candidate);
  }

  private async runInitialScreening(candidate: TokenCandidate): Promise<void> {
    try {
      await this.fetchAllData(candidate);
      this.transition(candidate.tokenAddress, "SCREENING");
      await this.screen(candidate);
    } catch (err) {
      this.logger.warn("Initial screening failed", {
        token: candidate.tokenAddress,
        error: (err as Error).message,
      });
    }
  }

  private async screen(candidate: TokenCandidate): Promise<void> {
    const rejections = runFilters(candidate, this.config.market);

    if (rejections.length > 0) {
      candidate.rejectionReasons = rejections;
      this.transition(candidate.tokenAddress, "REJECTED");
      this.logger.debug("Candidate rejected", {
        token: candidate.tokenAddress,
        reasons: rejections,
      });
      return;
    }

    // Passes hard gates — compute scores
    candidate.scores = scoreCandidate(candidate);
    this.transition(candidate.tokenAddress, "ELIGIBLE");

    // Add to watchlist
    if (this.getWatchlist().length < this.config.maxWatchlistSize) {
      this.transition(candidate.tokenAddress, "WATCHLIST");
      this.logger.info("Candidate watchlisted", {
        token: candidate.tokenAddress,
        score: candidate.scores.opportunity.toFixed(1),
      });
    }
  }

  private async refreshCandidates(): Promise<void> {
    const toRefresh = [...this.candidates.values()].filter(
      (c) => c.status === "WATCHLIST" || c.status === "OBSERVING",
    );

    for (const candidate of toRefresh) {
      try {
        await this.fetchAllData(candidate);
        candidate.scores = scoreCandidate(candidate);
        candidate.refreshCount++;
        candidate.lastUpdatedAt = new Date();

        // Re-run filters — conditions can deteriorate
        const rejections = runFilters(candidate, this.config.market);
        if (rejections.length > 0 && candidate.status === "WATCHLIST") {
          candidate.rejectionReasons = rejections;
          this.transition(candidate.tokenAddress, "REJECTED");
          this.logger.info("Watchlist candidate rejected on refresh", {
            token: candidate.tokenAddress,
            reasons: rejections,
          });
          continue;
        }

        // Promote high-scoring candidates to TRADE_CANDIDATE
        if (candidate.status === "WATCHLIST" && candidate.scores.opportunity >= 65) {
          this.transition(candidate.tokenAddress, "TRADE_CANDIDATE");
          this.logger.info("Promoted to trade candidate", {
            token: candidate.tokenAddress,
            score: candidate.scores.opportunity.toFixed(1),
          });
        }
      } catch (err) {
        this.logger.warn("Failed to refresh candidate", {
          token: candidate.tokenAddress,
          error: (err as Error).message,
        });
      }
    }

    // Archive stale candidates
    this.archiveStale();

    // Re-queue exited tokens whose cooldown has elapsed
    this.drainReentryQueue();
  }

  /** CLOSED → WATCHLIST for exited tokens past cooldown; re-filters/scores on next refresh. */
  private drainReentryQueue(): void {
    const now = Date.now();
    for (const [addr, eligibleAt] of this.reentryQueue) {
      if (now < eligibleAt) continue;
      if (this.getWatchlist().length >= this.config.maxWatchlistSize) break; // full — retry next tick
      this.reentryQueue.delete(addr);
      const was = this.candidates.get(addr)?.status;
      this.transition(addr, "WATCHLIST"); // no-ops unless CLOSED
      if (this.candidates.get(addr)?.status === "WATCHLIST" && was === "CLOSED") {
        this.logger.info("Exited token re-entered watchlist", { token: addr });
      }
    }
  }

  private async fetchAllData(candidate: TokenCandidate): Promise<void> {
    const { tokenAddress, chain } = candidate;

    const [market, liquidity, security, holders] = await Promise.allSettled([
      this.providers.market.getMarketSnapshot(tokenAddress, chain),
      this.providers.liquidity.getLiquiditySnapshot(tokenAddress, chain),
      this.providers.security.analyzeToken(tokenAddress, chain),
      this.providers.holders.getHolderSnapshot(tokenAddress, chain),
    ]);

    if (market.status === "fulfilled")    candidate.market    = market.value;
    if (liquidity.status === "fulfilled") candidate.liquidity = liquidity.value;
    if (security.status === "fulfilled")  candidate.security  = security.value;
    if (holders.status === "fulfilled")   candidate.holders   = holders.value;

    this.persistSnapshots(candidate);

    // Merge all features
    const featureSets = [
      candidate.market    ? computeMarketFeatures(candidate.market)       : {},
      candidate.liquidity ? computeLiquidityFeatures(candidate.liquidity) : {},
      candidate.security  ? computeSecurityFeatures(candidate.security)   : {},
      candidate.holders   ? computeHolderFeatures(candidate.holders)      : {},
    ];
    candidate.features = mergeFeatures(candidate.features, ...featureSets);
  }

  /** Persist fetched snapshots (throttled per token) — fire-and-forget, never blocks trading. */
  private persistSnapshots(candidate: TokenCandidate): void {
    if (!this.snapshotStore) return;
    const last = this.lastPersistedAt.get(candidate.tokenAddress) ?? 0;
    if (Date.now() - last < this.persistThrottleMs) return;
    this.lastPersistedAt.set(candidate.tokenAddress, Date.now());

    const store = this.snapshotStore;
    // fire-and-forget with individual error swallowing — persistence must never
    // break the pipeline; a lost row costs one sample, an exception costs the cycle
    if (candidate.market)    void store.recordMarketSnapshot(candidate.market).catch(() => undefined);
    if (candidate.liquidity) void store.recordLiquiditySnapshot(candidate.liquidity).catch(() => undefined);
    if (candidate.holders)   void store.recordHolderSnapshot(candidate.holders).catch(() => undefined);
    if (candidate.security)  void store.recordSecurityAssessment(candidate.security).catch(() => undefined);
  }

  private archiveStale(): void {
    const cutoff = Date.now() - this.config.maxCandidateAgeMs;
    for (const [addr, candidate] of this.candidates) {
      if (
        candidate.firstSeenAt.getTime() < cutoff &&
        !["OPEN", "EXITING", "ENTERED"].includes(candidate.status)
      ) {
        const sm = this.stateMachines.get(addr);
        if (sm?.canTransition("ARCHIVED")) {
          sm.transition("ARCHIVED");
          candidate.status = "ARCHIVED";
        }
      }
    }
  }

  private transition(tokenAddress: string, to: TokenCandidate["status"]): void {
    const sm = this.stateMachines.get(tokenAddress);
    const candidate = this.candidates.get(tokenAddress);
    if (!sm || !candidate) return;
    if (sm.canTransition(to)) {
      sm.transition(to);
      candidate.status = to;
      candidate.lastUpdatedAt = new Date();
    }
  }
}
