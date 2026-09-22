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
import { createCandidate, type TokenCandidate, type CandidateScores } from "./lifecycle/candidate.js";
import {
  computeMarketFeatures,
  computeLiquidityFeatures,
  computeHolderFeatures,
  computeSecurityFeatures,
  mergeFeatures,
} from "./features/feature-engine.js";
import { runFilters } from "./filters/filters.js";
import { scoreCandidate } from "./scoring/scorer.js";

/** WATCHLIST → TRADE_CANDIDATE promotion bar (and demote-under bar). */
export const PROMOTION_SCORE = 55;

export interface ScannerConfig {
  market: MarketConfig;
  freshness: DataFreshnessConfig;
  observationWindowMs: number;
  refreshIntervalMs: number;  // how often to refresh watchlist candidates
  maxWatchlistSize: number;
  maxCandidateAgeMs: number;  // archive candidates older than this
  /** Cooldown before an exited token can re-enter the watchlist (default 30min). */
  reentryCooldownMs?: number;
  /** Cooldown before a never-entered REJECTED token is re-screened (default 5min).
   *  Bursty venues (TON) drop to zero m5 volume in quiet minutes — without a
   *  revive path every candidate drains to REJECTED and the watchlist empties. */
  rejectedReviveCooldownMs?: number;
}

/** Persistence sink for time-series snapshots — the backtester's dataset. */
export interface SnapshotStore {
  recordMarketSnapshot(snap: MarketSnapshot): Promise<void>;
  recordLiquiditySnapshot(snap: LiquiditySnapshot): Promise<void>;
  recordHolderSnapshot(snap: HolderSnapshot): Promise<void>;
  recordSecurityAssessment(a: SecurityAssessment): Promise<void>;
}

/** One row of the live market feed (GET /market) — flattened latest snapshots per token. */
export interface MarketFeedRow {
  token: string;
  chain: TokenDiscoveredEvent["chain"];
  /** Display symbol/name when the liquidity provider exposed them, else null. */
  symbol: string | null;
  name: string | null;
  status: string;
  score: number;
  priceUsd: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  dex: string | null;
  holders: number | null;
  rejection: string | null;
  observedAt: string | null;
}

/** Detail view of one token — the collected fields the feed table doesn't show. */
export interface MarketFeedDetail extends MarketFeedRow {
  firstSeenAt: string;
  lastUpdatedAt: string;
  rejectionReasons: string[];
  scores: CandidateScores;
  market: {
    priceChange1m: number;
    priceChange15m: number;
    volumeUsd15m: number;
    buyCount1m: number;
    sellCount1m: number;
    buyVolumeUsd1m: number;
    sellVolumeUsd1m: number;
    uniqueBuyers1m: number;
    uniqueSellers1m: number;
    tradeCount24h: number;
    uniqueTraders24h: number;
  } | null;
  liquidity: {
    poolAddress: string;
    poolAgeMs: number;
    baseToken: string;
    quoteToken: string;
    slippageBps50: number;
    slippageBps500: number;
    liquidityChange5m: number;
    liquidityChange15m: number;
  } | null;
  holderDist: {
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
  } | null;
  security: {
    status: SecurityAssessment["status"];
    score: number;
    reasons: SecurityAssessment["reasons"];
    checkedAt: string;
  } | null;
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
  private lastScreenAt?: Date;

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

  /** Live pipeline counts + last market scan — feeds the dashboard activity strip. */
  getActivity(): {
    observing: number;
    watchlisted: number;
    tradeCandidates: number;
    rejected: number;
    lastScreenAt: Date | null;
  } {
    let observing = 0, watchlisted = 0, tradeCandidates = 0, rejected = 0;
    for (const c of this.candidates.values()) {
      if (c.status === "OBSERVING" || c.status === "SCREENING" || c.status === "ELIGIBLE") observing++;
      else if (c.status === "WATCHLIST") watchlisted++;
      else if (c.status === "TRADE_CANDIDATE") tradeCandidates++;
      else if (c.status === "REJECTED") rejected++;
    }
    return {
      observing, watchlisted, tradeCandidates, rejected,
      lastScreenAt: this.lastScreenAt ?? null,
    };
  }

