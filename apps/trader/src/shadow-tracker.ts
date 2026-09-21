/**
 * Shadow-decision tracker (spec §43, Phase 5 evidence engine).
 *
 * Records every ENTER signal at decision price — independent of whether risk
 * approved it or paper executed it — then evaluates the market N minutes later.
 * This measures SIGNAL quality: would our entries have moved in our favor?
 *
 * DB-backed when journal present; in-memory otherwise (paper dev).
 */
import type { Chain, Logger } from "@autonomous-trader/shared";
import type { JournalRepository } from "@autonomous-trader/core";
import type { MarketDataProvider } from "@autonomous-trader/providers";

export interface ShadowDecision {
  tokenAddress: string;
  strategyId: string;
  decisionPrice: number;
  confidence: number;
  decidedAt: Date;
}

interface TrackedEntry {
  decision: ShadowDecision;
  horizonMinutes: number;
  outcome?: { price: number; returnPct: number };
}

export interface ShadowStats {
  signals: number;
  evaluated: number;
  avgReturnPct: number;
  winRate: number;
}

export class ShadowTracker {
  private entries: TrackedEntry[] = [];
  private stats: ShadowStats = { signals: 0, evaluated: 0, avgReturnPct: 0, winRate: 0 };

  constructor(
    private readonly market: MarketDataProvider,
    private readonly journal: JournalRepository | null,
    private readonly logger: Logger,
    private readonly defaultHorizonMin = 15,
    /** Chain of the tokens being tracked — price fetches must use it. */
    private readonly chain: Chain = "solana",
  ) {}

  async record(decision: ShadowDecision, horizonMinutes = this.defaultHorizonMin): Promise<void> {
    this.entries.push({ decision, horizonMinutes });
    this.stats.signals++;
    if (this.entries.length > 5_000) this.entries.splice(0, 1_000); // bound memory
    await this.journal?.insertShadowDecision({
      tokenAddress: decision.tokenAddress,
      chain: this.chain,
      strategyId: decision.strategyId,
      decisionPrice: decision.decisionPrice,
      confidence: decision.confidence,
      horizonMinutes,
      decidedAt: decision.decidedAt,
    });
  }

  /** Evaluate decisions whose horizon has elapsed. Call each cycle. */
  async evaluateDue(): Promise<void> {
    // DB path: evaluate due rows, then refresh stats from the table — stats
    // survive restarts and /metrics reflects all history, not just this boot.
    if (this.journal) {
      try {
        const due = await this.journal.getDueShadowDecisions(this.defaultHorizonMin, 10, this.chain);
        for (const d of due) {
          const outcome = await this.fetchPrice(d.tokenAddress);
          if (outcome === null) continue;
          const returnPct = ((outcome - d.decisionPrice) / d.decisionPrice) * 100;
          await this.journal.updateShadowOutcome(d.id, outcome, returnPct);
        }
        const s = await this.journal.getShadowStats(this.chain);
        this.stats = {
          signals: s.total,
          evaluated: s.evaluated,
          avgReturnPct: s.avgReturnPct,
          winRate: s.winRate,
        };
      } catch (err) {
        this.logger.warn("Shadow evaluation (db) failed", { error: (err as Error).message });
      }
      return;
    }

    // Memory path (no DB): evaluate in-memory entries and aggregate
    const now = Date.now();
    let sum = 0, wins = 0, n = 0;
    for (const e of this.entries) {
      if (!e.outcome && now - e.decision.decidedAt.getTime() >= e.horizonMinutes * 60_000) {
        const price = await this.fetchPrice(e.decision.tokenAddress);
        if (price !== null) {
          e.outcome = { price, returnPct: ((price - e.decision.decisionPrice) / e.decision.decisionPrice) * 100 };
        }
      }
      if (e.outcome) {
        n++;
        sum += e.outcome.returnPct;
        if (e.outcome.returnPct > 0) wins++;
      }
    }
    if (n > 0) {
      this.stats.evaluated = n;
      this.stats.avgReturnPct = sum / n;
      this.stats.winRate = wins / n;
    }
  }

  private async fetchPrice(tokenAddress: string): Promise<number | null> {
    try {
      const snap = await this.market.getMarketSnapshot(tokenAddress, this.chain);
      return snap.priceUsd > 0 ? snap.priceUsd : null;
    } catch {
      return null;
    }
  }

  getStats(): ShadowStats {
    return { ...this.stats };
  }
}
