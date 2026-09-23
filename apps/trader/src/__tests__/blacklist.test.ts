import { describe, it, expect } from "vitest";
import { TokenBlacklist, BLACKLIST_KEY, type BlacklistStore } from "../blacklist.js";
import { createLogger } from "@autonomous-trader/shared";

function fakeStore(): BlacklistStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getSystemState: async (k) => data.get(k) ?? null,
    setSystemState: async (k, v) => { data.set(k, v); },
  };
}

describe("TokenBlacklist", () => {
  it("adds, lists, and persists entries", async () => {
    const store = fakeStore();
    const bl = new TokenBlacklist(store, createLogger({ t: "test" }));
    bl.add("0xabc", "bsc", "wash-traded launch/rug pattern");
    expect(bl.isListed("0xabc")).toBe(true);
    expect(bl.isListed("0xother")).toBe(false);
    expect(bl.size).toBe(1);
    await new Promise((r) => setTimeout(r, 10)); // best-effort persist
    const raw = store.data.get(BLACKLIST_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)[0]).toMatchObject({ token: "0xabc", chain: "bsc", reason: "wash-traded launch/rug pattern" });
  });

  it("round-trips through load() and dedupes re-adds", async () => {
    const store = fakeStore();
    const bl = new TokenBlacklist(store, createLogger({ t: "test" }));
    bl.add("0xabc", "bsc", "r1");
    bl.add("0xabc", "bsc", "r2"); // dedupe — first entry stays
    await new Promise((r) => setTimeout(r, 10));
    const revived = new TokenBlacklist(store, createLogger({ t: "test" }));
    await revived.load();
    expect(revived.size).toBe(1);
    expect(revived.isListed("0xabc")).toBe(true);
    expect(revived.snapshot()[0]?.reason).toBe("r1");
  });

  it("caps at 1000 entries, dropping the oldest", async () => {
    const bl = new TokenBlacklist(fakeStore(), createLogger({ t: "test" }));
    for (let i = 0; i < 1002; i++) bl.add(`t${i}`, "bsc", "sus");
    expect(bl.size).toBe(1000);
    expect(bl.isListed("t0")).toBe(false);
    expect(bl.isListed("t1")).toBe(false);
    expect(bl.isListed("t2")).toBe(true);
    expect(bl.isListed("t1001")).toBe(true);
  });

  it("works with no store (memory-only) and loads nothing without one", async () => {
    const bl = new TokenBlacklist(null, createLogger({ t: "test" }));
    await bl.load();
    bl.add("0xdead", "base", "phantom volume");
    expect(bl.isListed("0xdead")).toBe(true);
    expect(bl.snapshot()[0]?.token).toBe("0xdead");
  });

  it("load() tolerates corrupt persisted JSON", async () => {
    const store = fakeStore();
    store.data.set(BLACKLIST_KEY, "{not json");
    const bl = new TokenBlacklist(store, createLogger({ t: "test" }));
    await bl.load();
    expect(bl.size).toBe(0);
  });
});
