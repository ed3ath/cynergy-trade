/**
 * AI veto agent — optional LLM second opinion on strategy ENTER signals.
 * Talks to any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, OpenRouter, Ollama/vLLM, gateways) via plain fetch.
 *
 * The agent's "skills" are read-only data tools (function calling): it can
 * pull fresh market/security/liquidity snapshots and price history for the
 * candidate it is reviewing. It gets NO trade-action tools — it can only
 * veto; the risk engine remains the firewall around money (CLAUDE.md).
 *
 * Firewall contract:
 * - VETO-ONLY: it can reject a candidate; it can never approve one. APPROVE
 *   means "no objection" — the risk engine still gates everything after it.
 * - Any failure (network, timeout, non-200, malformed response, tool error)
 *   maps to UNKNOWN → no veto, candidate proceeds through the normal gates.
 *   An unreachable AI must never become an unreachable trader.
 * - Verdicts are cached per token so the 10s decision loop doesn't re-ask
 *   about the same candidate every tick.
 * - The whole multi-round tool exchange runs under ONE deadline
 *   (ai.timeoutMs), so tool loops can't stall the decision cycle.
 */
import { CHAIN_VALUES, type AIConfig, type Chain, type Logger } from "@autonomous-trader/shared";
import { AiBudget } from "./ai-budget.js";

export type AiVerdictType = "APPROVE" | "REJECT" | "UNKNOWN";

export interface AiVerdict {
  tokenAddress: string;
  verdict: AiVerdictType;
  confidence: number;
  reason: string;
}

/** Narrow structural view of a TokenCandidate — keeps this module decoupled
 *  from the scanner package (type-only compatibility). Scanner candidates
 *  carry scores; copy-trade candidates carry signalContext instead. */
export interface AiCandidate {
  tokenAddress: string;
  chain: Chain;
  /** Display symbol when the liquidity provider exposed it — context for the
   *  AI/classifier (recognizing majors), display only. */
  symbol?: string | null;
  market?: { priceUsd: number; marketCapUsd?: number; volumeUsd5m: number; volumeUsd1h: number; priceChange5m: number; priceChange1h: number; buyVolumeUsd1m: number; sellVolumeUsd1m: number; uniqueBuyers1m: number; uniqueSellers1m: number };
  liquidity?: { liquidityUsd: number; poolAgeMs: number; estimatedSlippageBps500: number; liquidityChange5m: number };
  holders?: { totalHolders: number; top10Pct: number; creatorPct: number; insiderPct: number; sniperPct: number; bundlerPct: number };
  security?: { status: string; score: number; reasons: { message: string }[] };
  scores?: { opportunity: number; security: number; momentum: number; risk: number };
  /** Where this candidate came from, when not a scanner candidate —
   *  e.g. "copy-trade BUY by tracked wallet X". */
  signalContext?: string;
  /** Auto-mode advisory: what the deterministic strategy ensemble said about
   *  this token on the last tick — guidance for the AI's decision, never a
   *  gate. Absent for tokens the ensemble hasn't evaluated. */
  strategyViews?: { strategyId: string; decision: string; confidence: number; reasons: string[] }[];
  /** Jev-ai classifier second opinion: 0–1 entry score from an independent
   *  rug/momentum review. Guidance like scores/strategyViews — never a gate;
   *  the host also damps ENTER sizing confidence by it. Absent when Jev is
   *  disabled, failed, or unscored. */
  jevScore?: number;
}

/** Read-only data tools the agent may call. All optional — only the ones the
 *  host wires up are offered to the model. Tool errors are returned to the
 *  model as strings; they never throw out of the exchange. */
export interface AiToolContext {
  getMarketSnapshot?(token: string, chain: Chain): Promise<unknown>;
  getSecurityAnalysis?(token: string, chain: Chain): Promise<unknown>;
  getLiquiditySnapshot?(token: string, chain: Chain): Promise<unknown>;
  getMarketHistory?(token: string, chain: Chain): Promise<unknown>;
}

const CACHE_TTL_MS = 10 * 60_000; // one verdict per token per 10 min
const MAX_TOOL_ROUNDS = 3;        // ponytail: raise if agents need deeper research
const TOOL_RESULT_MAX_CHARS = 4_000;

const SYSTEM_PROMPT =
  "You are a conservative risk reviewer for micro-cap token trades on Solana/TON/EVM chains. " +
  "You receive one candidate that already passed quantitative strategy and risk screens. " +
  "Your ONLY job is to spot red flags the numbers missed: obvious rug patterns, honeypot hints, " +
  "wash-traded volume, bundler/sniper dominance, manipulated holder counts. " +
  "You may call the provided read-only data tools to refresh or deepen your view of the candidate " +
  "(fresh snapshots, price history) before deciding — use them when the supplied data looks stale, " +
  "contradictory, or suspicious. " +
  "Tools always review the candidate's chain. Provider errors, missing pairs, and unknown data " +
  "are missing evidence, not verified liquidity collapse or a rug. " +
  "Default to APPROVE unless you see a concrete, evidence-based red flag in the data. " +
  "Respond with STRICT JSON only, no markdown fences: " +
  '{"verdict":"APPROVE"|"REJECT","confidence":<number 0-1>,"reason":"<one short sentence>"}';

