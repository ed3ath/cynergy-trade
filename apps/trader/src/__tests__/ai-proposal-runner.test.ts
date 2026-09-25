import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProposalRunner, type AiProposalContext } from "../ai-proposal-runner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => { vi.useRealTimers(); });

describe("AiProposalRunner", () => {
  it("keeps one ready slot, never overlaps, and returns detached deeply frozen data once", async () => {
    const runner = new AiProposalRunner<{ actions: { token: string }[] }>({ timeoutMs: 100, maxAgeMs: 200 });
    const value = { actions: [{ token: "original" }] };
    const operation = vi.fn().mockResolvedValue(value);
    expect(runner.start(operation)).toBe(true);
    expect(runner.inFlight).toBe(true);
    expect(runner.start(operation)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.inFlight).toBe(false);
    expect(runner.start(operation)).toBe(false);
    value.actions[0]!.token = "mutated later";
    const ready = runner.takeReady();
    expect(ready).toEqual({ snapshotAt: 10_000, expiresAt: 10_200, value: { actions: [{ token: "original" }] } });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready?.value.actions)).toBe(true);
    expect(() => { ready!.value.actions[0]!.token = "mutated consumer"; }).toThrow();
    expect(runner.takeReady()).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(runner.start(operation)).toBe(true);
    runner.dispose();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("aborts a hung snapshot/Jev/model task without allowing overlap or late completion", async () => {
    const runner = new AiProposalRunner<string[]>({ timeoutMs: 100, maxAgeMs: 200 });
    const pending = deferred<string[]>();
    let context!: AiProposalContext;
    const operation = vi.fn((ctx: AiProposalContext) => { context = ctx; return pending.promise; });
    runner.start(operation);
    await vi.advanceTimersByTimeAsync(100);
    expect(context).toMatchObject({ snapshotAt: 10_000, deadlineAt: 10_100 });
    expect(context.signal.aborted).toBe(true);
    expect(runner.takeReady()).toBeUndefined();
    expect(runner.inFlight).toBe(true);
    expect(runner.start(operation)).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(runner.start(operation)).toBe(false);
    pending.resolve(["late ENTER"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.inFlight).toBe(false);
    expect(runner.takeReady()).toBeUndefined();
    expect(runner.start(async () => [])).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()?.value).toEqual([]);
  });

  it("expires proposals from snapshot time, not completion time", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    const pending = deferred<string>();
    runner.start(() => pending.promise);
    await vi.advanceTimersByTimeAsync(80);
    pending.resolve("proposal");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120);
    expect(runner.takeReady()).toBeUndefined();
    expect(runner.start(async () => "fresh")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()?.snapshotAt).toBe(10_200);
  });

  it("does not let the deadline exceed the existing cycle's max age", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 1000, maxAgeMs: 100 });
    const pending = deferred<string>();
    let context!: AiProposalContext;
    runner.start((ctx) => { context = ctx; return pending.promise; });
    await vi.advanceTimersByTimeAsync(100);
    expect(context.deadlineAt).toBe(10_100);
    expect(context.signal.aborted).toBe(true);
    pending.resolve("expired");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()).toBeUndefined();
  });

  it("rejects an absolute-deadline overrun even before a delayed timer fires", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    const pending = deferred<string>();
    runner.start(() => pending.promise);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(10_101);
    pending.resolve("too late");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not begin queued research after its absolute deadline", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    const operation = vi.fn().mockResolvedValue("too late");
    runner.start(operation);
    vi.setSystemTime(10_101);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).not.toHaveBeenCalled();
    expect(runner.inFlight).toBe(false);
    expect(runner.takeReady()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a stale undrained slot when starting fresh work", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    runner.start(async () => "old");
    await vi.advanceTimersByTimeAsync(200);
    expect(runner.start(async () => "new")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()?.value).toBe("new");
  });

  it("disposes active work, clears its timer, and never accepts its result", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    const pending = deferred<string>();
    let signal!: AbortSignal;
    runner.start((ctx) => { signal = ctx.signal; return pending.promise; });
    await vi.advanceTimersByTimeAsync(0);
    runner.dispose();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(runner.start(async () => "new")).toBe(false);
    pending.resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()).toBeUndefined();
    expect(runner.inFlight).toBe(false);
  });

  it("does not start an operation after immediate disposal and clears ready data on shutdown", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    const operation = vi.fn().mockResolvedValue("value");
    runner.start(operation);
    runner.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).not.toHaveBeenCalled();
    const readyRunner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    readyRunner.start(operation);
    await vi.advanceTimersByTimeAsync(0);
    readyRunner.dispose();
    expect(readyRunner.takeReady()).toBeUndefined();
  });

  it("contains rejected operations and permits a later retry without an unhandled rejection", async () => {
    const runner = new AiProposalRunner<string>({ timeoutMs: 100, maxAgeMs: 200 });
    const pending = deferred<string>();
    runner.start(() => pending.promise);
    await vi.advanceTimersByTimeAsync(0);
    pending.reject(new Error("snapshot DB unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()).toBeUndefined();
    expect(runner.inFlight).toBe(false);
    expect(runner.start(async () => "recovered")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.takeReady()?.value).toBe("recovered");
  });

  it("rejects mutable non-plain values rather than claiming they are immutable", async () => {
    const runner = new AiProposalRunner<unknown>({ timeoutMs: 100, maxAgeMs: 200 });
    for (const value of [new Date(), new Map(), { mutate: () => undefined }]) {
      expect(runner.start(async () => value)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.takeReady()).toBeUndefined();
    }
  });

  it.each([0, -1, NaN, Infinity, 2_147_483_648])("rejects an unbounded/invalid duration %s", (ms) => {
    expect(() => new AiProposalRunner({ timeoutMs: ms, maxAgeMs: 100 })).toThrow(RangeError);
    expect(() => new AiProposalRunner({ timeoutMs: 100, maxAgeMs: ms })).toThrow(RangeError);
  });
});
