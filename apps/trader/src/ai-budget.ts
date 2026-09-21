/**
 * Shared daily USD budget for all AI agents (veto + autonomous trader).
 * One instance across agents so they draw a single AI_MAX_COST_PER_DAY_USD
 * cap, not one each. UTC-day rollover; costPer1kTokensUsd <= 0 disables
 * enforcement (warned once per day).
 */
import type { AIConfig, Logger } from "@autonomous-trader/shared";

export interface AiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export class AiBudget {
  private dayKey = "";
  private spentUsd = 0;
  private capLoggedDay = "";

  constructor(
    private readonly cfg: AIConfig,
    private readonly log: Logger,
  ) {}

  trackCost(usage: AiUsage | undefined): void {
    if (!usage || this.cfg.costPer1kTokensUsd <= 0) return;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.dayKey) { this.dayKey = day; this.spentUsd = 0; }
    this.spentUsd += ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) / 1000 * this.cfg.costPer1kTokensUsd;
  }

  overCostCap(): boolean {
    if (this.cfg.costPer1kTokensUsd <= 0) {
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.capLoggedDay) {
        this.capLoggedDay = day;
        this.log.warn("AI cost cap NOT enforced — AI_COST_PER_1K_TOKENS_USD unset", { maxCostPerDayUsd: this.cfg.maxCostPerDayUsd });
      }
      return false;
    }
    return this.spentUsd >= this.cfg.maxCostPerDayUsd;
  }
}
