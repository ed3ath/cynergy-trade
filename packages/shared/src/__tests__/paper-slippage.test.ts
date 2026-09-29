/**
 * Paper slippage estimate + EVM chain classifier (shared pure helpers).
 */
import { describe, expect, it } from "vitest";
import { estimatePaperSlippageBps } from "../types.js";

describe("estimatePaperSlippageBps", () => {
  it("charges ~base rate on deep pools ($3 into $566k)", () => {
    expect(estimatePaperSlippageBps(3, 566_000)).toBe(10);
  });

  it("adds linear impact near the liquidity floor ($3 into $15k)", () => {
    expect(estimatePaperSlippageBps(3, 15_000)).toBe(12);
  });

  it("haircuts exits from rugged pools ($3 into $5)", () => {
    expect(estimatePaperSlippageBps(3, 5)).toBe(6010);
  });

  it("caps drained pools at a 95% haircut, never ≥100%", () => {
    expect(estimatePaperSlippageBps(3, 0)).toBe(9500);
    expect(estimatePaperSlippageBps(3, -100)).toBe(9500);
  });

  it("returns undefined for invalid size or liquidity", () => {
    expect(estimatePaperSlippageBps(0, 15_000)).toBeUndefined();
    expect(estimatePaperSlippageBps(-3, 15_000)).toBeUndefined();
    expect(estimatePaperSlippageBps(NaN, 15_000)).toBeUndefined();
    expect(estimatePaperSlippageBps(3, NaN)).toBeUndefined();
    expect(estimatePaperSlippageBps(3, Infinity)).toBeUndefined();
  });

  it("scales with size ($500 into $15k pool)", () => {
    // 10 + 500/15000*10000 = 343bps — a $500 exit genuinely moves a $15k pool
    expect(estimatePaperSlippageBps(500, 15_000)).toBe(343);
  });
});
