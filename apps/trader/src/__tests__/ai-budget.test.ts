import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConfig, Logger } from "@autonomous-trader/shared";
import { AiBudget, type AiBudgetState, type AiUsage } from "../ai-budget.js";

function cfg(overrides: Partial<AIConfig> = {}): AIConfig {
  return { costPer1kTokensUsd: 1, maxCostPerDayUsd: 1, ...overrides } as AIConfig;
}

const log = { warn: vi.fn() } as unknown as Logger;
const usage = { prompt_tokens: 750, completion_tokens: 250 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T23:59:59Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AiBudget", () => {
  it("rolls the UTC day before checking a previously reached cap", () => {
    const budget = new AiBudget(cfg(), log);
    budget.trackCost(usage);
    expect(budget.overCostCap()).toBe(true);
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    expect(budget.overCostCap()).toBe(false);
    expect(budget.snapshot()).toMatchObject({ day: "2026-09-26", estimatedCostUsd: 0, calls: 0 });
    budget.trackCost(usage);
    expect(budget.overCostCap()).toBe(true);
  });

  it("restores same-day acknowledged spend and cannot overwrite live usage", () => {
    const first = new AiBudget(cfg(), log);
    first.trackCost(usage);
    const restored = new AiBudget(cfg(), log);
    expect(restored.importState(JSON.parse(JSON.stringify(first.exportState())))).toBe(true);
    expect(restored.overCostCap()).toBe(true);
    expect(restored.importState(new AiBudget(cfg(), log).exportState())).toBe(false);
    expect(restored.snapshot().estimatedCostUsd).toBe(1);
  });

  it("never imports yesterday's or a future day's spend into today", () => {
    const budget = new AiBudget(cfg(), log);
    budget.trackCost(usage);
    const previous = budget.exportState();
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    const restored = new AiBudget(cfg(), log);
    expect(restored.importState(previous)).toBe(false);
    expect(restored.importState({ ...previous, day: "2026-09-27" })).toBe(false);
    expect(restored.snapshot()).toMatchObject({ day: "2026-09-26", calls: 0, estimatedCostUsd: 0 });
  });

  it.each([undefined, {}, { prompt_tokens: NaN, completion_tokens: Infinity },
    { prompt_tokens: -100, completion_tokens: -50 }, { prompt_tokens: 0.5 },
    { prompt_tokens: "100" }])("does not label invalid or missing usage as free: %j", (raw) => {
    const budget = new AiBudget(cfg(), log);
    budget.trackCost(raw as AiUsage | undefined);
    expect(budget.snapshot()).toMatchObject({ calls: 1, usageComplete: false, complete: false, estimatedCostUsd: null });
  });

  it("retains partial known usage as an explicitly incomplete subtotal", () => {
    const budget = new AiBudget(cfg(), log);
    budget.trackCost({ prompt_tokens: 500 });
    budget.trackCost({ completion_tokens: 500, prompt_tokens: NaN });
    expect(budget.snapshot()).toMatchObject({ estimatedCostUsd: 1, promptTokens: 500, completionTokens: 500, incompleteCalls: 2, complete: false });
    expect(budget.overCostCap()).toBe(true);
  });

  it.each([0, -1, NaN, Infinity])("marks missing/invalid rate %s as unpriced without corrupting totals", (rate) => {
    const budget = new AiBudget(cfg({ costPer1kTokensUsd: rate }), log);
    budget.trackCost(usage);
    expect(budget.snapshot()).toMatchObject({ estimatedCostUsd: null, usageComplete: true, pricingComplete: false, complete: false });
    expect(budget.overCostCap()).toBe(false);
    expect(budget.overCostCap()).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    budget.overCostCap();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("rejects non-finite or negative cost caps", () => {
    for (const cap of [NaN, Infinity, -1]) {
      expect(new AiBudget(cfg({ maxCostPerDayUsd: cap }), log).overCostCap()).toBe(true);
    }
  });

  it("does not contaminate the estimate when finite token/rate multiplication overflows", () => {
    const budget = new AiBudget(cfg({ costPer1kTokensUsd: Number.MAX_VALUE }), log);
    budget.trackCost({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 });
    expect(budget.snapshot()).toMatchObject({ estimatedCostUsd: null, pricingComplete: false, complete: false });
    expect(JSON.stringify(budget.exportState())).not.toContain("Infinity");
  });

  it("distinguishes explicit zero usage from absent usage", () => {
    const budget = new AiBudget(cfg(), log);
    budget.trackCost({ prompt_tokens: 0, completion_tokens: 0 });
    expect(budget.snapshot()).toMatchObject({ estimatedCostUsd: 0, calls: 1, complete: true });
  });

  it("exposes immutable detached state and persists pending requests as incomplete", () => {
    const budget = new AiBudget(cfg(), log);
    const acknowledge = budget.beginRequest();
    const pending = budget.snapshot();
    expect(pending).toMatchObject({ calls: 1, incompleteCalls: 1, estimatedCostUsd: null });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(() => { (pending as { calls: number }).calls = 0; }).toThrow();
    const restored = new AiBudget(cfg(), log);
    expect(restored.importState(pending)).toBe(true);
    expect(restored.snapshot().complete).toBe(false);
    acknowledge(usage);
    acknowledge(usage);
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: 1, complete: true });
    expect(pending.complete).toBe(false);
  });

  it("attributes late usage to its request day and emits both rollover days", async () => {
    const states: AiBudgetState[] = [];
    const budget = new AiBudget(cfg(), log, { onChange: (state) => { states.push(state); } });
    const acknowledge = budget.beginRequest();
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    expect(budget.overCostCap()).toBe(false);
    acknowledge(usage);
    await budget.flush();
    expect(states.at(-1)).toMatchObject({ day: "2026-09-25", estimatedCostUsd: 1, complete: true });
    expect(states.some((state) => state.day === "2026-09-26" && state.calls === 0)).toBe(true);
    expect(budget.snapshot()).toMatchObject({ day: "2026-09-26", estimatedCostUsd: 0 });
  });

  it("serializes optional persistence sinks without blocking budget calls", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const sink = vi.fn().mockReturnValueOnce(waiting).mockResolvedValue(undefined);
    const budget = new AiBudget(cfg(), log, { onChange: sink });
    budget.trackCost(usage);
    expect(budget.overCostCap()).toBe(true);
    await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(1);
    release();
    await budget.flush();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ estimatedCostUsd: null });
    expect(sink.mock.calls[1]?.[0]).toMatchObject({ estimatedCostUsd: 1, complete: true });
    expect(Object.isFrozen(sink.mock.calls[1]?.[0])).toBe(true);
  });

  it("contains sink failures, retains spend, and reports incomplete persistence on flush", async () => {
    const budget = new AiBudget(cfg(), log, { onChange: async () => { throw new Error("offline journal"); } });
    budget.trackCost(usage);
    await expect(budget.flush()).rejects.toThrow("persistence incomplete");
    expect(budget.overCostCap()).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  it("rejects malformed persisted values without erasing known state", () => {
    const empty = new AiBudget(cfg(), log).exportState();
    for (const state of [null, {}, { ...empty, version: 2 }, { ...empty, estimatedCostUsd: NaN },
      { ...empty, estimatedCostUsd: -1 }, { ...empty, calls: Infinity },
      { ...empty, incompleteCalls: 1 }, { ...empty, complete: false },
      { ...empty, estimatedCostUsd: null }]) {
      const budget = new AiBudget(cfg(), log);
      expect(budget.importState(state)).toBe(false);
      expect(budget.snapshot().estimatedCostUsd).toBe(0);
    }
  });
});
