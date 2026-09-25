import { describe, it, expect, vi, afterEach } from "vitest";
import { JevAgent } from "../jev-agent.js";
import { AiBudget } from "../ai-budget.js";
import { createLogger, type AIConfig } from "@autonomous-trader/shared";
import type { AiCandidate } from "../ai-agent.js";

function cfg(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    enabled: true,
    autonomy: "auto",
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    maxCandidatesPerCycle: 10,
    maxCostPerDayUsd: 5,
    costPer1kTokensUsd: 0,
    timeoutMs: 1000,
    toolsEnabled: true,
    cycleSec: 60,
    maxActionsPerCycle: 3,
    maxOpenPositions: 3,
    tokenCooldownSec: 600,
    liveEnabled: true,
    jevApiKey: "jev-test",
    jevBaseUrl: "https://jev-ai.pro/api/v1",
    jevModel: "jev-latest",
    jevMinScore: 0.5,
    jevTimeoutMs: 1000,
    ...overrides,
  } as AIConfig;
}

function cand(token: string, chain: "solana" | "ton" = "solana"): AiCandidate {
  return { tokenAddress: token, chain };
}

function agent(c: AIConfig = cfg()): JevAgent {
  const log = createLogger({ t: "test" });
  return new JevAgent(c, log, new AiBudget(c, log));
}

function budgetedAgent(overrides: Partial<AIConfig> = {}) {
  const config = cfg({ costPer1kTokensUsd: 1, ...overrides });
  const log = createLogger({ t: "test" });
  const budget = new AiBudget(config, log);
  return { jev: new JevAgent(config, log, budget), budget };
}

