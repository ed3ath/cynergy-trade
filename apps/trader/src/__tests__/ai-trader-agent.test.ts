import { describe, it, expect, vi, afterEach } from "vitest";
import { AiTraderAgent, type AiTraderSnapshot } from "../ai-trader-agent.js";
import { AiBudget } from "../ai-budget.js";
import { CHAIN_VALUES, createLogger, type AIConfig } from "@autonomous-trader/shared";
import { TOOL_DEFS, type AiToolContext } from "../ai-agent.js";

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
    ...overrides,
  } as AIConfig;
}

function snapshot(): AiTraderSnapshot {
  return {
    portfolio: { totalValueUsd: 1000, availableUsd: 500, dailyPnlUsd: -5, drawdownPct: 2, regime: "solana:RISK_ON", openPositions: 1 },
    positions: [{ positionId: "p1", token: "TokenAAA", chain: "solana", strategyId: "strategy-fresh-momentum", entryPrice: 0.001, currentPrice: 0.0012, pnlPct: 20, ageMin: 15 }],
    candidates: [],
    recentTrades: [{ token: "TokenBBB", chain: "solana", strategyId: "ai-autonomous", pnlUsd: -3, pnlPct: -8, exitReason: "stop", heldMin: 10 }],
  };
}

function okResponse(content: string, usage = { prompt_tokens: 100, completion_tokens: 50 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
}

function toolResponse(args: string, name = "getMarketSnapshot"): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: args } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }));
}

