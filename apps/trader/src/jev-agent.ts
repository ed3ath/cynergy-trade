/**
 * Jev-ai (jev-ai.pro) "System One" second opinion — a non-generative
 * classifier that reviews and scores while the main AI agent decides. One
 * batched call per auto-mode cycle: a compact card per candidate rides in
 * one `state`; per candidate Jev answers a graded entry-score question plus
 * a short review (rug risk, momentum safety). The score does two jobs:
 *   1. pre-filter — candidates below config.ai.jevMinScore never reach the
 *      main AI (fewer chat calls, cheaper cycles);
 *   2. second opinion — the score rides the candidate as `jevScore` (the
 *      main AI sees it) and damps ENTER confidence in the host (0.5–1.0x:
 *      it can only shrink size, never inflate it).
 * The state is a compact card per token — full AiCandidate JSON blew the
 * upstream token cap (max_tokens_exceeded). Failure discipline: timeout /
 * network error / malformed body / cost-cap hit → empty map (no filtering,
 * no damping). Never throws, never blocks. Input tokens billed to the
 * shared daily AI budget at the blended chat rate — ponytail: Jev bills
 * input-only credits; drop its real pricing in if it dominates the budget.
 */
import type { AIConfig, Logger } from "@autonomous-trader/shared";
import type { AiCandidate } from "./ai-agent.js";
import type { AiBudget } from "./ai-budget.js";

const MAX_CANDIDATES = 20; // API allows 64 questions; 3 per candidate + token cap say keep it lean
/** Graded entry score — Jev picks the level; normalized to 0–1 by index/5. */
const SCORE_LEVELS = ["1 avoid", "2 weak", "3 marginal", "4 decent", "5 strong", "6 prime"];

export interface JevReview {
  /** Normalized entry score 0–1 (level index / 5). */
  score: number;
  /** P(rug/scam/dump-risk), when answered. */
  rugProb?: number;
  /** P(momentum is entry-safe, not exit-pumped), when answered. */
  momentumProb?: number;
}

/** Compact token card for the classifier — numeric essentials only. */
function card(c: AiCandidate, i: number): Record<string, unknown> {
  const short = c.tokenAddress.length > 14
    ? c.tokenAddress.slice(0, 6) + "…" + c.tokenAddress.slice(-4)
    : c.tokenAddress;
  return {
    i,
    token: short,
    chain: c.chain,
    ...(c.market ? {
      mcapUsd: c.market.marketCapUsd,
      vol1hUsd: c.market.volumeUsd1h,
      ch5mPct: c.market.priceChange5m,
      ch1hPct: c.market.priceChange1h,
    } : {}),
    ...(c.liquidity ? {
      liqUsd: c.liquidity.liquidityUsd,
      poolAgeMin: Math.round(c.liquidity.poolAgeMs / 60_000),
    } : {}),
    ...(c.holders ? { top10Pct: c.holders.top10Pct } : {}),
    ...(c.security ? { sec: c.security.status, secScore: c.security.score } : {}),
    ...(c.scores ? { scannerScores: c.scores } : {}),
    ...(c.strategyViews
      ? { strategyViews: c.strategyViews.map((v) => `${v.decision}@${v.confidence}`).join(",") }
      : {}),
  };
}

export class JevAgent {
  constructor(
    private readonly cfg: AIConfig,
    private readonly log: Logger,
    private readonly budget: AiBudget,
  ) {}

  /** Review candidates → JevReview keyed `${chain}:${token}`. Empty map on
   *  any failure — callers treat unreviewed as pass-through. */
  async score(candidates: AiCandidate[]): Promise<Map<string, JevReview>> {
    if (candidates.length === 0 || this.budget.overCostCap()) return new Map();
    const picked = candidates.slice(0, MAX_CANDIDATES);
    const questions: Record<string, { type: string; instructions: string; criteria?: string[] }> = {};
    picked.forEach((c, i) => {
      const t = `candidate ${i} (${card(c, i).token})`;
      questions[`s${i}`] = {
        type: "score",
        instructions: `Score ${t} as a micro-cap trade entry right now, weighing exit-liquidity, holder/rug risk, and momentum vs exit-pump risk.`,
        criteria: SCORE_LEVELS,
      };
      questions[`rug${i}`] = {
        type: "noul",
        instructions: `Is ${t} a rug, scam, or dump-risk token?`,
      };
      questions[`mom${i}`] = {
        type: "noul",
        instructions: `Is ${t} momentum entry-safe — rising without being already exit-pumped?`,
      };
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.jevTimeoutMs);
    try {
      const res = await fetch(`${this.cfg.jevBaseUrl.replace(/\/$/, "")}/systemone`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.cfg.jevApiKey ? { authorization: `Bearer ${this.cfg.jevApiKey}` } : {}),
        },
        body: JSON.stringify({
          state: JSON.stringify(picked.map(card)),
          model: this.cfg.jevModel,
          questions,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const body = (await res.json()) as {
        answers?: Record<string, { type?: string; score?: unknown; noul?: unknown }>;
        usage?: { input_tokens?: number };
      };
      this.budget.trackCost({ prompt_tokens: body.usage?.input_tokens ?? 0, completion_tokens: 0 });
      const prob = (v: unknown): number | undefined => {
        if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
        return Math.min(1, Math.max(0, v));
      };
      const reviews = new Map<string, JevReview>();
      picked.forEach((c, i) => {
        const raw = body.answers?.[`s${i}`]?.score;
        if (typeof raw !== "number" || !Number.isFinite(raw)) return; // no score → pass-through
        const review: JevReview = {
          score: Math.min(1, Math.max(0, raw / (SCORE_LEVELS.length - 1))),
        };
        const rug = prob(body.answers?.[`rug${i}`]?.noul);
        if (rug !== undefined) review.rugProb = rug;
        const mom = prob(body.answers?.[`mom${i}`]?.noul);
        if (mom !== undefined) review.momentumProb = mom;
        reviews.set(`${c.chain}:${c.tokenAddress}`, review);
      });
      if (reviews.size === 0) this.log.warn("Jev returned no usable reviews — pass-through");
      return reviews;
    } catch (err) {
      const e = err as Error;
      this.log.warn("Jev call failed — pass-through", {
        error: e.name === "AbortError" ? "timeout" : e.message,
      });
      return new Map(); // all-or-nothing: a partial map would filter on garbage
    } finally {
      clearTimeout(timer);
    }
  }
}
