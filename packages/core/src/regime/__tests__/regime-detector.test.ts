import { describe, it, expect } from "vitest";
import { classifyRegime, SolPriceSampler } from "../regime-detector.js";

const base = {
  drawdownPct: 0,
  maxDrawdownPct: 10,
  dailyLossUsd: 0,
  maxDailyLossUsd: 100,
  recentWinRate: null,
};

describe("classifyRegime", () => {
  it("RISK_OFF when drawdown at max", () => {
    const r = classifyRegime({ ...base, solPrices: [100, 101, 102], drawdownPct: 10, maxDrawdownPct: 10 });
    expect(r.regime).toBe("RISK_OFF");
  });

  it("RISK_OFF when daily loss limit hit", () => {
    const r = classifyRegime({ ...base, solPrices: [100], dailyLossUsd: 100 });
    expect(r.regime).toBe("RISK_OFF");
  });

  it("UNKNOWN with too few samples", () => {
    const r = classifyRegime({ ...base, solPrices: [100, 101, 102] });
    expect(r.regime).toBe("UNKNOWN");
  });

  it("BULL on steady uptrend with low vol", () => {
    const prices = [100, 100.4, 100.8, 101.2, 101.6, 102.0, 102.4, 102.8];
    const r = classifyRegime({ ...base, solPrices: prices });
    expect(r.regime).toBe("BULL");
    expect(r.solTrendPct1h).toBeGreaterThan(2);
  });

  it("BEAR on steady downtrend", () => {
    const prices = [100, 99.5, 99.0, 98.5, 98.0, 97.4, 96.9, 96.3];
    const r = classifyRegime({ ...base, solPrices: prices });
    expect(r.regime).toBe("BEAR");
  });

  it("HIGH_VOLATILITY on whipsaw prices", () => {
    const prices = [100, 103, 99, 104, 98, 105, 99, 106];
    const r = classifyRegime({ ...base, solPrices: prices });
    expect(r.regime).toBe("HIGH_VOLATILITY");
  });

  it("LOW_VOLATILITY on flat prices", () => {
    const prices = [100, 100.05, 100.02, 99.98, 100.01, 100.04, 99.99, 100.02];
    const r = classifyRegime({ ...base, solPrices: prices });
    expect(r.regime).toBe("LOW_VOLATILITY");
  });

  it("RISK_OFF when strategies failing (win rate < 25%)", () => {
    const prices = [100, 100.2, 100.4, 100.3, 100.5, 100.4, 100.6];
    const r = classifyRegime({ ...base, solPrices: prices, recentWinRate: 0.2 });
    expect(r.regime).toBe("RISK_OFF");
  });
});

describe("SolPriceSampler", () => {
  it("enforces minimum interval between samples", () => {
    const s = new SolPriceSampler(10, 60_000);
    s.add(100, 1_000_000);
    s.add(101, 1_030_000); // 30s later — rejected
    s.add(102, 1_061_000); // 61s later — accepted
    expect(s.size).toBe(2);
    expect(s.prices()).toEqual([100, 102]);
  });

  it("caps size", () => {
    const s = new SolPriceSampler(3, 0);
    for (let i = 0; i < 10; i++) s.add(100 + i, i * 1000);
    expect(s.size).toBe(3);
    expect(s.prices()[0]).toBe(107);
  });
});