  /**
   * Latest market data for every tracked token — feeds GET /market.
   * Nulls mean "no snapshot yet" (candidate still in first data fetch).
   */
  getMarketFeed(): MarketFeedRow[] {
    const rank = (s: string) =>
      s === "TRADE_CANDIDATE" ? 0 : s === "WATCHLIST" ? 1
      : s === "ELIGIBLE" || s === "SCREENING" ? 2 : s === "OBSERVING" ? 3
      : s === "REJECTED" || s === "CLOSED" || s === "EXITING" || s === "ENTERED" ? 4 : 5;
    const rows: MarketFeedRow[] = [];
    for (const c of this.candidates.values()) {
      if (c.status === "ARCHIVED") continue;
      rows.push(this.feedRow(c));
    }
    return rows.sort((a, b) => rank(a.status) - rank(b.status) || b.score - a.score);
  }

  /**
   * Full detail for one tracked token — feeds GET /market/:token.
   * Null when the token is unknown or archived. The scanner-side half only;
   * the caller joins persisted price history from the journal.
   */
  getMarketDetail(tokenAddress: string): MarketFeedDetail | null {
    const c = this.candidates.get(tokenAddress);
    if (!c || c.status === "ARCHIVED") return null;
    return {
      ...this.feedRow(c),
      firstSeenAt: c.firstSeenAt.toISOString(),
      lastUpdatedAt: c.lastUpdatedAt.toISOString(),
      rejectionReasons: [...c.rejectionReasons],
      scores: { ...c.scores },
      market: c.market ? {
        priceChange1m: c.market.priceChange1m,
        priceChange15m: c.market.priceChange15m,
        volumeUsd15m: c.market.volumeUsd15m,
        buyCount1m: c.market.buyCount1m,
        sellCount1m: c.market.sellCount1m,
        buyVolumeUsd1m: c.market.buyVolumeUsd1m,
        sellVolumeUsd1m: c.market.sellVolumeUsd1m,
        uniqueBuyers1m: c.market.uniqueBuyers1m,
        uniqueSellers1m: c.market.uniqueSellers1m,
        tradeCount24h: c.market.tradeCount24h,
        uniqueTraders24h: c.market.uniqueTraders24h,
      } : null,
      liquidity: c.liquidity ? {
        poolAddress: c.liquidity.poolAddress,
        poolAgeMs: c.liquidity.poolAgeMs,
        baseToken: c.liquidity.baseToken,
        quoteToken: c.liquidity.quoteToken,
        slippageBps50: c.liquidity.estimatedSlippageBps50,
        slippageBps500: c.liquidity.estimatedSlippageBps500,
        liquidityChange5m: c.liquidity.liquidityChange5m,
        liquidityChange15m: c.liquidity.liquidityChange15m,
      } : null,
      holderDist: c.holders ? {
        top1Pct: c.holders.top1Pct,
        top5Pct: c.holders.top5Pct,
        top10Pct: c.holders.top10Pct,
        top20Pct: c.holders.top20Pct,
        creatorPct: c.holders.creatorPct,
        insiderPct: c.holders.insiderPct,
        sniperPct: c.holders.sniperPct,
        bundlerPct: c.holders.bundlerPct,
        whalePct: c.holders.whalePct,
        holderGrowth5m: c.holders.holderGrowth5m,
        holderGrowth15m: c.holders.holderGrowth15m,
        holderGrowth1h: c.holders.holderGrowth1h,
      } : null,
      security: c.security ? {
        status: c.security.status,
        score: c.security.score,
        reasons: c.security.reasons,
        checkedAt: c.security.checkedAt.toISOString(),
      } : null,
    };
  }

  private feedRow(c: TokenCandidate): MarketFeedRow {
    return {
      token: c.tokenAddress,
      chain: c.chain,
      symbol: c.liquidity?.baseTokenSymbol ?? null,
      name: c.liquidity?.baseTokenName ?? null,
      status: c.status,
      score: Math.round(c.scores.opportunity),
      priceUsd: c.market?.priceUsd ?? null,
      priceChange5m: c.market?.priceChange5m ?? null,
      priceChange1h: c.market?.priceChange1h ?? null,
      priceChange24h: c.market?.priceChange24h ?? null,
      volume5mUsd: c.market?.volumeUsd5m ?? null,
      volume1hUsd: c.market?.volumeUsd1h ?? null,
      volume24hUsd: c.market?.volumeUsd24h ?? null,
      marketCapUsd: c.market?.marketCapUsd ?? null,
      liquidityUsd: c.liquidity?.liquidityUsd ?? null,
      dex: c.liquidity?.dex ?? null,
      holders: c.holders?.totalHolders ?? null,
      rejection: c.rejectionReasons[0] ?? null,
      observedAt: c.market?.observedAt?.toISOString() ?? null,
    };
  }

  /** Called by execution layer when a position is entered. */
  markEntered(tokenAddress: string): void {
    this.transition(tokenAddress, "ENTERED");
  }