// ─── OpenAI-compatible wire types (shared with ai-trader-agent) ───────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatResponse {
  choices?: { message?: ChatMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface AiConversationOptions {
  signal?: AbortSignal;
  /** Optional earlier deadline supplied by the snapshot/proposal task. */
  deadlineAt?: number;
}

/** Race the entire exchange, not just fetch: tools and response bodies may ignore abort.
 * Every continuation must check before starting more work or returning a proposal. */
export async function withAiDeadline<T>(
  timeoutMs: number,
  options: AiConversationOptions,
  run: (signal: AbortSignal, check: () => void) => Promise<T>,
): Promise<T> {
  const deadlineAt = Math.min(Date.now() + timeoutMs, options.deadlineAt ?? Infinity);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deadlineAt) ||
      deadlineAt <= Date.now() || options.signal?.aborted) {
    throw new DOMException("AI deadline exceeded or cancelled", "AbortError");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const check = () => {
    if (Date.now() >= deadlineAt) abort();
    controller.signal.throwIfAborted();
  };
  let rejectOnAbort: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(new DOMException("AI deadline exceeded or cancelled", "AbortError"));
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, deadlineAt - Date.now());
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { check(); return run(controller.signal, check); }),
      stopped,
    ]);
    check();
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectOnAbort!);
  }
}

/**
 * Parse an OpenAI-compatible chat-completions body. Tolerates two gateway
 * quirks seen in the wild (local multi-model routers): `data: [DONE]`
 * appended after a plain JSON body, and SSE chunk streams returned even
 * when `stream` was not requested. Throws when nothing parseable remains —
 * callers map that to UNKNOWN/empty per the failure discipline.
 */
export function parseChatCompletion(text: string): ChatResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    // some gateways append the SSE terminator to non-stream JSON bodies
    const end = trimmed.lastIndexOf("}");
    return JSON.parse(end > 0 ? trimmed.slice(0, end + 1) : trimmed) as ChatResponse;
  }
  // SSE stream: fold deltas into one completion
  const msg: ChatMessage = { role: "assistant", content: "" };
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  let usage: ChatResponse["usage"];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let chunk: {
      choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      usage?: ChatResponse["usage"];
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string") msg.content = (msg.content ?? "") + delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? toolCalls.length;
      const slot = toolCalls[i] ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      toolCalls[i] = slot;
    }
  }
  const filled = toolCalls.filter((tc) => tc.function.name.length > 0);
  if (filled.length > 0) msg.tool_calls = filled;
  const response: ChatResponse = { choices: [{ message: msg }] };
  if (usage) response.usage = usage;
  return response;
}

export interface ToolDef {
  type: "function";
  function: { name: keyof AiToolContext; description: string; parameters: Record<string, unknown> };
}

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    token: { type: "string", description: "Token mint/address" },
    chain: { type: "string", enum: [...CHAIN_VALUES], description: "Chain containing this token" },
  },
  required: ["token", "chain"],
};

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "getMarketSnapshot",
      description: "Fetch a FRESH market snapshot for the token right now: price, market cap, volumes, price changes, buyer/seller counts.",
      parameters: TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "getSecurityAnalysis",
      description: "Fetch a FRESH on-chain security analysis: honeypot/rug flags, mint authority, freeze authority, LP lock status.",
      parameters: TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "getLiquiditySnapshot",
      description: "Fetch a FRESH liquidity snapshot: pool liquidity USD, pool age, slippage estimates, recent liquidity changes.",
      parameters: TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "getMarketHistory",
      description: "Recent historical market snapshots for the token (price/volume over time) — use to verify trend quality and spot pump-and-dump shapes.",
      parameters: TOOL_PARAMETERS,
    },
  },
];

export class AiVetoAgent {
  private readonly cache = new Map<string, { verdict: AiVerdict; expiresAt: number }>();
  private readonly budget: AiBudget;

