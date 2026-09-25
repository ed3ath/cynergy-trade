import { describe, expect, it } from "vitest";
import type { Position } from "@autonomous-trader/shared";
import { PaperBook, type PaperBookFill } from "../paper-book.js";

const now = new Date("2026-09-25T12:00:00Z");
const buy: PaperBookFill = {
  orderId: "buy", positionId: "p", side: "BUY", inputAmount: 3_000_000n,
  outputAmount: 2_955_000_000n, confirmedAt: now, cashDeltaUsd: -3.0005, realizedPnlDeltaUsd: 0,
};
function position(overrides: Partial<Position> = {}): Position {
  return {
    id: "p", mode: "PAPER", accountingVersion: 2, tokenAddress: "t", chain: "solana",
    strategyId: "ai-autonomous", status: "OPEN", sizeTokens: buy.outputAmount,
    sizeUsd: 3, entryPrice: 3 / 2.955, currentPrice: 1, stopLoss: 0.9, peakPrice: 3 / 2.955,
    unrealizedPnlUsd: -0.0455, unrealizedPnlPct: -1.5166667, drawdownFromPeakPct: 1.5,
    openedAt: now, updatedAt: now, ...overrides,
  };
}

describe("PaperBook confirmed cash accounting", () => {
  it("does not treat unrealized gains as available cash", () => {
    const book = new PaperBook(100);
    book.record(buy);
    const snap = book.snapshot([position({ currentPrice: 2 })], now);
    expect(snap.availableCapitalUsd).toBeCloseTo(96.9995, 8);
    expect(snap.totalValueUsd).toBeCloseTo(102.9095, 8);
    expect(snap.allTimePnlUsd).toBe(0);
  });

  it("reconciles the flat-price round trip including both fees", () => {
    const book = new PaperBook(100);
    book.record(buy);
    book.record({ ...buy, orderId: "sell", side: "SELL", inputAmount: buy.outputAmount,
      outputAmount: 2_910_675n, cashDeltaUsd: 2.910175, realizedPnlDeltaUsd: -0.090325 });
    const snap = book.snapshot([], now);
    expect(snap.availableCapitalUsd).toBeCloseTo(99.909675, 8);
    expect(snap.totalValueUsd).toBeCloseTo(snap.availableCapitalUsd, 8);
    expect(snap.dailyPnlUsd).toBeCloseTo(-0.090325, 8);
  });

  it("is idempotent and refuses conflicting order replays", () => {
    const book = new PaperBook(100);
    expect(book.record(buy)).toBe(true);
    expect(book.record({ ...buy })).toBe(false);
    expect(() => book.record({ ...buy, cashDeltaUsd: -2 })).toThrow("Conflicting");
    expect(book.snapshot([position()], now).availableCapitalUsd).toBeCloseTo(96.9995, 8);
  });

  it("reconstructs partial exits and UTC windows from the same facts", () => {
    const yesterday = new Date("2026-09-24T23:59:59Z");
    const fills: PaperBookFill[] = [{ ...buy, confirmedAt: new Date("2026-09-24T23:00:00Z") }, { ...buy, confirmedAt: yesterday, orderId: "partial",
      side: "SELL", inputAmount: buy.outputAmount / 2n, outputAmount: 2_000_000n,
      cashDeltaUsd: 1.9995, realizedPnlDeltaUsd: 0.49925 }];
    const book = new PaperBook(100);
    const restored = new PaperBook(100);
    for (const f of fills) { book.record(f); restored.record(f); }
    const positions = [position({ status: "PARTIAL_EXIT", sizeTokens: buy.outputAmount / 2n, sizeUsd: 1.5 })];
    expect(restored.snapshot(positions, now)).toEqual(book.snapshot(positions, now));
    expect(restored.snapshot(positions, now).dailyPnlUsd).toBe(0);
    expect(restored.snapshot(positions, now).weeklyPnlUsd).toBe(0.49925);
  });

  it("does not approve incomplete, orphaned, or legacy holdings", () => {
    const book = new PaperBook(100);
    expect(() => book.snapshot([position()], now)).toThrow("quantity mismatch");
    book.record(buy);
    expect(() => book.snapshot([], now)).toThrow("orphaned quantity");
    expect(() => book.snapshot([position({ accountingVersion: 1 })], now)).toThrow("unreconciled");
    expect(() => book.snapshot([position({ sizeTokens: 1n })], now)).toThrow("quantity mismatch");
  });
});
