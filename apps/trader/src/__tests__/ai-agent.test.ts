import { describe, it, expect, vi, afterEach } from "vitest";
import { AiVetoAgent, type AiCandidate } from "../ai-agent.js";
import { createLogger, type AIConfig } from "@autonomous-trader/shared";

function candidate(): AiCandidate {
  return {
    tokenAddress: "TokenXXX",
    chain: "solana",
    market: { priceUsd: 0.001, marketCapUsd: 250_000, volumeUsd5m: 12_000, volumeUsd1h: 80_000, priceChange5m: 8, priceChange1h: 25, buyVolumeUsd1m: 3000, sellVolumeUsd1m: 1500, uniqueBuyers1m: 40, uniqueSellers1m: 20 },
    liquidity: { liquidityUsd: 90_000, poolAgeMs: 900_000, estimatedSlippageBps500: 120, liquidityChange5m: 2 },
    holders: { totalHolders: 300, top10Pct: 40, creatorPct: 5, insiderPct: 8, sniperPct: 4, bundlerPct: 2 },
    security: { status: "SAFE", score: 82, reasons: [{ message: "no flags" }] },
    scores: { opportunity: 71, security: 82, momentum: 66, risk: 70 },
  };
}

function cfg(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    enabled: true,
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    maxCandidatesPerCycle: 10,
    maxCostPerDayUsd: 5,
    costPer1kTokensUsd: 0,
    timeoutMs: 1000,
    toolsEnabled: true,
    ...overrides,
  } as AIConfig;
}

