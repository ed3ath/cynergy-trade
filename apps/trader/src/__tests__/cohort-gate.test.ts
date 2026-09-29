import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@autonomous-trader/shared";
import { CohortGate, type CohortStatsSource, type ShadowOutcomeRow } from "../cohort-gate.js";

const log = createLogger({ t: "test" });

function source(rows: ShadowOutcomeRow[] | Error | unknown, calls: { n: number } = { n: 0 }): CohortStatsSource {
  return {
    getShadowOutcomes: async () => {
      calls.n++;
      if (rows instanceof Error) throw rows;
      return rows as ShadowOutcomeRow[];
    },
  };
}

const outcome = (strategyId: string, returnPct: number): ShadowOutcomeRow => ({ strategyId, returnPct });
const cohort = (strategyId: string, n: number, returnPct: number): ShadowOutcomeRow[] =>
  Array.from({ length: n }, () => outcome(strategyId, returnPct));

describe("CohortGate", () => {
  it("gates a large-sample cohort with negative median", async () => {
    const gate = new CohortGate(source([...cohort("strategy-micro-scalp", 892, -3.11)]), log);
    await gate.refresh("bsc");
    expect(gate.isGated("strategy-micro-scalp", "bsc")).toMatchObject({
      strategyId: "strategy-micro-scalp", chain: "bsc", samples: 892, medianReturnPct: -3.11,
    });
  });

  it("gates an exact-zero median (dead tape plus costs is negative net)", async () => {
    const gate = new CohortGate(source(cohort("strategy-micro-scalp", 1991, 0)), log);
    await gate.refresh("base");
    expect(gate.isGated("strategy-micro-scalp", "base")).not.toBeNull();
  });

  it("leaves a positive-median cohort open", async () => {
    const gate = new CohortGate(source(cohort("strategy-fresh-momentum", 150, 2.5)), log);
    await gate.refresh("solana");
    expect(gate.isGated("strategy-fresh-momentum", "solana")).toBeNull();
  });

  it("leaves small-sample cohorts open even when negative", async () => {
    const gate = new CohortGate(source(cohort("strategy-dip-reversion", 99, -50)), log);
    await gate.refresh("solana");
    expect(gate.isGated("strategy-dip-reversion", "solana")).toBeNull();
  });

  it("is outlier-proof: one +500000% tick cannot launder a losing cohort", async () => {
    const rows = [...cohort("strategy-fresh-momentum", 1618, -0.38), outcome("strategy-fresh-momentum", 500_000)];
    const gate = new CohortGate(source(rows), log);
    await gate.refresh("solana");
    // mean would be +300%; median stays -0.38 → gated
    expect(gate.isGated("strategy-fresh-momentum", "solana")).toMatchObject({ medianReturnPct: -0.38 });
  });

  it("drops malformed rows instead of crashing", async () => {
    const rows = [...cohort("s", 100, -5), { strategyId: "s", returnPct: NaN }, { strategyId: 42, returnPct: 1 }] as unknown as ShadowOutcomeRow[];
    const gate = new CohortGate(source(rows), log);
    await gate.refresh("ton");
    expect(gate.isGated("s", "ton")).toMatchObject({ samples: 100 });
  });

  it("fails open on refresh error, null source, and non-array results", async () => {
    const failing = new CohortGate(source(new Error("db down")), log);
    await failing.refresh("solana");
    expect(failing.isGated("anything", "solana")).toBeNull();

    const absent = new CohortGate(null, log);
    await absent.refresh("solana");
    expect(absent.isGated("anything", "solana")).toBeNull();

    const weird = new CohortGate(source(undefined), log);
    await weird.refresh("solana");
    expect(weird.isGated("anything", "solana")).toBeNull();
  });

  it("keeps the last known state when a later refresh fails", async () => {
    let rows: ShadowOutcomeRow[] | Error = cohort("s", 100, -5);
    const gate = new CohortGate({ getShadowOutcomes: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    } }, log, 100, 2000, 0); // refreshMs 0 → always stale
    await gate.refresh("solana");
    expect(gate.isGated("s", "solana")).not.toBeNull();
    rows = new Error("db down");
    await gate.refresh("solana");
    expect(gate.isGated("s", "solana")).not.toBeNull();
  });

  it("caches per chain inside the TTL and aggregates gated cohorts", async () => {
    const calls = { n: 0 };
    const gate = new CohortGate(source(cohort("s", 100, -5), calls), log, 100, 2000, 300_000);
    await gate.refresh("bsc", 1_000);
    await gate.refresh("bsc", 2_000);
    expect(calls.n).toBe(1);
    await gate.refresh("bsc", 1_000 + 300_001);
    expect(calls.n).toBe(2);
    await gate.refresh("base", 3_000);
    expect(gate.gatedCohorts("bsc")).toHaveLength(1);
    expect(gate.gatedCohorts()).toHaveLength(2);
  });
});
