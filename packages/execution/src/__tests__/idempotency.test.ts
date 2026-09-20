import { describe, it, expect } from "vitest";
import {
  InMemoryIdempotencyGuard, FallbackIdempotencyGuard, RedisIdempotencyGuard, assertNotDuplicate,
} from "../idempotency.js";
import { ExecutionError } from "@autonomous-trader/shared";

describe("InMemoryIdempotencyGuard", () => {
  it("claims an intent exactly once", async () => {
    const g = new InMemoryIdempotencyGuard();
    expect(await g.claim("a")).toBe(true);
    expect(await g.claim("a")).toBe(false);
    expect(await g.claim("b")).toBe(true);
  });

  it("clears at cap (paper-mode semantics only)", async () => {
    const g = new InMemoryIdempotencyGuard(2);
    await g.claim("a");
    await g.claim("b");
    await g.claim("c"); // triggers clear
    expect(await g.claim("a")).toBe(true); // claimable again
  });
});

describe("FallbackIdempotencyGuard", () => {
  it("falls back to memory when primary throws", async () => {
    const failing = { claim: async () => { throw new Error("db down"); } };
    const g = new FallbackIdempotencyGuard(failing as never, new InMemoryIdempotencyGuard());
    expect(await g.claim("x")).toBe(true);
    expect(await g.claim("x")).toBe(false); // memory still guards
  });

  it("blocks duplicate when primary works", async () => {
    const g = new FallbackIdempotencyGuard(new InMemoryIdempotencyGuard(), new InMemoryIdempotencyGuard());
    expect(await g.claim("y")).toBe(true);
    expect(await g.claim("y")).toBe(false);
  });
});

describe("assertNotDuplicate", () => {
  it("throws ExecutionError on second attempt", async () => {
    const g = new InMemoryIdempotencyGuard();
    await assertNotDuplicate(g, "z");
    await expect(assertNotDuplicate(g, "z")).rejects.toThrow(ExecutionError);
  });
});

describe("RedisIdempotencyGuard", () => {
  function fakeRedis() {
    const claimed = new Set<string>();
    return {
      set: async (key: string, _v: string, _m: "PX", _ms: number, _nx: "NX") =>
        claimed.has(key) ? null : (claimed.add(key), "OK" as const),
      ping: async () => "PONG",
      disconnect: () => undefined,
    };
  }

  it("claims exactly once per intent (SET NX semantics)", async () => {
    const g = new RedisIdempotencyGuard(fakeRedis());
    expect(await g.claim("a")).toBe(true);
    expect(await g.claim("a")).toBe(false);
    expect(await g.claim("b")).toBe(true);
  });

  it("healthy() reflects ping success and failure", async () => {
    expect(await new RedisIdempotencyGuard(fakeRedis()).healthy()).toBe(true);
    const down = { ...fakeRedis(), ping: async () => { throw new Error("conn refused"); } };
    expect(await new RedisIdempotencyGuard(down as never).healthy()).toBe(false);
  });

  it("sits at the head of the LIVE fallback chain: Redis duplicate wins, Redis error falls through to Pg", async () => {
    const redis = fakeRedis();
    const chain = new FallbackIdempotencyGuard(
      new RedisIdempotencyGuard(redis),
      new InMemoryIdempotencyGuard(),
    );
    expect(await chain.claim("x")).toBe(true);   // Redis OK
    expect(await chain.claim("x")).toBe(false);  // Redis says duplicate

    const broken = { set: async () => { throw new Error("redis down"); }, ping: async () => "PONG", disconnect: () => undefined };
    const chain2 = new FallbackIdempotencyGuard(
      new RedisIdempotencyGuard(broken as never),
      new InMemoryIdempotencyGuard(),
    );
    expect(await chain2.claim("y")).toBe(true);  // fell back to memory
    expect(await chain2.claim("y")).toBe(false);
  });
});
