import { describe, expect, it } from "vitest";
import { StrategyPerformanceTracker, type TradeOutcome } from "../strategy-performance.js";

const outcome: TradeOutcome = {
  strategyId: "paper-v2", pnlUsd: -0.089325, netPnlUsd: -0.090325,
  feesUsd: 0.001, slippageUsd: 0.089325, durationMs: 1000, timestamp: new Date(),
};

describe("authoritative fill-net strategy outcomes", () => {
  it("does not deduct fees or slippage again when explicit net PnL is supplied", () => {
    const tracker = new StrategyPerformanceTracker();
    tracker.record(outcome);
    expect(tracker.getStats("paper-v2").expectancyUsd).toBe(-0.090325);
    expect(tracker.getStats("paper-v2").sampleSize).toBe(1);
    expect(tracker.isStatisticallyMeaningful("paper-v2")).toBe(false);
  });

  it("preserves pre-net consumer semantics", () => {
    const tracker = new StrategyPerformanceTracker();
    const { netPnlUsd: _, ...legacy } = outcome;
    tracker.record({ ...legacy, pnlUsd: 10, feesUsd: 1, slippageUsd: 2 });
    expect(tracker.getStats("paper-v2").expectancyUsd).toBe(7);
  });

  it.each([NaN, Infinity, -Infinity])("rejects invalid net outcome %s", (netPnlUsd) => {
    expect(() => new StrategyPerformanceTracker().record({ ...outcome, netPnlUsd })).toThrow(/Invalid/);
  });
});
