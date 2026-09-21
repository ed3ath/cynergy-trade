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
import type { AIConfig, Chain, Logger } from "@autonomous-trader/shared";
import { AiBudget } from "./ai-budget.js";

export type AiVerdictType = "APPROVE" | "REJECT" | "UNKNOWN";

export interface AiVerdict {
  tokenAddress: string;
  verdict: AiVerdictType;
  confidence: number;
  reason: string;
}

/** Narrow structural view of a TokenCandidate — keeps this module decoupled
 *  from the scanner package (type-only compatibility). */
export interface AiCandidate {
  tokenAddress: string;
  chain: Chain;
  market?: { priceUsd: number; marketCapUsd?: number; volumeUsd5m: number; volumeUsd1h: number; priceChange5m: number; priceChange1h: number; buyVolumeUsd1m: number; sellVolumeUsd1m: number; uniqueBuyers1m: number; uniqueSellers1m: number };
  liquidity?: { liquidityUsd: number; poolAgeMs: number; estimatedSlippageBps500: number; liquidityChange5m: number };
  holders?: { totalHolders: number; top10Pct: number; creatorPct: number; insiderPct: number; sniperPct: number; bundlerPct: number };
  security?: { status: string; score: number; reasons: { message: string }[] };
  scores: { opportunity: number; security: number; momentum: number; risk: number };
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
  "You are a brutally conservative risk reviewer for micro-cap token trades on Solana/TON. " +
  "You receive one candidate that already passed quantitative strategy and risk screens. " +
  "Your ONLY job is to spot red flags the numbers missed: obvious rug patterns, honeypot hints, " +
  "wash-traded volume, bundler/sniper dominance, manipulated holder counts. " +
  "You may call the provided read-only data tools to refresh or deepen your view of the candidate " +
  "(fresh snapshots, price history) before deciding — use them when the supplied data looks stale, " +
  "contradictory, or suspicious. " +
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

export interface ToolDef {
  type: "function";
  function: { name: keyof AiToolContext; description: string; parameters: Record<string, unknown> };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "getMarketSnapshot",
      description: "Fetch a FRESH market snapshot for the token right now: price, market cap, volumes, price changes, buyer/seller counts.",
      parameters: { type: "object", properties: { token: { type: "string", description: "Token mint/address" } }, required: ["token"] },
    },
  },
  {
    type: "function",
    function: {
      name: "getSecurityAnalysis",
      description: "Fetch a FRESH on-chain security analysis: honeypot/rug flags, mint authority, freeze authority, LP lock status.",
      parameters: { type: "object", properties: { token: { type: "string", description: "Token mint/address" } }, required: ["token"] },
    },
  },
  {
    type: "function",
    function: {
      name: "getLiquiditySnapshot",
      description: "Fetch a FRESH liquidity snapshot: pool liquidity USD, pool age, slippage estimates, recent liquidity changes.",
      parameters: { type: "object", properties: { token: { type: "string", description: "Token mint/address" } }, required: ["token"] },
    },
  },
  {
    type: "function",
    function: {
      name: "getMarketHistory",
      description: "Recent historical market snapshots for the token (price/volume over time) — use to verify trend quality and spot pump-and-dump shapes.",
      parameters: { type: "object", properties: { token: { type: "string", description: "Token mint/address" } }, required: ["token"] },
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
  async veto(c: AiCandidate): Promise<AiVerdict> {
    const cached = this.cache.get(c.tokenAddress);
    if (cached && cached.expiresAt > Date.now()) return cached.verdict;

    const verdict = this.cfg.provider === "mock"
      ? { tokenAddress: c.tokenAddress, verdict: "APPROVE" as AiVerdictType, confidence: 1, reason: "mock provider" }
      : await this.exchange(c);

    this.cache.set(c.tokenAddress, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
    return verdict;
  }

  /** The full multi-round conversation: prompt → optional tool calls → verdict.
   *  One absolute deadline covers every round. */
  private async exchange(c: AiCandidate): Promise<AiVerdict> {
    const unknown = (reason: string): AiVerdict =>
      ({ tokenAddress: c.tokenAddress, verdict: "UNKNOWN", confidence: 0, reason });

    if (this.budget.overCostCap()) return unknown("daily AI cost cap reached — no veto");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(this.payload(c)) },
    ];
    const deadline = Date.now() + this.cfg.timeoutMs;

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return unknown("deadline exceeded");

        const body = await this.request(c.tokenAddress, messages, remaining);
        this.budget.trackCost(body.usage);

        const msg = body.choices?.[0]?.message;
        const calls = msg?.tool_calls ?? [];
        if (calls.length > 0 && round < MAX_TOOL_ROUNDS) {
          messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
          for (const tc of calls) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: await this.runTool(tc, c) });
          }
          continue; // model re-answers with the tool results in context
        }

        // Final round or no tool calls: content must hold the verdict
        return this.parse(msg?.content, c.tokenAddress) ?? unknown("malformed AI response");
      }
      return unknown("no final verdict after tool rounds");
    } catch (err) {
      const e = err as Error;
      this.log.warn("AI veto call error", { token: c.tokenAddress, error: e.message });
      return unknown(e.name === "AbortError" ? "timeout" : "network error");
    }
  }

  private async request(token: string, messages: ChatMessage[], timeoutMs: number): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0,
          max_tokens: 200,
          messages,
          ...this.toolField(),
        }),
      });
      if (!res.ok) {
        this.log.warn("AI veto call failed", { status: res.status, token });
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as ChatResponse;
    } finally {
      clearTimeout(timer);
    }
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
    if (typeof fn !== "function") return `error: unknown tool ${tc.function.name}`;
    let args: { token?: unknown } = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}") as { token?: unknown };
    } catch {
      // malformed arguments → fall back to the candidate token
    }
    const token = typeof args.token === "string" && args.token.length > 0 ? args.token : c.tokenAddress;
    try {
      const result = await fn(token, c.chain);
      const text = JSON.stringify(result ?? null);
      return text.length > TOOL_RESULT_MAX_CHARS ? text.slice(0, TOOL_RESULT_MAX_CHARS) : text;
    } catch (err) {
      return `error: ${(err as Error).message}`;
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
    const m = c.market, l = c.liquidity, h = c.holders, s = c.security;
    return {
      token: c.tokenAddress,
      chain: c.chain,
      priceUsd: m?.priceUsd,
      marketCapUsd: m?.marketCapUsd,
      volumeUsd: { m5: m?.volumeUsd5m, h1: m?.volumeUsd1h },
      priceChangePct: { m5: m?.priceChange5m, h1: m?.priceChange1h },
      buySellVolume1m: { buy: m?.buyVolumeUsd1m, sell: m?.sellVolumeUsd1m, uniqueBuyers: m?.uniqueBuyers1m, uniqueSellers: m?.uniqueSellers1m },
      liquidity: l ? { usd: l.liquidityUsd, poolAgeMin: Math.round(l.poolAgeMs / 60_000), slippageBps500: l.estimatedSlippageBps500, change5mPct: l.liquidityChange5m } : undefined,
      holders: h ? { total: h.totalHolders, top10Pct: h.top10Pct, creatorPct: h.creatorPct, insiderPct: h.insiderPct, sniperPct: h.sniperPct, bundlerPct: h.bundlerPct } : undefined,
      security: s ? { status: s.status, score: s.score, reasons: s.reasons.map((r) => r.message) } : undefined,
      strategyScores: { opportunity: c.scores.opportunity, security: c.scores.security, momentum: c.scores.momentum, risk: c.scores.risk },
    };
  }
}
