import { describe, it, expect } from "vitest";
import { InMemoryIdempotencyGuard, FallbackIdempotencyGuard, assertNotDuplicate } from "../idempotency.js";
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
