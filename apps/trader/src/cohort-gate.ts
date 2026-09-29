/**
 * Cohort gate — auto-blocks strategy×chain cohorts disproven by shadow data
 * (doc §9 rule: shadow expectancy ≤ 0 → do not trade it).
 *
 * Rule: a cohort with ≥100 evaluated 15-min outcomes whose MEDIAN return is
 * ≤ 0 is gated — its ENTERs keep shadow-tracking (measurement never stops)
 * but never reach the risk engine. Medians, not means: one bad-tick outlier
 * (+500000%) corrupts a mean and would launder a losing cohort.
 *
 * Fail-open by design: no journal, failed refresh, or malformed rows all
 * leave entries unblocked (existing behavior), because this gate is an
 * overlay — a broken stats cache must not halt the bot. Unknown and
 * small-sample cohorts are always allowed; only proven losers are blocked.
 * A gated cohort rehabilitates automatically once its recent window turns
 * positive — the query only looks at the newest outcomes.
 */
import type { Chain, Logger } from "@autonomous-trader/shared";

export interface ShadowOutcomeRow {
  strategyId: string;
  returnPct: number;
}

export interface CohortStatsSource {
  getShadowOutcomes(chain: string, limit: number): Promise<ShadowOutcomeRow[]>;
}

export interface GatedCohort {
  strategyId: string;
  chain: Chain;
  samples: number;
  medianReturnPct: number;
}

const DEFAULT_MIN_SAMPLES = 100; // doc §9: O(100) decisions before belief
const DEFAULT_WINDOW = 2000; // most-recent evaluated outcomes per chain
const DEFAULT_REFRESH_MS = 5 * 60_000;

export class CohortGate {
  private readonly cache = new Map<Chain, { at: number; gated: GatedCohort[] }>();

  constructor(
    private readonly source: CohortStatsSource | null,
    private readonly log: Logger,
    private readonly minSamples: number = DEFAULT_MIN_SAMPLES,
    private readonly window: number = DEFAULT_WINDOW,
    private readonly refreshMs: number = DEFAULT_REFRESH_MS,
  ) {}

  /** Refresh one chain's stats when the cache is stale. Never throws. */
  async refresh(chain: Chain, now: number = Date.now()): Promise<void> {
    const cached = this.cache.get(chain);
    if (cached && now - cached.at < this.refreshMs) return;
    if (!this.source) return;
    try {
      const rows = await this.source.getShadowOutcomes(chain, this.window);
      if (!Array.isArray(rows)) return;
      const byStrategy = new Map<string, number[]>();
      for (const row of rows) {
        if (typeof row?.strategyId !== "string" || !Number.isFinite(row?.returnPct)) continue;
        const list = byStrategy.get(row.strategyId) ?? [];
        list.push(row.returnPct);
        byStrategy.set(row.strategyId, list);
      }
      const gated: GatedCohort[] = [];
      for (const [strategyId, returns] of byStrategy) {
        if (returns.length < this.minSamples) continue;
        returns.sort((a, b) => a - b);
        const median = returns[Math.floor(returns.length / 2)] ?? 0;
        if (median <= 0) {
          gated.push({ strategyId, chain, samples: returns.length, medianReturnPct: Math.round(median * 100) / 100 });
        }
      }
      this.cache.set(chain, { at: now, gated });
      if (gated.length > 0) {
        this.log.info("Cohort gate refreshed", {
          chain,
          gated: gated.map((g) => `${g.strategyId}:n=${g.samples},med=${g.medianReturnPct}%`),
        });
      }
    } catch (err) {
      this.log.warn("Cohort gate refresh failed — keeping last known state", {
        chain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The gate record when this cohort is blocked, else null (allowed). */
  isGated(strategyId: string, chain: Chain): GatedCohort | null {
    return this.cache.get(chain)?.gated.find((g) => g.strategyId === strategyId) ?? null;
  }

  /** All currently gated cohorts (one chain, or everything cached). */
  gatedCohorts(chain?: Chain): GatedCohort[] {
    if (chain) return [...(this.cache.get(chain)?.gated ?? [])];
    return [...this.cache.values()].flatMap((c) => c.gated);
  }
}
