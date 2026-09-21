/**
 * Autonomous AI trader agent — the AI that actually trades (`AI_AUTONOMY=auto`).
 *
 * Each cycle the host builds a pure-data snapshot (portfolio, open positions,
 * scanner candidates, recent trades); the agent may call the same read-only
 * data tools as the veto agent, then answers with STRICT JSON actions:
 * ENTER / EXIT / TIGHTEN. Every action is host-guarded downstream (risk
 * engine gates all entries; PositionManager.tightenExits is a one-way
 * ratchet) — the model's output can only propose, never bypass.
 *
 * Failure discipline mirrors AiVetoAgent: any timeout / network error /
 * malformed response / cost-cap hit → empty action list. The agent never
 * throws and never blocks the deterministic loop.
 */
import { CHAIN_VALUES, type AIConfig, type Chain, type Logger } from "@autonomous-trader/shared";
import type { AiCandidate, AiToolContext, ChatMessage, ChatResponse } from "./ai-agent.js";
import { TOOL_DEFS, type ToolDef } from "./ai-agent.js";
import { AiBudget } from "./ai-budget.js";

export interface AiAction {
  type: "ENTER" | "EXIT" | "TIGHTEN";
  tokenAddress: string;
  chain: Chain;
  /** ENTER: 0–1 conviction → risk-engine strategyConfidence (sizing input only). */
  confidence?: number;
  /** ENTER: copy-trade hold profile — sets the exit envelope (default shortterm). */
  profile?: "scalp" | "shortterm";
  rationale?: string;
  /** ENTER: pct below entry price for the hard stop (default 10). */
  suggestedStopLossPct?: number;
  /** ENTER: pct above entry for take-profit (default 5, matching policy). */
  suggestedTakeProfitPct?: number;
  /** EXIT: position id; tokenAddress+chain is the fallback resolver. */
  positionId?: string;
  /** TIGHTEN: pcts relative to entry — clamped tighten-only downstream. */
  tightenStopLossPct?: number;
  tightenTp1Pct?: number;
  tightenTrailingPct?: number;
}

export interface AiTraderCycleResult {
  actions: AiAction[];
  summary: string;
}

/** Pure data built by the host — no live references, no I/O. */
export interface AiTraderSnapshot {
  portfolio: {
    totalValueUsd: number;
    availableUsd: number;
    dailyPnlUsd: number;
    drawdownPct: number;
    regime: string;
    openPositions: number;
  };
  positions: {
    positionId: string;
    token: string;
    chain: Chain;
    strategyId: string;
    entryPrice: number;
    currentPrice: number;
    pnlPct: number;
    ageMin: number;
  }[];
  candidates: AiCandidate[];
  recentTrades: { token: string; pnlUsd: number; pnlPct: number }[];
  /** Recent swaps by tracked high-PNL wallets (copy-trade feed), newest last.
   *  BUYs are candidate entries for the agent's own analysis; SELLs of held
   *  tokens are take-profit hints. */
  copySignals?: {
    token: string;
    chain: Chain;
    side: "BUY" | "SELL";
    symbol: string;
    walletLabel: string;
    ageMin: number;
  }[];
}

const MAX_TOOL_ROUNDS = 3;        // ponytail: raise if the agent needs deeper research
const TOOL_RESULT_MAX_CHARS = 4_000;
const TEXT_MAX = 300;
const STOP_LOSS_PCT: [number, number] = [1, 50];
const TAKE_PROFIT_PCT: [number, number] = [1, 200];
const TRAILING_PCT: [number, number] = [1, 50];

const SYSTEM_PROMPT =
  "You are an autonomous micro-cap token trader on Solana/TON/EVM chains. " +
  "Each cycle you receive a portfolio snapshot: capital, open positions with live PnL, " +
  "top scanner candidates with quantitative scores, recent closed trades, and — when " +
  "copy-trade is on — recent swaps by tracked high-PNL wallets. " +
  "You may call the provided read-only data tools to refresh data on any token before acting. " +
  "You respond with a list of actions, executed only after the deterministic risk engine approves them. " +
  "Rules: never ENTER a token you already hold (copy-trade slots excepted — you may add ONE extra, " +
  "smaller position on a held token when copying a tracked wallet's fresh BUY); every ENTER needs a " +
  "concrete evidence-based thesis — a tracked wallet's BUY is a lead to verify (tools), not a reason " +
  "by itself, and their SELL of a token you hold is a take-profit hint; you may EXIT any position or " +
  "TIGHTEN its exits (raise stop, lower take-profit/trailing) but you can " +
  "never loosen risk; prefer fewer, higher-conviction actions; an empty action list is a valid answer. " +
  "Respond with STRICT JSON only, no markdown fences: " +
  '{"actions":[{"type":"ENTER","tokenAddress":"...","chain":"solana|ton|bsc|base|polygon|arbitrum",' +
  '"confidence":0.0,"rationale":"one short sentence","profile":"scalp|shortterm",' +
  '"suggestedStopLossPct":10,"suggestedTakeProfitPct":5},' +
  '{"type":"EXIT","tokenAddress":"...","chain":"...","positionId":"...","rationale":"..."},' +
  '{"type":"TIGHTEN","tokenAddress":"...","chain":"...","positionId":"...","tightenStopLossPct":5,' +
  '"tightenTp1Pct":3,"tightenTrailingPct":8}],"summary":"one sentence market read"}';

