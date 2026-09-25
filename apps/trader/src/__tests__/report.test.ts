import { describe, expect, it } from "vitest";
import type { PortfolioSnapshot, Position } from "@autonomous-trader/shared";
import {
  buildDailyReport, formatReportText, previousUtcDate, ReportTracker, utcReportWindow,
  type DailyReportData, type DailyReportInput, type ReportCompletedPosition, type ReportDataSource, type ReportFill,
} from "../report.js";

const DATE = "2026-09-24";
const fill = (over: Partial<ReportFill> = {}): ReportFill => ({
  orderId: "sell-1", positionId: "p1", side: "SELL", mode: "PAPER", chain: "base", strategyId: "ai-autonomous",
  accountingVersion: 2, dataQuality: [], confirmedAt: `${DATE}T12:00:00.000Z`,
  realizedGrossPnlDeltaUsd: -0.089325, realizedPnlDeltaUsd: -0.090325, allocatedEntryFeeUsd: 0.0005, feeUsd: 0.0005,
  ...over,
});
const closed = (over: Partial<ReportCompletedPosition> = {}): ReportCompletedPosition => ({
  id: "p1", mode: "PAPER", chain: "base", strategyId: "ai-autonomous", accountingVersion: 2, dataQuality: [],
  closedAt: `${DATE}T12:00:00.000Z`, pnlUsd: -0.090325, realizedGrossPnlUsd: -0.089325, totalFeesUsd: 0.001,
  ...over,
});
const data = (over: Partial<DailyReportData> = {}): DailyReportData => ({
  fills: [], completedPositions: [], coverage: { source: "durable", complete: true }, ...over,
});
const report = (rows: Partial<DailyReportData> = {}, over: Partial<DailyReportInput> = {}) => buildDailyReport({
  date: DATE, mode: "PAPER", data: data(rows), generatedAt: new Date("2026-09-25T00:01:00.000Z"), ...over,
});

describe("date-explicit daily reports", () => {
  it("selects the previous UTC date at 00:01, without current-day or stale closures", () => {
    const now = new Date("2026-09-25T00:01:00.000Z");
    const r = report({
      fills: [fill(), fill({ orderId: "old", confirmedAt: "2026-09-23T23:59:59.999Z" }), fill({ orderId: "next", confirmedAt: "2026-09-25T00:00:00.000Z" })],
      completedPositions: [closed(), closed({ id: "old", closedAt: "2026-09-23T23:59:59.999Z" }), closed({ id: "next", closedAt: "2026-09-25T00:00:00.000Z" })],
    }, { date: previousUtcDate(now), generatedAt: now });
    expect(r.date).toBe(DATE);
    expect(r.trades).toBe(1);
    expect(r.realizations).toBe(1);
    expect(r.netPnlUsd).toBeCloseTo(-0.090325, 10);
    expect(r.scope).toMatchObject({ from: `${DATE}T00:00:00.000Z`, to: "2026-09-25T00:00:00.000Z" });
  });

  it("uses half-open UTC boundaries, including exactly midnight and excluding the next midnight", () => {
    const r = report({ fills: [
      fill({ orderId: "start", confirmedAt: `${DATE}T00:00:00.000Z` }),
      fill({ orderId: "end", confirmedAt: "2026-09-25T00:00:00.000Z" }),
      fill({ orderId: "last", confirmedAt: `${DATE}T23:59:59.999Z` }),
    ] });
    expect(r.realizations).toBe(2);
    expect(r.netPnlUsd).toBeCloseTo(-0.18065, 10);
  });

  it("produces the same date totals after restart using a read-only durable source", async () => {
    const persisted = JSON.stringify(data({ fills: [fill()], completedPositions: [closed()] }));
    const source: ReportDataSource = { readReportData: async () => JSON.parse(persisted) as DailyReportData };
    const query = { date: DATE, mode: "PAPER" as const };
    const before = buildDailyReport({ ...query, data: await source.readReportData(query), generatedAt: new Date(`${DATE}T23:59:59Z`) });
    const after = buildDailyReport({ ...query, data: await source.readReportData(query), generatedAt: new Date("2026-09-26T11:00:00Z") });
    expect(after).toEqual({ ...before, generatedAt: "2026-09-26T11:00:00.000Z" });
    expect(after.coverage.source).toBe("durable");
    expect(after.trades).toBe(1);
  });

  it("never clears session fills at midnight, deduplicates identities, and snapshots caller data", () => {
    const tracker = new ReportTracker();
    const original = fill();
    tracker.recordFill(original);
    tracker.recordFill(original);
    tracker.recordCompletedPosition(closed());
    original.realizedPnlDeltaUsd = 100;
    original.dataQuality = ["mutated after recording"];
    expect(tracker.readReportData({ date: "2026-09-25", mode: "PAPER" }).fills).toHaveLength(0);
    const query = { date: DATE, mode: "PAPER" as const };
    const r = buildDailyReport({ ...query, data: tracker.readReportData(query) });
    expect(r.realizations).toBe(1);
    expect(r.netPnlUsd).toBeCloseTo(-0.090325, 10);
    expect(r.coverage).toMatchObject({ source: "session-only", complete: false, unverifiedPositions: 0 });
    expect(new ReportTracker().readReportData(query)).toMatchObject({ fills: [], coverage: { source: "session-only", complete: false } });
  });

  it("validates calendar dates and handles year/leap-day rollover in UTC", () => {
    expect(previousUtcDate(new Date("2027-01-01T00:01:00Z"))).toBe("2026-12-31");
    expect(previousUtcDate(new Date("2024-03-01T00:01:00Z"))).toBe("2024-02-29");
    for (const invalid of ["2026-02-30", "2026-9-24", "2026-09-24T00:00:00Z", "garbage"]) {
      expect(() => utcReportWindow(invalid)).toThrow("YYYY-MM-DD");
    }
  });
});

