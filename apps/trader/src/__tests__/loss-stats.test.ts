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
    expect(s.expectancyPct).toBe(0.4); // 0.8*3 - 0.2*10 — the 80% goal is thin
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
});
