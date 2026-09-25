/**
 * Autonomous AI trader agent — the AI that actually trades (`AI_AUTONOMY=auto`).
 *
 * Each cycle the host builds a pure-data snapshot (portfolio, open positions,
 * scanner candidates with the strategy ensemble's advisory views, recent
 * trades); the agent may call the same read-only data tools as the veto
 * agent, then answers with STRICT JSON actions:
 * ENTER / EXIT / TIGHTEN. In auto mode this agent is the sole entry decision
 * maker — strategies advise (strategyViews), the agent decides. Every action
 * is host-guarded downstream (risk
 * engine gates all entries; PositionManager.tightenExits is a one-way
 * ratchet) — the model's output can only propose, never bypass.
 *
 * Failure discipline mirrors AiVetoAgent: any timeout / network error /
 * malformed response / cost-cap hit → empty action list. The agent never
 * throws and never blocks the deterministic loop.
 */
import { CHAIN_VALUES, type AIConfig, type Chain, type Logger } from "@autonomous-trader/shared";
import type { AiCandidate, AiConversationOptions, AiToolContext, ChatMessage, ChatResponse } from "./ai-agent.js";
import { TOOL_DEFS, type ToolDef, parseChatCompletion, withAiDeadline } from "./ai-agent.js";
import { AiBudget } from "./ai-budget.js";
import type { LossStats } from "./loss-stats.js";

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
  /** Refined lessons-learned-from-losses. Host persists these and feeds them
   *  back every cycle — the agent's long-term memory. */
  lessons?: string[];
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
  recentTrades: {
    token: string;
    chain: Chain;
    strategyId: string;
    pnlUsd: number;
    pnlPct: number;
    exitReason: string | null;
    heldMin: number;
  }[];
  /** Scoped reconciled outcomes, with missing data and sample limits explicit. */
  lossStats?: LossStats;
  /** Your own persisted lessons from past losses — read, apply, refine. */
  lessons?: string[];
  /** Host-enforced constraints and previous application outcomes. */
  entryRules?: { minimumLiquidityUsd: number; copyTradingEnabled: boolean };
  entryBlocks?: { chain: Chain; reasons: string[] }[];
  actionOutcomes?: { type: string; token: string; chain: Chain; outcome: string; at: string; reason?: string }[];
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
const MAX_COMPLETION_TOKENS = 2_000;
const TEXT_MAX = 300;
const LESSON_MAX = 200;
const STOP_LOSS_PCT: [number, number] = [1, 50];
const TAKE_PROFIT_PCT: [number, number] = [1, 200];
const TRAILING_PCT: [number, number] = [1, 50];

