import { describe, it, expect, vi, afterEach } from "vitest";
import { AiVetoAgent, parseChatCompletion, type AiCandidate } from "../ai-agent.js";
import { AiBudget } from "../ai-budget.js";
import { CHAIN_VALUES, createLogger, type AIConfig } from "@autonomous-trader/shared";

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
  vi.useRealTimers();
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
    expect(offered[0]).toMatchObject({ function: { parameters: {
      required: ["token", "chain"], properties: { chain: { type: "string", enum: [...CHAIN_VALUES] } },
    } } });

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

  it.each(["ton", "bsc", "base", "solana"] as const)("keeps veto tools on candidate chain %s despite invalid model routing", async (chain) => {
    const tool = vi.fn().mockResolvedValue({ status: "UNKNOWN" });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(toolCallResponse("getSecurityAnalysis", '{"token":"TokenXXX","chain":"not-a-chain"}'))
      .mockResolvedValueOnce(okResponse('{"verdict":"APPROVE","confidence":0.5,"reason":"no verified flags"}'));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }), { getSecurityAnalysis: tool });
    expect((await agent.veto({ ...candidate(), chain })).verdict).toBe("APPROVE");
    expect(tool).toHaveBeenCalledWith("TokenXXX", chain);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not share a cached verdict for the same address on different chains", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse('{"verdict":"REJECT","confidence":1,"reason":"verified flag"}'))
      .mockResolvedValueOnce(okResponse('{"verdict":"APPROVE","confidence":0.5,"reason":"different chain"}'));
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    expect((await agent.veto({ ...candidate(), chain: "bsc" })).verdict).toBe("REJECT");
    expect((await agent.veto({ ...candidate(), chain: "base" })).verdict).toBe("APPROVE");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("checks the shared budget before another paid tool round", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(toolCallResponse("getMarketSnapshot", "{}"));
    const agent = new AiVetoAgent(cfg({ costPer1kTokensUsd: 1, maxCostPerDayUsd: 0.1 }), createLogger({ t: "test" }), {
      getMarketSnapshot: vi.fn().mockResolvedValue({ priceUsd: 1 }),
    });
    const result = await agent.veto(candidate());
    expect(result).toMatchObject({ verdict: "UNKNOWN" });
    expect(result.reason).toContain("cost cap");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds a non-abortable model call, accounts late usage, and never publishes its late verdict", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const config = cfg({ timeoutMs: 20, costPer1kTokensUsd: 1 });
    const log = createLogger({ t: "test" });
    const budget = new AiBudget(config, log);
    const agent = new AiVetoAgent(config, log, {}, budget);
    const pending = agent.veto(candidate());
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ verdict: "UNKNOWN", reason: "timeout" });
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: null, complete: false });
    finish(okResponse('{"verdict":"REJECT","confidence":1,"reason":"late"}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(budget.snapshot()).toMatchObject({ calls: 1, estimatedCostUsd: 0.15, complete: true });
    expect((await agent.veto(candidate())).verdict).toBe("UNKNOWN");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung tool and stops before any subsequent tool or paid request", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const history = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const market = vi.fn().mockResolvedValue({ priceUsd: 1 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [
        { id: "one", type: "function", function: { name: "getMarketHistory", arguments: "{}" } },
        { id: "two", type: "function", function: { name: "getMarketSnapshot", arguments: "{}" } },
      ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    })));
    const agent = new AiVetoAgent(cfg({ timeoutMs: 20 }), createLogger({ t: "test" }), { getMarketHistory: history, getMarketSnapshot: market });
    const pending = agent.veto(candidate());
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ verdict: "UNKNOWN", reason: "timeout" });
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(history).toHaveBeenCalledTimes(1);
    expect(market).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not make a paid request when its parent is already cancelled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    const agent = new AiVetoAgent(cfg(), createLogger({ t: "test" }));
    expect((await agent.veto(candidate(), { signal: controller.signal })).verdict).toBe("UNKNOWN");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("parseChatCompletion", () => {
  it("parses plain JSON bodies", () => {
    const r = parseChatCompletion('{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}');
    expect(r.choices?.[0]?.message?.content).toBe("hi");
    expect(r.usage?.completion_tokens).toBe(2);
  });

  it("strips a trailing SSE terminator appended to a JSON body", () => {
    const body = '{"choices":[{"message":{"content":"{\\"verdict\\":\\"REJECT\\"}"}}]}\n\ndata: [DONE]\n\n';
    expect(parseChatCompletion(body).choices?.[0]?.message?.content).toBe('{"verdict":"REJECT"}');
  });

  it("folds an SSE chunk stream into one message with usage", () => {
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"{\\"ver"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"dict\\":\\"APPROVE\\"}"}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":7}}',
      'data: [DONE]',
    ].join("\n\n");
    const r = parseChatCompletion(stream);
    expect(r.choices?.[0]?.message?.content).toBe('{"verdict":"APPROVE"}');
    expect(r.usage?.prompt_tokens).toBe(9);
  });

  it("merges streamed tool_calls by index", () => {
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"getMarketSnapshot","arguments":""}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"token\\":\\"A\\"}"}}]}}]}',
      'data: [DONE]',
    ].join("\n\n");
    const tc = parseChatCompletion(stream).choices?.[0]?.message?.tool_calls;
    expect(tc?.[0]).toMatchObject({ id: "call_1" });
    expect(tc?.[0]?.function).toMatchObject({ name: "getMarketSnapshot", arguments: '{"token":"A"}' });
  });

  it("yields empty content for a stream of unparseable chunks", () => {
    expect(parseChatCompletion("data: not-json\n\ndata: [DONE]").choices?.[0]?.message?.content).toBe("");
  });

  it("throws on an unparseable JSON body", () => {
    expect(() => parseChatCompletion("{bad json")).toThrow();
  });
});