function agent(c: AIConfig = cfg()): AiTraderAgent {
  const log = createLogger({ t: "test" });
  return new AiTraderAgent(c, log, new AiBudget(c, log));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AiTraderAgent", () => {
  it("mock provider proposes nothing and makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await agent(cfg({ provider: "mock" })).propose(snapshot());
    expect(result.actions).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses a valid multi-action response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(
      '{"actions":[' +
      '{"type":"ENTER","tokenAddress":"TokC","chain":"ton","confidence":0.9,"rationale":"momentum breakout","suggestedStopLossPct":8,"suggestedTakeProfitPct":20},' +
      '{"type":"EXIT","tokenAddress":"TokenAAA","chain":"solana","positionId":"p1","rationale":"thesis played out"},' +
      '{"type":"TIGHTEN","tokenAddress":"TokenAAA","chain":"solana","positionId":"p1","tightenStopLossPct":5}],' +
      '"summary":"risk-on, rotating"}'));
    const { actions, summary } = await agent().propose(snapshot());
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ type: "ENTER", tokenAddress: "TokC", chain: "ton", confidence: 0.9, suggestedStopLossPct: 8, suggestedTakeProfitPct: 20 });
    expect(actions[1]).toMatchObject({ type: "EXIT", positionId: "p1" });
    expect(actions[2]).toMatchObject({ type: "TIGHTEN", tightenStopLossPct: 5 });
    expect(summary).toBe("risk-on, rotating");
  });

  it("drops invalid actions and keeps valid ones", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(
      '{"actions":[' +
      '{"type":"ENTER","tokenAddress":"","chain":"solana"},' +
      '{"type":"ENTER","tokenAddress":"TokD","chain":"dogechain"},' +
      '{"type":"HODL","tokenAddress":"TokE","chain":"solana"},' +
      '{"type":"ENTER","tokenAddress":"TokF","chain":"solana","confidence":7}],' +
      '"summary":"s"}'));
    const { actions } = await agent().propose(snapshot());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tokenAddress: "TokF", confidence: 1 }); // clamped to 0-1
  });

  it("caps actions per cycle", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(
      '{"actions":[' +
      '{"type":"ENTER","tokenAddress":"T1","chain":"solana"},' +
      '{"type":"ENTER","tokenAddress":"T2","chain":"solana"},' +
      '{"type":"ENTER","tokenAddress":"T3","chain":"solana"},' +
      '{"type":"ENTER","tokenAddress":"T4","chain":"solana"},' +
      '{"type":"ENTER","tokenAddress":"T5","chain":"solana"}],' +
      '"summary":"s"}'));
    const { actions } = await agent(cfg({ maxActionsPerCycle: 2 })).propose(snapshot());
    expect(actions).toHaveLength(2);
  });

  it("maps malformed JSON to empty actions — never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("buy everything!!"));
    const result = await agent().propose(snapshot());
    expect(result.actions).toEqual([]);
  });

  it("maps network failure to empty actions — never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await agent().propose(snapshot());
    expect(result.actions).toEqual([]);
  });

  it("maps non-200 to empty actions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("overloaded", { status: 503 }));
    const result = await agent().propose(snapshot());
    expect(result.actions).toEqual([]);
  });

  it("maps timeout (abort) to empty actions", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }));
    const result = await agent(cfg({ timeoutMs: 20 })).propose(snapshot());
    expect(result.actions).toEqual([]);
  });

  it("shares the daily cost cap — budget cap yields empty actions with no call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const c = cfg({ costPer1kTokensUsd: 1, maxCostPerDayUsd: 0.15 });
    const log = createLogger({ t: "test" });
    const budget = new AiBudget(c, log);
    budget.trackCost({ prompt_tokens: 100, completion_tokens: 50 }); // 0.15 USD — at cap
    const result = await new AiTraderAgent(c, log, budget).propose(snapshot());
    expect(result.actions).toEqual([]);
    expect(result.summary).toContain("cost cap");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("executes a tool-call round trip before answering", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "getMarketSnapshot", arguments: '{"token":"TokC","chain":"solana"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })))
      .mockResolvedValueOnce(okResponse('{"actions":[],"summary":"checked"}'));
    const tool = vi.fn().mockResolvedValue({ priceUsd: 0.5 });
    const log = createLogger({ t: "test" });
    const a = new AiTraderAgent(cfg(), log, new AiBudget(cfg(), log), { getMarketSnapshot: tool });
    const result = await a.propose(snapshot());
    expect(result.summary).toBe("checked");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(tool).toHaveBeenCalledWith("TokC", "solana");
  });

  it.each(["ton", "bsc", "base", "solana"] as const)("routes all advertised tools explicitly on %s", async (chain) => {
    const tools: AiToolContext = Object.fromEntries(TOOL_DEFS.map((t) => [t.function.name, vi.fn().mockResolvedValue({ observed: true })]));
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: TOOL_DEFS.map((t, i) => ({
          id: `c${i}`, type: "function", function: { name: t.function.name, arguments: JSON.stringify({ token: "TokC", chain }) },
        })) } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
      })))
      .mockResolvedValueOnce(okResponse('{"actions":[],"summary":"checked"}'));
    const config = cfg();
    const log = createLogger({ t: "test" });
    await new AiTraderAgent(config, log, new AiBudget(config, log), tools).propose(snapshot());
    for (const tool of Object.values(tools)) expect(tool).toHaveBeenCalledWith("TokC", chain);
    const offered = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).tools;
    expect(offered).toHaveLength(4);
    for (const tool of offered) expect(tool.function.parameters).toMatchObject({
      required: ["token", "chain"], properties: { chain: { type: "string", enum: [...CHAIN_VALUES] } },
    });
  });

  it.each([{}, { chain: "dogechain" }, { chain: null }, { chain: 1 }, { chain: "" }, { chain: ["solana"] }])(
    "returns a visible error instead of defaulting invalid chain args %j to Solana", async (routing) => {
      const tool = vi.fn();
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(toolResponse(JSON.stringify({ token: "TokC", ...routing })))
        .mockResolvedValueOnce(okResponse('{"actions":[],"summary":"unknown chain"}'));
      const log = createLogger({ t: "test" });
      await new AiTraderAgent(cfg(), log, new AiBudget(cfg(), log), { getMarketSnapshot: tool }).propose(snapshot());
      expect(tool).not.toHaveBeenCalled();
      expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)).messages.at(-1).content).toContain("missing or invalid chain");
    },
  );

  it.each(["null", "[]", "not-json", '{"chain":"ton","token":" "}'])("does not run a tool with malformed arguments %s", async (args) => {
    const tool = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(toolResponse(args))
      .mockResolvedValueOnce(okResponse('{"actions":[],"summary":"no evidence"}'));
    const log = createLogger({ t: "test" });
    await new AiTraderAgent(cfg(), log, new AiBudget(cfg(), log), { getMarketSnapshot: tool }).propose(snapshot());
    expect(tool).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)).messages.at(-1).content).toContain("error:");
  });

  it("checks the cap between paid rounds, not only at the start of a conversation", async () => {
    const config = cfg({ costPer1kTokensUsd: 1, maxCostPerDayUsd: 0.1 });
    const log = createLogger({ t: "test" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(toolResponse('{"token":"TokC","chain":"ton"}'));
    const result = await new AiTraderAgent(config, log, new AiBudget(config, log), { getMarketSnapshot: vi.fn().mockResolvedValue({}) }).propose(snapshot());
    expect(result).toEqual({ actions: [], summary: "daily AI cost cap reached" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds a non-abortable model request and records unknown rather than free usage", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const config = cfg({ timeoutMs: 20, costPer1kTokensUsd: 1 });
    const log = createLogger({ t: "test" });
    const budget = new AiBudget(config, log);
    const pending = new AiTraderAgent(config, log, budget).propose(snapshot());
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result).toEqual({ actions: [], summary: "timeout" });
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, complete: false });
    finish(okResponse('{"actions":[{"type":"ENTER","tokenAddress":"late","chain":"base"}],"summary":"late"}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.actions).toEqual([]);
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: 0.15, complete: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung response body under the same conversation deadline", async () => {
    vi.useFakeTimers();
    const response = new Response();
    vi.spyOn(response, "text").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const pending = agent(cfg({ timeoutMs: 20 })).propose(snapshot());
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ actions: [], summary: "timeout" });
  });

  it("bounds a hung tool, discards late data, and makes no subsequent model call", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const tool = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(toolResponse('{"token":"TokC","chain":"ton"}'));
    const config = cfg({ timeoutMs: 20 });
    const log = createLogger({ t: "test" });
    const pending = new AiTraderAgent(config, log, new AiBudget(config, log), { getMarketSnapshot: tool }).propose(snapshot());
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ actions: [], summary: "timeout" });
    finish({ priceUsd: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it("does not reset the deadline for each sequential tool", async () => {
    vi.useFakeTimers();
    const tool = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ priceUsd: 1 }), 30)));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: ["one", "two"].map((id) => ({
        id, type: "function", function: { name: "getMarketSnapshot", arguments: '{"token":"TokC","chain":"base"}' },
      })) } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    })));
    const config = cfg({ timeoutMs: 50 });
    const log = createLogger({ t: "test" });
    const pending = new AiTraderAgent(config, log, new AiBudget(config, log), { getMarketSnapshot: tool }).propose(snapshot());
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual({ actions: [], summary: "timeout" });
    await vi.advanceTimersByTimeAsync(20);
    expect(tool).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("honors an earlier proposal deadline and parent cancellation", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = agent().propose(snapshot(), { deadlineAt: Date.now() + 20, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).actions).toEqual([]);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const cancelled = agent().propose(snapshot(), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await cancelled).toEqual({ actions: [], summary: "timeout" });
    expect(fetchSpy.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    const calls = fetchSpy.mock.calls.length;
    await agent().propose(snapshot(), { signal: controller.signal });
    expect(fetchSpy).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("encourages cost-aware abstention and does not describe provider errors as collapse", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse('{"actions":[],"summary":"abstain"}'));
    await agent().propose(snapshot());
    const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const prompt = request.messages[0].content as string;
    expect(prompt).not.toContain("80%");
    expect(prompt).not.toContain("passing on a good setup loses money");
    expect(prompt).toContain("empty action list is a valid, cost-aware decision");
    expect(prompt).toContain("missing evidence, not verified liquidity collapse");
    expect(request).toMatchObject({ model: "test-model", temperature: 0, max_tokens: 4000 });
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer sk-test" });
  });

  it("keeps absent provider usage incomplete even after a successful final response", async () => {
    const log = createLogger({ t: "test" });
    const config = cfg({ costPer1kTokensUsd: 1 });
    const budget = new AiBudget(config, log);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"actions":[],"summary":"wait"}' } }] })));
    await new AiTraderAgent(config, log, budget).propose(snapshot());
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, complete: false });
  });
});
