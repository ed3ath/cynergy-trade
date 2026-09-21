import { describe, it, expect, vi, afterEach } from "vitest";
import { AiTraderAgent, type AiTraderSnapshot } from "../ai-trader-agent.js";
import { AiBudget } from "../ai-budget.js";
import { createLogger, type AIConfig } from "@autonomous-trader/shared";

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
    recentTrades: [{ token: "TokenBBB", pnlUsd: -3, pnlPct: -8 }],
  };
}

function okResponse(content: string, usage = { prompt_tokens: 100, completion_tokens: 50 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
}

function agent(c: AIConfig = cfg()): AiTraderAgent {
  const log = createLogger({ t: "test" });
  return new AiTraderAgent(c, log, new AiBudget(c, log));
}

afterEach(() => {
  vi.restoreAllMocks();
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
        choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "getMarketSnapshot", arguments: '{"token":"TokC"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })))
      .mockResolvedValueOnce(okResponse('{"actions":[],"summary":"checked"}'));
    const tool = vi.fn().mockResolvedValue({ priceUsd: 0.5 });
    const log = createLogger({ t: "test" });
    const a = new AiTraderAgent(cfg(), log, new AiBudget(cfg(), log), { getMarketSnapshot: tool });
    const result = await a.propose(snapshot());
    expect(result.summary).toBe("checked");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(tool).toHaveBeenCalledWith("TokC", "solana"); // default chain fallback
  });
});