  constructor(
    private readonly cfg: AIConfig,
    private readonly log: Logger,
    private readonly tools: AiToolContext = {},
    budget?: AiBudget,
  ) {
    this.budget = budget ?? new AiBudget(cfg, log);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Veto check for one candidate. Cached; UNKNOWN on any failure — the caller
   * only acts on REJECT.
   */
  async veto(c: AiCandidate, options: AiConversationOptions = {}): Promise<AiVerdict> {
    const cacheKey = `${c.chain}:${c.tokenAddress}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.verdict;

    const verdict = this.cfg.provider === "mock"
      ? { tokenAddress: c.tokenAddress, verdict: "APPROVE" as AiVerdictType, confidence: 1, reason: "mock provider" }
      : await this.exchange(c, options);

    this.cache.set(cacheKey, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
    return verdict;
  }

  /** The full multi-round conversation: prompt → optional tool calls → verdict.
   *  One absolute deadline covers every round. */
  private async exchange(c: AiCandidate, options: AiConversationOptions): Promise<AiVerdict> {
    const unknown = (reason: string): AiVerdict =>
      ({ tokenAddress: c.tokenAddress, verdict: "UNKNOWN", confidence: 0, reason });

    if (this.budget.overCostCap()) return unknown("daily AI cost cap reached — no veto");

    try {
      return await withAiDeadline(this.cfg.timeoutMs, options, async (signal, check) => {
        const messages: ChatMessage[] = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(this.payload(c)) },
        ];
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          check();
          if (this.budget.overCostCap()) return unknown("daily AI cost cap reached - no veto");
          const body = await this.request(c.tokenAddress, messages, signal);
          check();

          const msg = body.choices?.[0]?.message;
          const calls = msg?.tool_calls ?? [];
          if (calls.length > 0 && round < MAX_TOOL_ROUNDS) {
            messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
            for (const tc of calls) {
              check();
              const content = await this.runTool(tc, c);
              check();
              messages.push({ role: "tool", tool_call_id: tc.id, content });
            }
            continue;
          }

          return this.parse(msg?.content, c.tokenAddress) ?? unknown("malformed AI response");
        }
        return unknown("no final verdict after tool rounds");
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.log.warn("AI veto call error", { token: c.tokenAddress, error: e.message });
      return unknown(e.name === "AbortError" ? "timeout" : "network error");
    }
  }

  private async request(token: string, messages: ChatMessage[], signal: AbortSignal): Promise<ChatResponse> {
    const acknowledge = this.budget.beginRequest();
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        // reasoning models spend tokens on thinking before the JSON -
        // 200 truncated every verdict to empty content (finish_reason length)
        max_tokens: 2000,
        messages,
        ...this.toolField(),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
      this.log.warn("AI veto call failed", { status: res.status, token, error: detail });
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = parseChatCompletion(await res.text());
    acknowledge(body.usage);
    return body;
  }

  /** `tools` only when enabled AND at least one tool is actually wired. */
  private toolField(): { tools?: ToolDef[] } {
    if (!this.cfg.toolsEnabled) return {};
    const tools = TOOL_DEFS.filter((t) => typeof this.tools[t.function.name] === "function");
    return tools.length > 0 ? { tools } : {};
  }

  /** Execute one tool call. Never throws — errors go back to the model as text. */
  private async runTool(tc: NonNullable<ChatMessage["tool_calls"]>[number], c: AiCandidate): Promise<string> {
    const name = tc.function.name as keyof AiToolContext;
    const fn = this.tools[name];
    if (!this.cfg.toolsEnabled || !TOOL_DEFS.some((t) => t.function.name === name) || typeof fn !== "function") return `error: unknown tool ${tc.function.name}`;
    let args: { token?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(tc.function.arguments || "{}");
      if (parsed && typeof parsed === "object") args = parsed;
    } catch {
      // malformed arguments → fall back to the candidate token
    }
    const token = typeof args.token === "string" && args.token.trim().length > 0 ? args.token.trim() : c.tokenAddress;
    try {
      const result = await fn(token, c.chain);
      const text = JSON.stringify(result ?? null);
      return text.length > TOOL_RESULT_MAX_CHARS ? text.slice(0, TOOL_RESULT_MAX_CHARS) : text;
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Extract the JSON object from the reply. Tolerates ```json fences. */
  private parse(content: string | null | undefined, tokenAddress: string): AiVerdict | null {
    if (!content) return null;
    const match = content.match(/\{[\s\S]*\}/); // first {...} block
    if (!match) return null;
    let parsed: { verdict?: unknown; confidence?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
    if (parsed.verdict !== "APPROVE" && parsed.verdict !== "REJECT") return null;
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0;
    return {
      tokenAddress,
      verdict: parsed.verdict,
      confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "",
    };
  }

  private payload(c: AiCandidate): Record<string, unknown> {
    const m = c.market, l = c.liquidity, h = c.holders, s = c.security, sc = c.scores;
    return {
      token: c.tokenAddress,
      chain: c.chain,
      signalContext: c.signalContext,
      priceUsd: m?.priceUsd,
      marketCapUsd: m?.marketCapUsd,
      volumeUsd: { m5: m?.volumeUsd5m, h1: m?.volumeUsd1h },
      priceChangePct: { m5: m?.priceChange5m, h1: m?.priceChange1h },
      buySellVolume1m: { buy: m?.buyVolumeUsd1m, sell: m?.sellVolumeUsd1m, uniqueBuyers: m?.uniqueBuyers1m, uniqueSellers: m?.uniqueSellers1m },
      liquidity: l ? { usd: l.liquidityUsd, poolAgeMin: Math.round(l.poolAgeMs / 60_000), slippageBps500: l.estimatedSlippageBps500, change5mPct: l.liquidityChange5m } : undefined,
      holders: h ? { total: h.totalHolders, top10Pct: h.top10Pct, creatorPct: h.creatorPct, insiderPct: h.insiderPct, sniperPct: h.sniperPct, bundlerPct: h.bundlerPct } : undefined,
      security: s ? { status: s.status, score: s.score, reasons: s.reasons.map((r) => r.message) } : undefined,
      strategyScores: sc ? { opportunity: sc.opportunity, security: sc.security, momentum: sc.momentum, risk: sc.risk } : undefined,
    };
  }
}