const SYSTEM_PROMPT =
  "You are the decision maker of a micro-cap token trading book on Solana/TON/EVM chains — " +
  "the deterministic strategies only advise you. " +
  "Each cycle you receive a portfolio snapshot: capital, open positions with live PnL, " +
  "top scanner candidates with quantitative scores and strategyViews (what the strategy " +
  "ensemble said about each), recent closed trades with exit reasons, " +
  "lossStats (aggregate over your last 200 closed trades), lessons (your own persisted " +
  "memory of what past losses taught you), and — when copy-trade is on — recent swaps by " +
  "tracked high-PNL wallets. " +
  "Scores and strategyViews are GUIDANCE, not gates: they tell you what the quantitative " +
  "screens see; jevScore, when present, is an independent classifier's 0-1 entry score from " +
  "a rug/momentum review — " +
  "the same advisory role. ENTER only with evidence of positive expected net value after " +
  "trading fees and slippage (AI operating costs are a budgeted fixed overhead — never net them " +
  "against an individual entry). Abstention preserves capital when the evidence " +
  "is insufficient; there is no requirement to trade, but in PAPER mode a plausible entry " +
  "with adequate evidence teaches more than abstention — do not abstain solely because " +
  "the edge is small or the sample is thin. " +
  "You may call the provided read-only data tools to refresh data on any token before acting. " +
  "Always specify the token's chain in tool calls. Provider errors, missing pairs, and unknown " +
  "data are missing evidence, not verified liquidity collapse or a rug. " +
  "You respond with a list of actions, executed only after the deterministic risk engine approves them — " +
  "a risk-engine refusal (security, liquidity, exposure caps) is final, not a signal to retry. " +
  "Respect entryRules and entryBlocks; blocked entries do not prevent protective exits. " +
  "Use actionOutcomes to avoid repeating refused actions. An unseen token is a discovery lead " +
  "and must finish scanner screening before entry. Omit profile for ordinary AI entries; " +
  "profile is allowed only for a verified fresh TON copy BUY when entryRules.copyTradingEnabled is true. " +
  "Rules: never ENTER a token your own ai-autonomous slot already holds — other slots " +
  "on it are fine, each strategy holds its own slot (copy-trade slots excepted too: you may add ONE " +
  "extra, smaller position when copying a tracked wallet's fresh BUY); every ENTER needs a " +
  "concrete evidence-based thesis — a tracked wallet's BUY is a lead to verify (tools), not a reason " +
  "by itself, and their SELL of a token you hold is a take-profit hint; you may EXIT any position or " +
  "TIGHTEN its exits (raise stop, lower take-profit/trailing) but you can " +
  "never loosen risk; prefer evidence-backed actions over marginal ones. An empty action list " +
  "is a valid, cost-aware decision. Avoid repeated research without new decision-relevant evidence. " +
  "LEARNING: evaluate reconciled net outcomes rather than a target win rate; a small sample " +
  "does not establish an edge. Refuse marginal entries that match supported loss lessons, " +
  "and use EXIT/TIGHTEN only on current evidence, not unknown provider data. " +
  "Every cycle, apply your lessons; when recentTrades/lossStats reveal a new loss pattern, or a " +
  "lesson no longer holds, return an updated lessons array (max 10, each one short actionable rule " +
  "with its evidence, replacing stale ones). Omit lessons when nothing changed. " +
  "Respond with STRICT JSON only, no markdown fences: " +
  '{"actions":[{"type":"ENTER","tokenAddress":"...","chain":"solana|ton|bsc|base|polygon|arbitrum",' +
  '"confidence":0.0,"rationale":"one short sentence",' +
  '"suggestedStopLossPct":10,"suggestedTakeProfitPct":5},' +
  '{"type":"EXIT","tokenAddress":"...","chain":"...","positionId":"...","rationale":"..."},' +
  '{"type":"TIGHTEN","tokenAddress":"...","chain":"...","positionId":"...","tightenStopLossPct":5,' +
  '"tightenTp1Pct":3,"tightenTrailingPct":8}],"summary":"one sentence market read",' +
  '"lessons":["short actionable rule learned from a loss"]}';

function compactCandidate(candidate: AiCandidate): AiCandidate {
  return {
    tokenAddress: candidate.tokenAddress,
    chain: candidate.chain,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    ...(candidate.market ? {
      market: {
        priceUsd: candidate.market.priceUsd,
        ...(candidate.market.marketCapUsd !== undefined ? { marketCapUsd: candidate.market.marketCapUsd } : {}),
        volumeUsd5m: candidate.market.volumeUsd5m,
        volumeUsd1h: candidate.market.volumeUsd1h,
        priceChange5m: candidate.market.priceChange5m,
        priceChange1h: candidate.market.priceChange1h,
        buyVolumeUsd1m: candidate.market.buyVolumeUsd1m,
        sellVolumeUsd1m: candidate.market.sellVolumeUsd1m,
        uniqueBuyers1m: candidate.market.uniqueBuyers1m,
        uniqueSellers1m: candidate.market.uniqueSellers1m,
      },
    } : {}),
    ...(candidate.liquidity ? {
      liquidity: {
        liquidityUsd: candidate.liquidity.liquidityUsd,
        poolAgeMs: candidate.liquidity.poolAgeMs,
        estimatedSlippageBps500: candidate.liquidity.estimatedSlippageBps500,
        liquidityChange5m: candidate.liquidity.liquidityChange5m,
      },
    } : {}),
    ...(candidate.holders ? {
      holders: {
        totalHolders: candidate.holders.totalHolders,
        top10Pct: candidate.holders.top10Pct,
        creatorPct: candidate.holders.creatorPct,
        insiderPct: candidate.holders.insiderPct,
        sniperPct: candidate.holders.sniperPct,
        bundlerPct: candidate.holders.bundlerPct,
      },
    } : {}),
    ...(candidate.security ? {
      security: {
        status: candidate.security.status,
        score: candidate.security.score,
        reasons: candidate.security.reasons.slice(0, 5),
      },
    } : {}),
    ...(candidate.scores ? {
      scores: {
        opportunity: candidate.scores.opportunity,
        security: candidate.scores.security,
        momentum: candidate.scores.momentum,
        risk: candidate.scores.risk,
      },
    } : {}),
    ...(candidate.strategyViews ? {
      strategyViews: candidate.strategyViews.map((view) => ({
        strategyId: view.strategyId,
        decision: view.decision,
        confidence: view.confidence,
        reasons: view.reasons.slice(0, 3),
      })),
    } : {}),
    ...(candidate.jevScore !== undefined ? { jevScore: candidate.jevScore } : {}),
  };
}

