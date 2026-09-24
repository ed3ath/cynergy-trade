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
      state: string;
      questions: Record<string, { type: string; criteria?: string[] }>;
    };
    expect(Object.keys(body.questions).sort()).toEqual(["mom0", "rug0", "s0"]);
    expect(body.questions["s0"]!.criteria).toHaveLength(6);
    // compact card in a context envelope: shortened address, symbol carried
    const state = JSON.parse(body.state) as { context: string; tokens: { token: string }[] };
    expect(state.context).toContain("STRUCTURAL");
    expect(state.tokens[0]!.token).toBe("TokVer…6789");
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
});
