import { describe, it, expect, vi } from "vitest";
import { Alerter } from "../alerter.js";
import { createLogger } from "@autonomous-trader/shared";

describe("Alerter", () => {
  it("is a no-op when unconfigured (never throws, never fetches)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const a = new Alerter({ dedupeWindowMs: 1000 }, createLogger({ t: "test" }));
    expect(a.isEnabled).toBe(false);
    a.alert("CRITICAL", "k", "msg");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("dedupes the same key within the window", async () => {
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push(String(url));
      return new Response("{}");
    });
    const a = new Alerter(
      { botToken: "t", chatId: "c", dedupeWindowMs: 60_000 },
      createLogger({ t: "test" }),
    );
    a.alert("WARNING", "same-key", "first");
    a.alert("WARNING", "same-key", "second"); // deduped
    a.alert("WARNING", "other-key", "third"); // different key passes
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(2);
    fetchSpy.mockRestore();
  });
});
