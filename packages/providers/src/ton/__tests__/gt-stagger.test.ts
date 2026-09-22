import { describe, expect, it } from "vitest";
import { gtStaggerMs } from "../geckoterminal-discovery.js";

describe("gtStaggerMs", () => {
  it("is deterministic and within the spread", () => {
    for (const chain of ["ton", "bsc", "base", "polygon", "arbitrum", "solana"]) {
      const a = gtStaggerMs(chain);
      expect(a).toBe(gtStaggerMs(chain)); // stable across calls/restarts
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(15_000); // < half the 30s poll interval
    }
  });

  it("spreads the chains we run today", () => {
    const offsets = [gtStaggerMs("ton"), gtStaggerMs("bsc"), gtStaggerMs("base")];
    expect(new Set(offsets).size).toBe(offsets.length); // no two aligned
  });
});
