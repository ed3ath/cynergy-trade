/**
 * AI veto agent — optional LLM second opinion on strategy ENTER signals.
 * Talks to any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, OpenRouter, Ollama/vLLM, gateways) via plain fetch.
 *
 * Firewall contract (CLAUDE.md):
 * - VETO-ONLY: it can reject a candidate; it can never approve one. APPROVE
 *   means "no objection" — the risk engine still gates everything after it.
 * - Any failure (network, timeout, non-200, malformed response) maps to
 *   UNKNOWN → no veto, candidate proceeds through the normal risk gates.
 *   An unreachable AI must never become an unreachable trader.
 * - Verdicts are cached per token so the 10s decision loop doesn't re-ask
 *   about the same candidate every tick.
 */
import type { AIConfig, Logger } from "@autonomous-trader/shared";

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
  chain: string;
  market?: { priceUsd: number; marketCapUsd?: number; volumeUsd5m: number; volumeUsd1h: number; priceChange5m: number; priceChange1h: number; buyVolumeUsd1m: number; sellVolumeUsd1m: number; uniqueBuyers1m: number; uniqueSellers1m: number };
  liquidity?: { liquidityUsd: number; poolAgeMs: number; estimatedSlippageBps500: number; liquidityChange5m: number };
  holders?: { totalHolders: number; top10Pct: number; creatorPct: number; insiderPct: number; sniperPct: number; bundlerPct: number };
  security?: { status: string; score: number; reasons: { message: string }[] };
  scores: { opportunity: number; security: number; momentum: number; risk: number };
}

const CACHE_TTL_MS = 10 * 60_000; // one verdict per token per 10 min

const SYSTEM_PROMPT =
  "You are a brutally conservative risk reviewer for micro-cap token trades on Solana/TON. " +
  "You receive one candidate that already passed quantitative strategy and risk screens. " +
  "Your ONLY job is to spot red flags the numbers missed: obvious rug patterns, honeypot hints, " +
  "wash-traded volume, bundler/sniper dominance, manipulated holder counts. " +
  "Default to APPROVE unless you see a concrete, evidence-based red flag in the data. " +
  "Respond with STRICT JSON only, no markdown fences: " +
  '{"verdict":"APPROVE"|"REJECT","confidence":<number 0-1>,"reason":"<one short sentence>"}';

export class AiVetoAgent {
  private readonly cache = new Map<string, { verdict: AiVerdict; expiresAt: number }>();
  private spendDayKey = "";
  private spentTodayUsd = 0;
  private capLoggedDay = "";

  constructor(
    private readonly cfg: AIConfig,
    private readonly log: Logger,
  ) {}

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
      : await this.callApi(c);

    this.cache.set(c.tokenAddress, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
    return verdict;
  }

  private async callApi(c: AiCandidate): Promise<AiVerdict> {
    const unknown = (reason: string): AiVerdict =>
      ({ tokenAddress: c.tokenAddress, verdict: "UNKNOWN", confidence: 0, reason });

    if (this.overCostCap()) return unknown("daily AI cost cap reached — no veto");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
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
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(this.payload(c)) },
          ],
        }),
      });

      if (!res.ok) {
        this.log.warn("AI veto call failed", { status: res.status, token: c.tokenAddress });
        return unknown(`HTTP ${res.status}`);
      }

      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      this.trackCost(body.usage);

      return this.parse(body.choices?.[0]?.message?.content, c.tokenAddress) ?? unknown("malformed AI response");
    } catch (err) {
      this.log.warn("AI veto call error", { token: c.tokenAddress, error: (err as Error).message });
      return unknown((err as Error).name === "AbortError" ? "timeout" : "network error");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Extract the JSON object from the reply. Tolerates ```json fences. */
  private parse(content: string | undefined, tokenAddress: string): AiVerdict | null {
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

  private trackCost(usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): void {
    if (!usage || this.cfg.costPer1kTokensUsd <= 0) return;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.spendDayKey) { this.spendDayKey = day; this.spentTodayUsd = 0; }
    this.spentTodayUsd += ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) / 1000 * this.cfg.costPer1kTokensUsd;
  }

  private overCostCap(): boolean {
    if (this.cfg.costPer1kTokensUsd <= 0) {
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.capLoggedDay) {
        this.capLoggedDay = day;
        this.log.warn("AI cost cap NOT enforced — AI_COST_PER_1K_TOKENS_USD unset", { maxCostPerDayUsd: this.cfg.maxCostPerDayUsd });
      }
      return false;
    }
    return this.spentTodayUsd >= this.cfg.maxCostPerDayUsd;
  }
}
