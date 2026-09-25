import { describe, expect, it } from "vitest";
import { summarizeClosedTrades, type ClosedTradeLite } from "../loss-stats.js";

const t = (over: Partial<ClosedTradeLite>): ClosedTradeLite => ({ token: "T", pnlUsd: 0, ...over });

describe("summarizeClosedTrades", () => {
  it("computes win rate, averages, expectancy", () => {
    const s = summarizeClosedTrades([
      t({ pnlUsd: 3, pnlPct: 3 }),
      t({ pnlUsd: 3, pnlPct: 3 }),
      t({ pnlUsd: 3, pnlPct: 3 }),
      t({ pnlUsd: 2.9, pnlPct: 3 }),
      t({ pnlUsd: -10, pnlPct: -10, exitReason: "Hard stop loss hit: 1 <= 2" }),
    ]);
    expect(s.sampleSize).toBe(5);
    expect(s.winRatePct).toBe(80);
    expect(s.avgWinPct).toBe(3);
    expect(s.avgLossPct).toBe(-10);
    expect(s.expectancyPct).toBe(0.4); // High win rate alone does not establish an edge.
  });

  it("groups loss reasons (worst first) and strips detail after ':'", () => {
    const s = summarizeClosedTrades([
      t({ pnlUsd: -1, pnlPct: -5, exitReason: "Trailing stop: -8.0% from peak" }),
      t({ pnlUsd: -2, pnlPct: -11, exitReason: "Hard stop loss hit: 1 <= 2" }),
      t({ pnlUsd: -3, pnlPct: -12, exitReason: "Hard stop loss hit: 3 <= 4" }),
      t({ pnlUsd: 1, pnlPct: 2, exitReason: "Take profit 1 hit" }),
    ]);
    expect(s.lossReasons[0]).toMatchObject({ reason: "Hard stop loss hit", count: 2, avgPnlPct: -11.5 });
    expect(s.lossReasons[1]!.reason).toBe("Trailing stop");
  });

  it("flags weak strategies (>=3 trades, <40% wins) and repeat loser tokens", () => {
    const s = summarizeClosedTrades([
      t({ token: "A", strategyId: "s1", pnlUsd: -1, pnlPct: -5 }),
      t({ token: "B", strategyId: "s1", pnlUsd: -1, pnlPct: -5 }),
      t({ token: "C", strategyId: "s1", pnlUsd: 1, pnlPct: 2 }),
      t({ token: "D", strategyId: "s2", pnlUsd: 1, pnlPct: 2 }),
      t({ token: "D", strategyId: "s2", pnlUsd: -1, pnlPct: -5 }),
    ]);
    expect(s.weakStrategies).toEqual([{ strategyId: "s1", trades: 3, winRatePct: 33 }]);
    expect(s.repeatLoserTokens).toEqual([]);
    const s2 = summarizeClosedTrades([
      t({ token: "D", pnlUsd: -1, pnlPct: -5 }),
      t({ token: "D", pnlUsd: -1, pnlPct: -5 }),
      t({ token: "E", pnlUsd: 1, pnlPct: 2 }),
    ]);
    expect(s2.repeatLoserTokens).toEqual(["D"]);
  });

  it("handles empty input without NaN", () => {
    const s = summarizeClosedTrades([]);
    expect(s).toMatchObject({ sampleSize: 0, winRatePct: 0, expectancyPct: 0 });
    expect(s.lossReasons).toEqual([]);
  });

  it("uses supplied cumulative net without deducting costs again and keeps zero separate", () => {
    const s = summarizeClosedTrades([
      t({ pnlUsd: -0.090325, pnlPct: -3.010833, mode: "PAPER", accountingVersion: 2 }),
      t({ pnlUsd: 0, pnlPct: 0, mode: "PAPER", accountingVersion: 2 }),
    ]);
    expect(s.netPnlUsd).toBeCloseTo(-0.090325, 10);
    expect(s.expectancyUsd).toBeCloseTo(-0.0451625, 10);
    expect(s.breakevens).toBe(1);
    expect(s.lossReasons.reduce((n, r) => n + r.count, 0)).toBe(1);
    expect(s.feedbackEligible).toBe(true);
    expect(s.profitFactor).toBe(0);
  });

  it("does not invent zero percentages when returns are unavailable", () => {
    const s = summarizeClosedTrades([t({ pnlUsd: -1 }), t({ pnlUsd: -2, pnlPct: -10 })]);
    expect(s.percentageSampleSize).toBe(1);
    expect(s.avgLossPct).toBe(-10);
    expect(s.expectancyPct).toBe(-10);
    const unknown = summarizeClosedTrades([t({ pnlUsd: -1 })]);
    expect(unknown.avgLossPct).toBeNull();
    expect(unknown.expectancyPct).toBeNull();
    expect(unknown.lossReasons[0]?.avgPnlPct).toBeNull();
  });

  it("retains unverified and legacy recorded losses but exposes feedback ineligibility", () => {
    const s = summarizeClosedTrades([
      t({ pnlUsd: -2, mode: "PAPER", accountingVersion: 2, dataQuality: ["holders-unknown"] }),
      t({ pnlUsd: -5, mode: "PAPER", accountingVersion: 1 }),
      t({ pnlUsd: NaN }),
    ]);
    expect(s.sampleSize).toBe(2);
    expect(s.netPnlUsd).toBe(-7);
    expect(s.winRatePct).toBe(0);
    expect(s.legacyRows).toBe(1);
    expect(s.invalidPnlRows).toBe(1);
    expect(s.unverifiedRows).toBe(2);
    expect(s.feedbackEligible).toBe(false);
  });

  it("separates strategy and repeated-token evidence by mode/chain/accounting cohort", () => {
    const s = summarizeClosedTrades([
      t({ token: "same", pnlUsd: -1, chain: "base", strategyId: "ai", mode: "PAPER", accountingVersion: 2 }),
      t({ token: "same", pnlUsd: -1, chain: "solana", strategyId: "ai", mode: "PAPER", accountingVersion: 2 }),
      t({ token: "same", pnlUsd: -1, chain: "base", strategyId: "ai", mode: "SHADOW", accountingVersion: 2 }),
      t({ token: "same", pnlUsd: -1, chain: "base", strategyId: "ai", mode: "PAPER", accountingVersion: 1 }),
    ]);
    expect(s.cohorts).toHaveLength(4);
    expect(s.weakStrategies).toEqual([]);
    expect(s.repeatLoserTokens).toEqual([]);
    expect(s.feedbackEligible).toBe(false);
  });

  it("does not treat pooled small samples or undefined profit factor as validation", () => {
    const s = summarizeClosedTrades(Array.from({ length: 120 }, (_, i) => t({ pnlUsd: 1, chain: i < 60 ? "base" : "solana", mode: "PAPER", accountingVersion: 2 })));
    expect(s.sampleSize).toBe(120);
    expect(s.profitFactor).toBeNull();
    expect(s.evaluationStatus).toBe("insufficient-samples");
    expect(s.costCaution).toContain("AI operating costs are not included");
    expect(s.costCaution).toContain("not proof");
  });
});
