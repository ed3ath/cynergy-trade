/** Shared UTC-day operating-cost estimate, not a guaranteed billing ceiling. */
import type { AIConfig, Logger } from "@autonomous-trader/shared";

export interface AiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface AiBudgetState {
  readonly version: 1;
  readonly day: string;
  /** A known subtotal when incomplete; null means no priced usage is known. */
  readonly estimatedCostUsd: number | null;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly incompleteCalls: number;
  readonly unpricedCalls: number;
  readonly usageComplete: boolean;
  readonly pricingComplete: boolean;
  readonly complete: boolean;
}

export interface AiBudgetOptions {
  /** Serialized, dated snapshots. Persist by day; a late call can update an older day. */
  onChange?: (state: AiBudgetState) => void | Promise<void>;
}

interface DaySpend {
  day: string;
  spentUsd: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  incompleteCalls: number;
  unpricedCalls: number;
}

export class AiBudget {
  private current: DaySpend = this.newDay();
  private capLoggedDay = "";
  private persistence = Promise.resolve();
  private persistenceFailed = false;

  constructor(
    private readonly cfg: AIConfig,
    private readonly log: Logger,
    private readonly options: AiBudgetOptions = {},
  ) {}

  /** Record unknown usage immediately, then acknowledge it once if it arrives.
   * Pending/failed requests are not free, including after a restart or timeout. */
  beginRequest(): (usage: AiUsage | undefined) => void {
    this.rollDay();
    const day = this.current;
    const rate = this.cfg.costPer1kTokensUsd;
    const priced = Number.isFinite(rate) && rate > 0;
    day.calls++;
    day.incompleteCalls++;
    if (!priced) day.unpricedCalls++;
    this.changed(day);
    let acknowledged = false;
    return (usage) => {
      if (acknowledged) return;
      acknowledged = true;
      const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
      const prompt = usage?.prompt_tokens;
      const completion = usage?.completion_tokens;
      if (valid(prompt) && valid(completion)) day.incompleteCalls--;
      const promptTokens = valid(prompt) ? prompt : 0;
      const completionTokens = valid(completion) ? completion : 0;
      const cost = (promptTokens + completionTokens) / 1000 * rate;
      if (!Number.isSafeInteger(day.promptTokens + promptTokens) ||
          !Number.isSafeInteger(day.completionTokens + completionTokens)) {
        if (valid(prompt) && valid(completion)) day.incompleteCalls++;
      } else {
        day.promptTokens += promptTokens;
        day.completionTokens += completionTokens;
      }
      if (priced && Number.isFinite(cost) && Number.isFinite(day.spentUsd + cost)) {
        day.spentUsd += cost;
      } else if (priced) {
        day.unpricedCalls++;
      }
      this.changed(day);
    };
  }

  trackCost(usage: AiUsage | undefined): void {
    this.beginRequest()(usage);
  }

  overCostCap(): boolean {
    this.rollDay();
    if (!Number.isFinite(this.cfg.maxCostPerDayUsd) || this.cfg.maxCostPerDayUsd < 0) return true;
    if (!Number.isFinite(this.cfg.costPer1kTokensUsd) || this.cfg.costPer1kTokensUsd <= 0) {
      if (this.current.day !== this.capLoggedDay) {
        this.capLoggedDay = this.current.day;
        this.log.warn("AI cost cap NOT enforced: valid token pricing is unavailable", { maxCostPerDayUsd: this.cfg.maxCostPerDayUsd });
      }
      return false;
    }
    return this.current.spentUsd >= this.cfg.maxCostPerDayUsd;
  }

  snapshot(): AiBudgetState {
    this.rollDay();
    return this.view(this.current);
  }

  exportState(): AiBudgetState {
    return this.snapshot();
  }

  /** Restore before starting requests. Never replace live spend or another UTC day. */
  importState(value: unknown): boolean {
    this.rollDay();
    if (!value || typeof value !== "object" || this.current.calls > 0) return false;
    const state = value as Record<string, unknown>;
    if (state["version"] !== 1 || state["day"] !== this.current.day) return false;
    const counts = ["calls", "promptTokens", "completionTokens", "incompleteCalls", "unpricedCalls"] as const;
    if (state["estimatedCostUsd"] !== null &&
        (typeof state["estimatedCostUsd"] !== "number" || !Number.isFinite(state["estimatedCostUsd"]) || state["estimatedCostUsd"] < 0)) return false;
    if (counts.some((key) => typeof state[key] !== "number" || !Number.isSafeInteger(state[key]) || state[key] < 0)) return false;
    const s = value as AiBudgetState;
    if (s.incompleteCalls > s.calls || s.unpricedCalls > s.calls ||
        s.usageComplete !== (s.incompleteCalls === 0) || s.pricingComplete !== (s.unpricedCalls === 0) ||
        s.complete !== (s.usageComplete && s.pricingComplete) ||
        (s.complete && s.estimatedCostUsd === null) ||
        (s.calls === 0 && (s.estimatedCostUsd !== 0 || s.promptTokens !== 0 || s.completionTokens !== 0))) return false;
    this.current = {
      day: s.day, spentUsd: s.estimatedCostUsd ?? 0, calls: s.calls,
      promptTokens: s.promptTokens, completionTokens: s.completionTokens,
      incompleteCalls: s.incompleteCalls, unpricedCalls: s.unpricedCalls,
    };
    return true;
  }

  /** Wait for queued sink writes; the caller supplies any shutdown timeout. */
  async flush(): Promise<void> {
    await this.persistence;
    if (this.persistenceFailed) throw new Error("AI budget persistence incomplete");
  }

  private newDay(): DaySpend {
    return { day: new Date().toISOString().slice(0, 10), spentUsd: 0, calls: 0, promptTokens: 0, completionTokens: 0, incompleteCalls: 0, unpricedCalls: 0 };
  }

  private rollDay(): void {
    if (this.current.day === new Date().toISOString().slice(0, 10)) return;
    this.changed(this.current);
    this.current = this.newDay();
    this.changed(this.current);
  }

  private view(day: DaySpend): AiBudgetState {
    const usageComplete = day.incompleteCalls === 0;
    const pricingComplete = day.unpricedCalls === 0;
    const complete = usageComplete && pricingComplete;
    return Object.freeze({
      version: 1, day: day.day,
      estimatedCostUsd: day.spentUsd === 0 && !complete ? null : day.spentUsd,
      calls: day.calls, promptTokens: day.promptTokens, completionTokens: day.completionTokens,
      incompleteCalls: day.incompleteCalls, unpricedCalls: day.unpricedCalls,
      usageComplete, pricingComplete, complete,
    });
  }

  private changed(day: DaySpend): void {
    const sink = this.options.onChange;
    if (!sink) return;
    const state = this.view(day);
    this.persistence = this.persistence.then(() => sink(state)).catch((error: unknown) => {
      this.persistenceFailed = true;
      this.log.warn("AI budget persistence failed", { day: state.day, error: String(error) });
    });
  }
}