function okResponse(content: string, usage = { prompt_tokens: 100, completion_tokens: 50 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AiVetoAgent", () => {
  it("mock provider approves without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const agent = new AiVetoAgent(cfg({ provider: "mock" }), createLogger({ t: "test" }));
    const v = await agent.veto(candidate());
    expect(v.verdict).toBe("APPROVE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses a REJECT verdict and rejects the candidate", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse('{"verdict":"REJECT","confidence":0.8,"reason":"sniper dominance"}'));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    const v = await agent.veto(candidate());
    expect(v).toMatchObject({ verdict: "REJECT", confidence: 0.8, reason: "sniper dominance" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps malformed JSON to UNKNOWN — never a veto, never an approval claim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse("I think this looks bad, sorry!"));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    expect((await agent.veto(candidate())).verdict).toBe("UNKNOWN");
  });

  it("maps network failure to UNKNOWN", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    expect((await agent.veto(candidate())).verdict).toBe("UNKNOWN");
  });

  it("maps non-200 to UNKNOWN", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    expect((await agent.veto(candidate())).verdict).toBe("UNKNOWN");
  });

  it("maps timeout (abort) to UNKNOWN", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }));
    const agent = new AiVetoAgent(cfg({ timeoutMs: 20 }), createLogger({ t: "test" }));
    expect((await agent.veto(candidate())).verdict).toBe("UNKNOWN");
  });

  it("accepts fenced JSON responses", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse('```json\n{"verdict":"APPROVE","confidence":0.6,"reason":"clean"}\n```'));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    expect((await agent.veto(candidate())).verdict).toBe("APPROVE");
  });

  it("rejects a response whose verdict field is not APPROVE/REJECT", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse('{"verdict":"MAYBE","confidence":0.5,"reason":"x"}'));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    expect((await agent.veto(candidate())).verdict).toBe("UNKNOWN");
  });

  it("caches verdicts — second veto for the same token makes no call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse('{"verdict":"APPROVE","confidence":0.9,"reason":"ok"}'));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    await agent.veto(candidate());
    await agent.veto(candidate());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stops calling once the daily cost cap is exceeded (UNKNOWN, no veto)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => okResponse('{"verdict":"APPROVE","confidence":0.9,"reason":"ok"}'));
    // 150 tokens/call at $100 per 1k → $15/call, cap $10 → second call blocked
    const agent = new AiVetoAgent(cfg({ costPer1kTokensUsd: 100, maxCostPerDayUsd: 10 }), createLogger({ t: "test" }));
    const c1 = candidate(); c1.tokenAddress = "TokenA";
    const c2 = candidate(); c2.tokenAddress = "TokenB";
    await agent.veto(c1);
    const v2 = await agent.veto(c2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(v2.verdict).toBe("UNKNOWN");
  });

  it("sends the auth header and candidate payload to the configured baseUrl", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse('{"verdict":"APPROVE","confidence":0.9,"reason":"ok"}'));
    const agent = new AiVetoAgent(cfg({ baseUrl: "https://gw.example.com/v1/" }), createLogger({ t: "test" }));
    await agent.veto(candidate());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.example.com/v1/chat/completions"); // trailing slash normalized
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("test-model");
    expect(JSON.stringify(body.messages)).toContain("TokenXXX");
  });

  // ─── tool calling ───────────────────────────────────────────────────────────
  function toolCallResponse(name: string, args: string): Response {
    return new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  }

  it("executes requested tools, feeds results back, then parses the final verdict", async () => {
    const history = vi.fn().mockResolvedValue([{ priceUsd: 0.001 }, { priceUsd: 0.0012 }]);
    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call++;
      return call === 1
        ? toolCallResponse("getMarketHistory", JSON.stringify({ token: "TokenXXX" }))
        : okResponse('{"verdict":"REJECT","confidence":0.9,"reason":"classic pump shape"}');
    });
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }), { getMarketHistory: history });
    const v = await agent.veto(candidate());

    expect(v).toMatchObject({ verdict: "REJECT", reason: "classic pump shape" });
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith("TokenXXX", "solana");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // second request carries the assistant tool_call + tool result messages
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(String(secondInit.body));
    const roles = secondBody.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(secondBody.messages[3].tool_call_id).toBe("call_1");
    expect(secondBody.messages[3].content).toContain("0.0012");
  });

  it("offers tools in the request only when the host wired them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => okResponse('{"verdict":"APPROVE","confidence":0.9,"reason":"ok"}'));
    const withTools = new AiVetoAgent(cfg(), createLogger({ t: "test" }), { getSecurityAnalysis: vi.fn() });
    await withTools.veto(candidate());
    const [, firstInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const offered = JSON.parse(String(firstInit.body)).tools as { function: { name: string } }[];
    expect(offered.map((t: { function: { name: string } }) => t.function.name)).toEqual(["getSecurityAnalysis"]);

    fetchSpy.mockClear();
    const bare = new AiVetoAgent(cfg(), createLogger({ t: "test" })); // no context
    await bare.veto(candidate());
    const [, bareInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(bareInit.body))).not.toHaveProperty("tools");
  });

  it("respects toolsEnabled=false — no tools field even when context is wired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => okResponse('{"verdict":"APPROVE","confidence":0.9,"reason":"ok"}'));
    const agent = new AiVetoAgent(cfg({ toolsEnabled: false }), createLogger({ t: "test" }), { getMarketSnapshot: vi.fn() });
    await agent.veto(candidate());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("tools");
  });

  it("returns tool errors to the model as text and still completes the exchange", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("provider down"));
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call++;
      return call === 1
        ? toolCallResponse("getSecurityAnalysis", "{}") // malformed args → candidate token fallback
        : okResponse('{"verdict":"APPROVE","confidence":0.5,"reason":"proceeded despite tool failure"}');
    });
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }), { getSecurityAnalysis: failing });
    const v = await agent.veto(candidate());

    expect(v.verdict).toBe("APPROVE");
    expect(failing).toHaveBeenCalledWith("TokenXXX", "solana"); // empty args fell back to candidate
    const [, errInit] = (vi.mocked(globalThis.fetch).mock.calls[1] as [string, RequestInit]);
    const errBody = JSON.parse(String(errInit.body));
    expect(errBody.messages[3].content).toContain("error: provider down");
  });

  it("maps a stuck tool loop (no final verdict) to UNKNOWN", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => toolCallResponse("getMarketSnapshot", '{"token":"TokenXXX"}'));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }), { getMarketSnapshot: vi.fn().mockResolvedValue({ priceUsd: 1 }) });
    expect((await agent.veto(candidate())).verdict).toBe("UNKNOWN");
  });
});