describe("realization versus completed-position accounting", () => {
  const half = fill({ orderId: "tp1", confirmedAt: `${DATE}T23:59:00Z`, realizedGrossPnlDeltaUsd: 0.3, realizedPnlDeltaUsd: 0.29925, allocatedEntryFeeUsd: 0.00025 });
  const final = fill({ orderId: "final", confirmedAt: "2026-09-25T00:00:30Z", realizedGrossPnlDeltaUsd: -0.6, realizedPnlDeltaUsd: -0.60075, allocatedEntryFeeUsd: 0.00025 });
  const completion = closed({ closedAt: "2026-09-25T00:00:30Z", pnlUsd: -0.3015, realizedGrossPnlUsd: -0.3, totalFeesUsd: 0.0015 });

  it("attributes partial/final fills to their own days and counts one cumulative losing close", () => {
    const rows = { fills: [half, final], completedPositions: [completion] };
    const day1 = report(rows);
    const day2 = report(rows, { date: "2026-09-25" });
    expect(day1).toMatchObject({ realizations: 1, trades: 0, wins: 0, losses: 0 });
    expect(day1.netPnlUsd).toBeCloseTo(0.29925, 10);
    expect(day2).toMatchObject({ realizations: 1, trades: 1, reconciledTrades: 1, wins: 0, losses: 1, profitFactor: 0 });
    expect(day2.netPnlUsd).toBeCloseTo(-0.60075, 10);
    expect(day2.completedPositionsNetPnlUsd).toBeCloseTo(-0.3015, 10);
    expect(day2.expectancyUsd).toBeCloseTo(-0.3015, 10);
    expect(day1.netPnlUsd + day2.netPnlUsd).toBeCloseTo(day2.completedPositionsNetPnlUsd, 10);
  });

  it("counts same-day partials and duplicate joined records once, not two trade samples", () => {
    const finalToday = { ...final, confirmedAt: `${DATE}T23:59:30Z` };
    const completedToday = { ...completion, closedAt: `${DATE}T23:59:30Z` };
    const r = report({ fills: [half, finalToday, structuredClone(finalToday)], completedPositions: [completedToday, structuredClone(completedToday)] });
    expect(r).toMatchObject({ realizations: 2, trades: 1, losses: 1, wins: 0 });
    expect(r.netPnlUsd).toBeCloseTo(-0.3015, 10);
    expect(r.cohorts[0]).toMatchObject({ trades: 1, losses: 1, realizations: 2 });
    expect(r.coverage.invalidRecords).toBe(0);
  });

  it("accepts duplicate journal rows with native bigint quantity fields", () => {
    const row = { ...fill(), inputAmount: 3_000_000_000n, outputAmount: 2_910_675n };
    const r = report({ fills: [row, structuredClone(row)] });
    expect(r.realizations).toBe(1);
    expect(r.netPnlUsd).toBeCloseTo(-0.090325, 10);
    expect(r.coverage.invalidRecords).toBe(0);
  });

  it("reports the flat-price $3 round trip net without double-deducting fees or slippage", () => {
    const buy = fill({ orderId: "buy", side: "BUY", realizedGrossPnlDeltaUsd: 0, realizedPnlDeltaUsd: 0, allocatedEntryFeeUsd: 0 });
    const r = report({ fills: [buy, fill()], completedPositions: [closed()], aiCost: { day: DATE, estimatedCostUsd: 0.02, complete: true } });
    expect(r.grossPnlUsd).toBeCloseTo(2.910675 - 3, 10);
    expect(r.totalFeesUsd).toBeCloseTo(0.001, 10);
    expect(r.transactionFeesPaidUsd).toBeCloseTo(0.001, 10);
    expect(r.netPnlUsd).toBeCloseTo(-0.090325, 10);
    expect(r.netAfterAiCostUsd).toBeCloseTo(-0.110325, 10);
    expect(r.entries).toBe(1);
    expect(r.feeModel).toBe("simulated");
  });

  it("distinguishes allocated entry fees from fees paid on the reporting day", () => {
    const r = report({ fills: [fill({ orderId: "buy-old", side: "BUY", confirmedAt: "2026-09-23T23:00:00Z" }), fill()], completedPositions: [closed()] });
    expect(r.totalFeesUsd).toBe(0.001);
    expect(r.transactionFeesPaidUsd).toBe(0.0005);
  });

  it("classifies fees-only losses by net and treats exact zero as a breakeven", () => {
    const r = report({
      completedPositions: [
        closed({ id: "gross-win-net-loss", realizedGrossPnlUsd: 0.0004, pnlUsd: -0.0006 }),
        closed({ id: "flat", realizedGrossPnlUsd: 0.001, pnlUsd: 0 }),
      ],
    });
    expect(r).toMatchObject({ trades: 2, reconciledTrades: 2, wins: 0, losses: 1, breakevens: 1, winRate: 0 });
    expect(r.expectancyUsd).toBeCloseTo(-0.0003, 10);
  });

  it("does not infer past equity from current wallet or subtract operating costs from cash", () => {
    const portfolio: PortfolioSnapshot = {
      totalValueUsd: 100, availableCapitalUsd: 97, allocatedUsd: 3, openPositions: 1,
      dailyPnlUsd: 500, weeklyPnlUsd: 500, monthlyPnlUsd: 500, allTimePnlUsd: 500,
      currentDrawdownPct: 2, peakValueUsd: 102, snapshotAt: new Date("2026-09-25T10:00:00Z"),
    };
    const position = { id: "open", mode: "PAPER", chain: "base", strategyId: "ai-autonomous", unrealizedPnlUsd: 0.5 } as Position;
    const before = structuredClone(portfolio);
    const r = report({ fills: [fill()], aiCost: { day: DATE, estimatedCostUsd: 1, complete: true } }, { portfolio, openPositions: [position] });
    expect(r.portfolioStartUsd).toBeNull();
    expect(r.portfolioEndUsd).toBeNull();
    expect(r.currentPortfolioUsd).toBe(100);
    expect(r.portfolioContextAt).toBe("2026-09-25T10:00:00.000Z");
    expect(r.openPnlUsd).toBe(0.5);
    expect(r.netPnlUsd).toBeCloseTo(-0.090325, 10);
    expect(r.netAfterAiCostUsd).toBeCloseTo(-1.090325, 10);
    expect(portfolio).toEqual(before);
  });
});

