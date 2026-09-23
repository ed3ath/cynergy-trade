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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JevAgent", () => {
  it("maps noul answers to chain:token scores and tracks input-token cost", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "jev-latest",
      answers: {
        c0: { type: "noul", noul: 0.9 },
        c1: { type: "noul", noul: 0.2 },
      },
      usage: { input_tokens: 400, output_tokens: 0 },
    })));
    const scores = await agent().score([cand("TokA"), cand("TokB", "ton")]);
    expect(scores.get("solana:TokA")).toBe(0.9);
    expect(scores.get("ton:TokB")).toBe(0.2);

    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      questions: Record<string, { type: string }>;
    };
    expect(Object.keys(body.questions)).toEqual(["c0", "c1"]);
    expect(body.questions["c0"]!.type).toBe("noul");
  });

  it("clamps out-of-range noul values into 0–1", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      answers: { c0: { type: "noul", noul: 1.7 }, c1: { type: "noul", noul: -0.3 } },
    })));
    const scores = await agent().score([cand("TokA"), cand("TokB")]);
    expect(scores.get("solana:TokA")).toBe(1);
    expect(scores.get("solana:TokB")).toBe(0);
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
    // cap enforced only when costPer1k > 0
    const c = cfg({ costPer1kTokensUsd: 1, maxCostPerDayUsd: 0.001 });
    const log = createLogger({ t: "test" });
    const budget = new AiBudget(c, log);
    budget.trackCost({ prompt_tokens: 10_000 }); // blows the tiny cap
    expect(await new JevAgent(c, log, budget).score([cand("TokA")])).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops answers with non-numeric noul instead of trusting them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      answers: { c0: { type: "noul", noul: "high" }, c1: { type: "noul" } },
    })));
    const scores = await agent().score([cand("TokA"), cand("TokB")]);
    expect(scores.size).toBe(0);
  });
});