function okResponse(usage?: unknown): Response {
  return new Response(JSON.stringify({ answers: { s0: { type: "score", score: 3 } }, usage }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("JevAgent", () => {
  it("normalizes graded score answers and attaches the rug/momentum review", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "jev-latest",
      answers: {
        s0: { type: "score", score: 4.2 },
        rug0: { type: "noul", noul: 0.7 },
        mom0: { type: "noul", noul: 0.9 },
        s1: { type: "score", score: 1 },
        rug1: { type: "noul", noul: 0.05 },
        mom1: { type: "noul", noul: 0.6 },
      },
      usage: { input_tokens: 400, output_tokens: 0 },
    })));
    const reviews = await agent().score([cand("TokA"), cand("TokB", "ton")]);
    expect(reviews.get("solana:TokA")).toEqual({ score: 4.2 / 5, rugProb: 0.7, momentumProb: 0.9 });
    expect(reviews.get("ton:TokB")).toEqual({ score: 1 / 5, rugProb: 0.05, momentumProb: 0.6 });
  });

  it("clamps out-of-range probabilities and fractional scores into 0–1", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      answers: {
        s0: { type: "score", score: 9.5 },
        rug0: { type: "noul", noul: 1.7 },
        mom0: { type: "noul", noul: -0.3 },
      },
    })));
    const reviews = await agent().score([cand("TokA")]);
    expect(reviews.get("solana:TokA")).toEqual({ score: 1, rugProb: 1, momentumProb: 0 });
  });

  it("omits review probabilities that are missing or non-numeric", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      answers: { s0: { type: "score", score: 3 }, rug0: { type: "noul" }, mom0: { type: "noul", noul: "yes" } },
    })));
    const reviews = await agent().score([cand("TokA")]);
    expect(reviews.get("solana:TokA")).toEqual({ score: 3 / 5 });
  });

  it("drops candidates whose score answer is invalid (pass-through, no guess)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      answers: { s0: { type: "score" }, s1: { type: "noul", noul: 0.9 }, rug1: {}, mom1: {} },
    })));
    const reviews = await agent().score([cand("TokA"), cand("TokB")]);
    expect(reviews.size).toBe(0);
  });

  it("sends compact card state and score+noul questions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      answers: { s0: { type: "score", score: 3 } },
    })));
    await agent().score([cand("TokVeryLongAddress123456789")]);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      model: string;
      state: string;
      questions: Record<string, { type: string; criteria?: string[] }>;
    };
    expect(Object.keys(body.questions).sort()).toEqual(["mom0", "rug0", "s0"]);
    expect(body.questions["s0"]!.criteria).toHaveLength(6);
    expect(body.model).toBe("jev-latest");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://jev-ai.pro/api/v1/systemone");
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer jev-test" });
    // compact card in a context envelope: shortened address, symbol carried
    const state = JSON.parse(body.state) as { context: string; tokens: { token: string }[] };
    expect(state.context).toContain("STRUCTURAL");
    expect(state.tokens[0]!.token).toBe("TokVer…6789");
  });

  it("honors the configured cycle candidate cap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ answers: {} })));
    const candidates = Array.from({ length: 15 }, (_, index) => cand(`Token${index}`));
    await agent(cfg({ maxCandidatesPerCycle: 3 })).score(candidates);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      questions: Record<string, unknown>;
      state: string;
    };
    expect(Object.keys(body.questions)).toHaveLength(9);
    expect(JSON.parse(body.state).tokens).toHaveLength(3);
  });

  it("returns an empty map on HTTP failure, timeout, or garbage — never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 402 }));
    expect(await agent().score([cand("TokA")])).toEqual(new Map());

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    expect(await agent().score([cand("TokA")])).toEqual(new Map());

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json"));
    expect(await agent().score([cand("TokA")])).toEqual(new Map());
  });

  it("skips the call entirely on empty input or a hit cost cap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await agent().score([])).toEqual(new Map());
    const c = cfg({ costPer1kTokensUsd: 1, maxCostPerDayUsd: 0.001 });
    const log = createLogger({ t: "test" });
    const budget = new AiBudget(c, log);
    budget.trackCost({ prompt_tokens: 10_000 }); // blows the tiny cap
    expect(await new JevAgent(c, log, budget).score([cand("TokA")])).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records a request as unknown before fetch and acknowledges actual input usage once", async () => {
    const { jev, budget } = budgetedAgent();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(budget.snapshot()).toMatchObject({ calls: 1, incompleteCalls: 1, estimatedCostUsd: null });
      return okResponse({ input_tokens: 400, output_tokens: 0 });
    });
    expect((await jev.score([cand("TokA")])).get("solana:TokA")).toEqual({ score: 0.6 });
    expect(budget.snapshot()).toMatchObject({ calls: 1, promptTokens: 400, completionTokens: 0, estimatedCostUsd: 0.4, complete: true });
  });

  it.each([undefined, null, {}, { output_tokens: 0 }])("keeps missing input usage %j incomplete without disabling valid advice", async (usage) => {
    const { jev, budget } = budgetedAgent();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse(usage));
    expect((await jev.score([cand("TokA")])).get("solana:TokA")).toEqual({ score: 0.6 });
    expect(budget.snapshot()).toMatchObject({ calls: 1, incompleteCalls: 1, estimatedCostUsd: null, usageComplete: false, complete: false });
  });

  it.each([NaN, Infinity, -10, "400", null, 0.5])("does not treat invalid input usage %s as known spend", async (inputTokens) => {
    const { jev, budget } = budgetedAgent();
    const response = new Response();
    vi.spyOn(response, "json").mockResolvedValue({ answers: { s0: { score: 3 } }, usage: { input_tokens: inputTokens } });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    expect((await jev.score([cand("TokA")])).size).toBe(1);
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, usageComplete: false });
  });

  it("distinguishes explicit zero input usage from absent usage", async () => {
    const { jev, budget } = budgetedAgent();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse({ input_tokens: 0 }));
    await jev.score([cand("TokA")]);
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: 0, complete: true });
  });

  it("retains incomplete spend on network errors, HTTP failures, and malformed response bodies", async () => {
    const { jev, budget } = budgetedAgent();
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(null)
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("not JSON"));
    for (let i = 0; i < 3; i++) expect(await jev.score([cand("TokA")])).toEqual(new Map());
    expect(budget.snapshot()).toMatchObject({ calls: 3, incompleteCalls: 3, estimatedCostUsd: null, complete: false });
  });

  it("rechecks shared spend immediately before the paid call", async () => {
    const { jev, budget } = budgetedAgent();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const pending = jev.score([cand("TokA")]);
    budget.trackCost({ prompt_tokens: 5000, completion_tokens: 0 });
    expect(await pending).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: 5 });
  });

  it.each([
    { jevTimeoutMs: 20, parentTimeoutMs: 100 },
    { jevTimeoutMs: 100, parentTimeoutMs: 20 },
  ])("uses the earlier local/runner deadline for a non-abortable request: %j", async ({ jevTimeoutMs, parentTimeoutMs }) => {
    vi.useFakeTimers();
    const { jev, budget } = budgetedAgent({ jevTimeoutMs });
    let finish!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = jev.score([cand("TokA")], { deadlineAt: Date.now() + parentTimeoutMs });
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result).toEqual(new Map());
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, complete: false });
    finish(okResponse({ input_tokens: 400 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(new Map());
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: 0.4, complete: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not request or count usage when already cancelled or expired", async () => {
    const { jev, budget } = budgetedAgent();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    expect(await jev.score([cand("TokA")], { signal: controller.signal })).toEqual(new Map());
    expect(await jev.score([cand("TokA")], { deadlineAt: Date.now() })).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({ calls: 0, estimatedCostUsd: 0 });
  });

  it("propagates parent cancellation to fetch and leaves unknown usage incomplete", async () => {
    vi.useFakeTimers();
    const { jev, budget } = budgetedAgent();
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const pending = jev.score([cand("TokA")], { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    controller.abort();
    expect(await pending).toEqual(new Map());
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, complete: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a non-abortable response-body read and discards its late reviews", async () => {
    vi.useFakeTimers();
    const { jev, budget } = budgetedAgent();
    const controller = new AbortController();
    const response = new Response();
    let finish!: (body: unknown) => void;
    const json = vi.spyOn(response, "json").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    const pending = jev.score([cand("TokA")], { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalledTimes(1);
    controller.abort();
    const result = await pending;
    expect(result).toEqual(new Map());
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, complete: false });
    finish({ answers: { s0: { score: 5 } }, usage: { input_tokens: 300 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(new Map());
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: 0.3, complete: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])("bounds stalled success/error response bodies (HTTP %s)", async (status) => {
    vi.useFakeTimers();
    const { jev, budget } = budgetedAgent();
    const response = new Response(null, { status });
    const read = vi.spyOn(response, status === 200 ? "json" : "text").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    const pending = jev.score([cand("TokA")], { deadlineAt: Date.now() + 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await pending).toEqual(new Map());
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, complete: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