describe("coverage, costs and evaluation", () => {
  it("preserves legacy recorded losses and unverified losses without claiming legacy net", () => {
    const r = report({
      fills: [fill({ dataQuality: ["security-unknown"] })],
      completedPositions: [closed({ dataQuality: ["security-unknown"] }), closed({ id: "legacy", accountingVersion: 1, pnlUsd: -7, realizedGrossPnlUsd: null, totalFeesUsd: null })],
      aiCost: { day: DATE, estimatedCostUsd: 0, complete: true },
    });
    expect(r.trades).toBe(2);
    expect(r.reconciledTrades).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.legacy).toMatchObject({ trades: 1, losses: 1, recordedPnlUsd: -7 });
    expect(r.allRecordedCompletedPnlUsd).toBeCloseTo(-7.090325, 10);
    expect(r.coverage).toMatchObject({ complete: false, unverifiedPositions: 1 });
    expect(r.netAfterAiCostUsd).toBeNull();
    expect(r.cohorts.find((c) => c.accountingVersion === 1)).toMatchObject({ netPnlUsd: null, accounting: "legacy", losses: 1 });
    const text = formatReportText(r);
    expect(text).toContain("-7.000000");
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("NOT deducted from wallet");
  });

  it("returns explicit session-only/incomplete coverage for NullJournal data", () => {
    const r = report({ coverage: { source: "session-only", complete: true }, aiCost: { day: DATE, estimatedCostUsd: 0, complete: true } });
    expect(r.coverage.complete).toBe(false);
    expect(r.netAfterAiCostUsd).toBeNull();
    expect(formatReportText(r)).toContain("session-only");
  });

  it("keeps an unknown legacy close unknown instead of replacing it with a zero outcome", () => {
    const r = report({ completedPositions: [closed({ accountingVersion: 1, pnlUsd: null, realizedGrossPnlUsd: null, totalFeesUsd: null, dataQuality: ["legacy-realized-pnl-unknown"] })] });
    expect(r.legacy).toMatchObject({ trades: 1, recordedPnlUsd: null, unknownOutcomes: 1, wins: 0, losses: 0 });
    expect(r.allRecordedCompletedPnlUsd).toBeNull();
    expect(r.unknownOutcomes).toBe(1);
    expect(r.cohorts[0]?.recordedCompletedPnlUsd).toBeNull();
    expect(formatReportText(r)).toContain("known recorded PnL unknown");
  });

  it("does not call a legacy entry-only day complete accounting", () => {
    const r = report({ fills: [fill({ side: "BUY", accountingVersion: 1, realizedGrossPnlDeltaUsd: null, realizedPnlDeltaUsd: null })] });
    expect(r.entries).toBe(1);
    expect(r.coverage.complete).toBe(false);
    expect(r.cohorts[0]?.accounting).toBe("legacy");
  });

  it("keeps a zero-trade day finite, with unknown AI cost distinct from explicit covered zero", () => {
    const r = report();
    expect(r).toMatchObject({ trades: 0, realizations: 0, netPnlUsd: 0, expectancyUsd: 0, wins: 0, losses: 0, breakevens: 0 });
    expect(r.profitFactor).toBeNull();
    expect(r.aiCost).toMatchObject({ estimatedCostUsd: null, complete: false });
    expect(r.netAfterAiCostUsd).toBeNull();
    expect(r.openPnlUsd).toBeNull();
    expect(JSON.stringify(r)).not.toContain("NaN");
    expect(report({ aiCost: { day: DATE, estimatedCostUsd: 0, complete: true } }).netAfterAiCostUsd).toBe(0);
  });

  it.each([
    { day: DATE, estimatedCostUsd: null, complete: false },
    { day: DATE, estimatedCostUsd: 0.12, complete: false },
    { day: DATE, estimatedCostUsd: 0.12, complete: true, usageComplete: false },
    { day: DATE, estimatedCostUsd: 0.12, complete: true, pricingComplete: false },
    { day: "2026-09-25", estimatedCostUsd: 0.12, complete: true },
    { day: DATE, estimatedCostUsd: -1, complete: true },
  ])("does not claim net-after-AI with missing/incomplete/wrong-day cost: %j", (aiCost) => {
    const r = report({ fills: [fill()], aiCost });
    expect(r.netAfterAiCostUsd).toBeNull();
    expect(r.aiCost.complete).toBe(false);
    if (aiCost.day === DATE && aiCost.estimatedCostUsd === 0.12) expect(r.aiCost.estimatedCostUsd).toBe(0.12);
  });

  it("surfaces invalid accounting rather than presenting it as reconciled or hiding recorded losses", () => {
    const r = report({
      fills: [fill({ realizedPnlDeltaUsd: -100 }), fill({ orderId: "undated", confirmedAt: null })],
      completedPositions: [closed({ pnlUsd: -100, totalFeesUsd: null })],
    });
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.invalidRecords).toBeGreaterThan(0);
    expect(r.trades).toBe(1);
    expect(r.reconciledTrades).toBe(0);
    expect(r.allRecordedCompletedPnlUsd).toBe(-100);
    expect(r.cohorts[0]?.accounting).toBe("incomplete");
    expect(r.cohorts[0]?.losses).toBe(1);
  });

  it("scopes rows by mode/chain/strategy/version, without treating advisory signals as AI trades", () => {
    const r = report({ completedPositions: [
      closed(), closed({ id: "other-chain", chain: "solana" }), closed({ id: "other-strategy", strategyId: "deterministic" }),
      closed({ id: "other-mode", mode: "SHADOW" }), closed({ id: "legacy", accountingVersion: 1 }),
    ] }, { chains: ["base"], strategyId: "ai-autonomous", accountingVersion: 2 });
    expect(r.trades).toBe(1);
    expect(r.cohorts).toHaveLength(1);
    expect(r.cohorts[0]).toMatchObject({ mode: "PAPER", chain: "base", strategyId: "ai-autonomous", accountingVersion: 2, trades: 1 });
    expect(r.scope).toMatchObject({ chains: ["base"], strategyId: "ai-autonomous", accountingVersion: 2 });
  });

  it("does not pool small incompatible cohorts to clear the 100-position threshold", () => {
    const completedPositions = Array.from({ length: 120 }, (_, i) => closed({ id: `p${i}`, chain: i < 60 ? "base" : "solana" }));
    const r = report({ completedPositions });
    expect(r.trades).toBe(120);
    expect(r.cohorts).toHaveLength(2);
    expect(r.cohorts.every((c) => c.evaluation.status === "insufficient-samples")).toBe(true);
    expect(r.evaluation.status).toBe("insufficient-samples");
    expect(r.evaluation.livePromotion).toBe(false);
  });

  it("reports cost caution after 100 losses and never declares an evaluation pass", () => {
    const r = report({ completedPositions: Array.from({ length: 100 }, (_, i) => closed({ id: `p${i}` })) });
    expect(r.cohorts[0]?.evaluation.status).toBe("cost-caution");
    expect(r.cohorts[0]?.evaluation.reasons.join(" ")).toContain("1.3");
    expect(r.cohorts[0]?.evaluation.livePromotion).toBe(false);
  });
});
