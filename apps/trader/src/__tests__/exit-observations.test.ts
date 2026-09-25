import { afterEach, describe, expect, it, vi } from "vitest";
import { DataFreshnessConfigSchema, type LiquiditySnapshot, type MarketSnapshot, type Position, type SecurityAssessment } from "@autonomous-trader/shared";
import { ExitObservations } from "../exit-observations.js";

const date = new Date("2026-09-25T00:00:00Z");
const target = { tokenAddress: "t", chain: "base" as const };
const position = { ...target, id: "p" } as Position;
const market = { ...target, priceUsd: 0.85, observedAt: date } as MarketSnapshot;
const liquidity = { ...target, liquidityUsd: 30_000, liquidityChange5m: 0, observedAt: date } as LiquiditySnapshot;
const security = { ...target, status: "REJECT", dataTimestamp: date } as SecurityAssessment;
afterEach(() => vi.useRealTimers());

describe("independent position observations", () => {
  it("returns a fresh stop price without waiting for a hung liquidity provider", async () => {
    vi.useFakeTimers(); vi.setSystemTime(date);
    const getLiquidity = vi.fn(() => new Promise<LiquiditySnapshot>(() => {}));
    const reader = new ExitObservations({ market: async () => market, liquidity: getLiquidity, security: async () => security },
      DataFreshnessConfigSchema.parse({}), vi.fn());
    const input = await reader.observe(position);
    expect(input.market.priceUsd).toBe(0.85);
    expect(input.liquidity).toBeUndefined();
    expect(input.security?.status).toBe("REJECT");
    await reader.observe(position);
    expect(getLiquidity).toHaveBeenCalledTimes(1);
    reader.dispose();
  });

  it("does not manufacture a liquidity collapse on provider failure", async () => {
    vi.useFakeTimers(); vi.setSystemTime(date);
    const errors = vi.fn();
    const reader = new ExitObservations({ market: async () => market, liquidity: async () => { throw new Error("429"); }, security: async () => security },
      DataFreshnessConfigSchema.parse({}), errors);
    const input = await reader.observe(position);
    expect(input.liquidity).toBeUndefined();
    expect(errors).toHaveBeenCalled();
    reader.dispose();
  });

  it("refuses stale/non-finite prices and disposal cannot complete an observation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(date.getTime() + 20_000);
    const reader = new ExitObservations({ market: async () => market, liquidity: async () => liquidity, security: async () => security },
      DataFreshnessConfigSchema.parse({}), vi.fn());
    await expect(reader.observe(position)).rejects.toThrow("fresh valid price");
    reader.dispose();
    await expect(reader.observe(position)).rejects.toThrow("stopped");
  });
});