  /**
   * Manually inject a token into the pipeline (TRADER_SEED_TOKENS) — exercises
   * the full loop on known liquid tokens when discovery finds only dust.
   * Same path as a real discovery event.
   */
  seedToken(tokenAddress: string, chain: TokenDiscoveredEvent["chain"]): void {
    void this.handleDiscovery({
      tokenAddress,
      chain,
      firstSeenAt: new Date(),
      source: "seed",
    });
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
    this.lastScreenAt = new Date();
    const rejections = runFilters(candidate, this.config.market);

    if (rejections.length > 0) {
      candidate.rejectionReasons = rejections;
      candidate.rejectedAt = new Date();
      this.transition(candidate.tokenAddress, "REJECTED");
      this.logger.info("Candidate rejected", {
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
    // TRADE_CANDIDATE must refresh too — it is the status the strategy
    // actually evaluates; excluding it froze promoted tokens on stale data
    // (every decision after promotion read minutes-old prices).
    const toRefresh = [...this.candidates.values()].filter(
      (c) => c.status === "WATCHLIST" || c.status === "TRADE_CANDIDATE" || c.status === "OBSERVING",
    );

    for (const candidate of toRefresh) {
      try {
        await this.fetchAllData(candidate);
        candidate.scores = scoreCandidate(candidate);
        candidate.refreshCount++;
        candidate.lastUpdatedAt = new Date();

        // Re-run filters — conditions can deteriorate
        const rejections = runFilters(candidate, this.config.market);
        if (rejections.length > 0 &&
            (candidate.status === "WATCHLIST" || candidate.status === "TRADE_CANDIDATE")) {
          candidate.rejectionReasons = rejections;
          candidate.rejectedAt = new Date();
          this.transition(candidate.tokenAddress, "REJECTED");
          this.logger.info("Watchlist candidate rejected on refresh", {
            token: candidate.tokenAddress,
            reasons: rejections,
          });
          continue;
        }

        // Promote high-scoring candidates to TRADE_CANDIDATE
        // 55: with data-missing dims renormalized out, fresh-pool composites
        // sit in the 50s — 65 starved BSC/BASE to zero promotions ever.
        // Strategy + risk engine still gate every actual entry.
        if (candidate.status === "WATCHLIST" && candidate.scores.opportunity >= PROMOTION_SCORE) {
          this.transition(candidate.tokenAddress, "TRADE_CANDIDATE");
          this.logger.info("Promoted to trade candidate", {
            token: candidate.tokenAddress,
            score: candidate.scores.opportunity.toFixed(1),
          });
        }

        // Demote when the score falls back under the bar — a stale promotion
        // would keep feeding the strategy a deteriorated candidate
        if (candidate.status === "TRADE_CANDIDATE" && candidate.scores.opportunity < PROMOTION_SCORE) {
          this.transition(candidate.tokenAddress, "WATCHLIST");
          this.logger.info("Demoted from trade candidate", {
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

    // Re-screen rejected tokens whose cooldown has elapsed
    this.reviveRejected();
  }

  /**
   * REJECTED → OBSERVING for never-entered tokens past the revive cooldown.
   * Never revives: entered tokens (security exits park at REJECTED by design)
   * or security-code rejections (scams must not be rescanned).
   */
  private reviveRejected(): void {
    const cooldown = this.config.rejectedReviveCooldownMs ?? 5 * 60_000;
    const now = Date.now();
    for (const candidate of this.candidates.values()) {
      if (candidate.status !== "REJECTED") continue;
      if (!candidate.rejectedAt || now - candidate.rejectedAt.getTime() < cooldown) continue;
      if (this.stateMachines.get(candidate.tokenAddress)?.getHistory().some((h) => h.to === "ENTERED")) continue;
      if (candidate.rejectionReasons.some((r) => r.startsWith("security:"))) continue;

      candidate.rejectionReasons = [];
      this.transition(candidate.tokenAddress, "OBSERVING");
      this.logger.debug("Rejected candidate revived for re-screening", {
        token: candidate.tokenAddress,
      });
      void this.runInitialScreening(candidate);
    }
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

    // allSettled swallows failures silently — a dead provider would freeze the
    // candidate on stale snapshots with no trace. Log every rejection.
    const failed = [market, liquidity, security, holders]
      .filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const r of failed) {
      this.logger.warn("Provider fetch failed — keeping last snapshot", {
        token: tokenAddress,
        error: (r.reason as Error)?.message ?? String(r.reason),
      });
    }

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