export class AiTraderAgent {
  constructor(
    private readonly cfg: AIConfig,
    private readonly log: Logger,
    private readonly budget: AiBudget,
    private readonly tools: AiToolContext = {},
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** One AI cycle. Empty actions on any failure — never throws. */
  async propose(snapshot: AiTraderSnapshot): Promise<AiTraderCycleResult> {
    if (this.cfg.provider === "mock") return { actions: [], summary: "mock provider" };
    return this.exchange(snapshot);
  }

  /** The full multi-round conversation. One absolute deadline covers every round. */
  private async exchange(snapshot: AiTraderSnapshot): Promise<AiTraderCycleResult> {
    const empty = (summary: string): AiTraderCycleResult => ({ actions: [], summary });

    if (this.budget.overCostCap()) return empty("daily AI cost cap reached");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(snapshot) },
    ];
    const deadline = Date.now() + this.cfg.timeoutMs;

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return empty("deadline exceeded");

        const body = await this.request(messages, remaining);
        this.budget.trackCost(body.usage);

        const msg = body.choices?.[0]?.message;
        const calls = msg?.tool_calls ?? [];
        if (calls.length > 0 && round < MAX_TOOL_ROUNDS) {
          messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
          for (const tc of calls) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: await this.runTool(tc) });
          }
          continue; // model re-answers with the tool results in context
        }

        return this.parse(msg?.content) ?? empty("malformed AI response");
      }
      return empty("no final answer after tool rounds");
    } catch (err) {
      const e = err as Error;
      this.log.warn("AI trader call error", { error: e.message });
      return empty(e.name === "AbortError" ? "timeout" : "network error");
    }
  }

  private async request(messages: ChatMessage[], timeoutMs: number): Promise<ChatResponse> {
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
          max_tokens: 600,
          messages,
          ...this.toolField(),
        }),
      });
      if (!res.ok) {
        this.log.warn("AI trader call failed", { status: res.status });
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
  private async runTool(tc: NonNullable<ChatMessage["tool_calls"]>[number]): Promise<string> {
    const name = tc.function.name as keyof AiToolContext;
    const fn = this.tools[name];
    if (typeof fn !== "function") return `error: unknown tool ${tc.function.name}`;
    let args: { token?: unknown; chain?: unknown } = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}") as { token?: unknown; chain?: unknown };
    } catch {
      // malformed arguments → no token to call with
    }
    const token = typeof args.token === "string" && args.token.length > 0 ? args.token : null;
    if (!token) return "error: missing token argument";
    const chain = (CHAIN_VALUES as readonly string[]).includes(args.chain as string)
      ? (args.chain as Chain)
      : "solana";
    try {
      const result = await fn(token, chain);
      const text = JSON.stringify(result ?? null);
      return text.length > TOOL_RESULT_MAX_CHARS ? text.slice(0, TOOL_RESULT_MAX_CHARS) : text;
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  /** Extract + validate the action list. Tolerates ```json fences.
   *  Invalid actions are dropped individually; a broken envelope is null. */
  private parse(content: string | null | undefined): AiTraderCycleResult | null {
    if (!content) return null;
    const match = content.match(/\{[\s\S]*\}/); // first-to-last {...} block
    if (!match) return null;
    let parsed: { actions?: unknown; summary?: unknown };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed.actions)) return null;

    const actions: AiAction[] = [];
    for (const raw of parsed.actions) {
      const a = this.parseAction(raw);
      if (a) actions.push(a);
      if (actions.length >= this.cfg.maxActionsPerCycle) break;
    }
    return {
      actions,
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, TEXT_MAX) : "",
    };
  }

  private parseAction(raw: unknown): AiAction | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (r["type"] !== "ENTER" && r["type"] !== "EXIT" && r["type"] !== "TIGHTEN") return null;
    const tokenAddress = typeof r["tokenAddress"] === "string" ? r["tokenAddress"].trim() : "";
    if (tokenAddress.length === 0) return null;
    const chain = (CHAIN_VALUES as readonly string[]).includes(r["chain"] as string)
      ? (r["chain"] as Chain)
      : null;
    if (!chain) return null;

    const num = (v: unknown, [lo, hi]: [number, number]): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

    const action: AiAction = { type: r["type"], tokenAddress, chain };
    if (typeof r["rationale"] === "string" && r["rationale"].length > 0) {
      action.rationale = r["rationale"].slice(0, TEXT_MAX);
    }
    if (typeof r["positionId"] === "string" && r["positionId"].length > 0) {
      action.positionId = r["positionId"];
    }
    if (r["type"] === "ENTER") {
      const confidence = typeof r["confidence"] === "number" && Number.isFinite(r["confidence"])
        ? Math.min(1, Math.max(0, r["confidence"]))
        : undefined;
      if (confidence !== undefined) action.confidence = confidence;
      if (r["profile"] === "scalp" || r["profile"] === "shortterm") action.profile = r["profile"];
    }
    if (r["type"] === "ENTER" || r["type"] === "TIGHTEN") {
      const sl = num(r[r["type"] === "ENTER" ? "suggestedStopLossPct" : "tightenStopLossPct"], STOP_LOSS_PCT);
      if (sl !== undefined) {
        if (r["type"] === "ENTER") action.suggestedStopLossPct = sl;
        else action.tightenStopLossPct = sl;
      }
    }
    if (r["type"] === "ENTER") {
      const tp = num(r["suggestedTakeProfitPct"], TAKE_PROFIT_PCT);
      if (tp !== undefined) action.suggestedTakeProfitPct = tp;
    }
    if (r["type"] === "TIGHTEN") {
      const tp1 = num(r["tightenTp1Pct"], TAKE_PROFIT_PCT);
      if (tp1 !== undefined) action.tightenTp1Pct = tp1;
      const trail = num(r["tightenTrailingPct"], TRAILING_PCT);
      if (trail !== undefined) action.tightenTrailingPct = trail;
    }
    return action;
  }
}