function compactSnapshot(snapshot: AiTraderSnapshot, maxCandidates: number): AiTraderSnapshot {
  return {
    ...snapshot,
    candidates: snapshot.candidates.slice(0, maxCandidates).map(compactCandidate),
  };
}

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
  async propose(snapshot: AiTraderSnapshot, options: AiConversationOptions = {}): Promise<AiTraderCycleResult> {
    if (this.cfg.provider === "mock") return { actions: [], summary: "mock provider" };
    return this.exchange(snapshot, options);
  }

  /** The full multi-round conversation. One absolute deadline covers every round. */
  private async exchange(snapshot: AiTraderSnapshot, options: AiConversationOptions): Promise<AiTraderCycleResult> {
    const empty = (summary: string): AiTraderCycleResult => ({ actions: [], summary });

    if (this.budget.overCostCap()) return empty("daily AI cost cap reached");

    try {
      return await withAiDeadline(this.cfg.timeoutMs, options, async (signal, check) => {
        const messages: ChatMessage[] = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(compactSnapshot(snapshot, this.cfg.maxCandidatesPerCycle)) },
        ];
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          check();
          if (this.budget.overCostCap()) return empty("daily AI cost cap reached");
          const body = await this.request(messages, signal);
          check();

          const msg = body.choices?.[0]?.message;
          const calls = msg?.tool_calls ?? [];
          if (calls.length > 0 && round < MAX_TOOL_ROUNDS) {
            messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
            for (const tc of calls) {
              check();
              const content = await this.runTool(tc);
              check();
              messages.push({ role: "tool", tool_call_id: tc.id, content });
            }
            continue;
          }

          return this.parse(msg?.content) ?? empty("malformed AI response");
        }
        return empty("no final answer after tool rounds");
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.log.warn("AI trader call error", { error: e.message });
      return empty(e.name === "AbortError" ? "timeout" : "network error");
    }
  }

  private async request(messages: ChatMessage[], signal: AbortSignal): Promise<ChatResponse> {
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
        // reasoning models spend tokens on thinking before the actions JSON
        max_tokens: MAX_COMPLETION_TOKENS,
        messages,
        ...this.toolField(),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
      this.log.warn("AI trader call failed", { status: res.status, error: detail });
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
  private async runTool(tc: NonNullable<ChatMessage["tool_calls"]>[number]): Promise<string> {
    const name = tc.function.name as keyof AiToolContext;
    const fn = this.tools[name];
    if (!this.cfg.toolsEnabled || !TOOL_DEFS.some((t) => t.function.name === name) || typeof fn !== "function") return `error: unknown tool ${tc.function.name}`;
    let args: { token?: unknown; chain?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(tc.function.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
      else return "error: tool arguments must be an object";
    } catch {
      return "error: malformed tool arguments";
    }
    const token = typeof args.token === "string" && args.token.trim().length > 0 ? args.token.trim() : null;
    if (!token) return "error: missing token argument";
    if (typeof args.chain !== "string" || !(CHAIN_VALUES as readonly string[]).includes(args.chain)) {
      return `error: missing or invalid chain argument; expected one of ${CHAIN_VALUES.join(", ")}`;
    }
    const chain = args.chain as Chain;
    try {
      const result = await fn(token, chain);
      const text = JSON.stringify(result ?? null);
      return text.length > TOOL_RESULT_MAX_CHARS ? text.slice(0, TOOL_RESULT_MAX_CHARS) : text;
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Extract + validate the action list. Tolerates ```json fences.
   *  Invalid actions are dropped individually; a broken envelope is null. */
  private parse(content: string | null | undefined): AiTraderCycleResult | null {
    if (!content) return null;
    const match = content.match(/\{[\s\S]*\}/); // first-to-last {...} block
    if (!match) return null;
    let parsed: { actions?: unknown; summary?: unknown; lessons?: unknown };
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
    const result: AiTraderCycleResult = {
      actions,
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, TEXT_MAX) : "",
    };
    if (Array.isArray(parsed.lessons)) {
      // An explicit empty array clears stale lessons; the host gates that on a
      // newly reconciled close so idle cycles cannot erase memory.
      result.lessons = parsed.lessons
        .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
        .map((l) => l.trim().slice(0, LESSON_MAX))
        .slice(0, 10);
    }
    return result;
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
      if (r["chain"] === "ton" && (r["profile"] === "scalp" || r["profile"] === "shortterm")) {
        action.profile = r["profile"];
      }
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
