/**
 * Jev-ai (jev-ai.pro) "System One" second opinion — a non-generative
 * classifier that scores while the main AI agent decides. One batched call
 * per auto-mode cycle: every scanner candidate rides in one `state`, one
 * noul ("is this a good entry") question per candidate, answered in
 * parallel. The scores do two jobs:
 *   1. pre-filter — candidates below config.ai.jevMinScore never reach the
 *      main AI (fewer chat calls, cheaper cycles);
 *   2. second opinion — the score rides the candidate as `jevScore` (the
 *      main AI sees it) and damps ENTER confidence in the host (0.5–1.0x:
 *      it can only shrink size, never inflate it).
 * Failure discipline: timeout / network error / malformed body / cost-cap
 * hit → empty map (no filtering, no damping). Never throws, never blocks.
 * Charged to the shared daily AI budget at the blended chat rate —
 * ponytail: Jev bills input-only credits, not per-token USD; drop its real
 * pricing in if it ever dominates the budget.
 */
import type { AIConfig, Logger } from "@autonomous-trader/shared";
import type { AiCandidate } from "./ai-agent.js";
import type { AiBudget } from "./ai-budget.js";

const MAX_QUESTIONS = 64; // API cap per call; candidates per cycle stay well under

export class JevAgent {
  constructor(
    private readonly cfg: AIConfig,
    private readonly log: Logger,
    private readonly budget: AiBudget,
  ) {}

  /** Score candidates → P(entry), keyed `${chain}:${token}`. Empty map on
   *  any failure — callers treat unscored as pass-through. */
  async score(candidates: AiCandidate[]): Promise<Map<string, number>> {
    if (candidates.length === 0 || this.budget.overCostCap()) return new Map();
    const picked = candidates.slice(0, MAX_QUESTIONS);
    const questions: Record<string, { type: "noul"; instructions: string }> = {};
    picked.forEach((c, i) => {
      questions[`c${i}`] = {
        type: "noul",
        instructions:
          `Is candidate ${i} (${c.tokenAddress} on ${c.chain}) a good micro-cap entry right now — ` +
          "liquid enough to exit, not a rug, momentum without being already exit-pumped?",
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
          state: JSON.stringify(picked),
          model: this.cfg.jevModel,
          questions,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        answers?: Record<string, { noul?: unknown }>;
        usage?: { input_tokens?: number };
      };
      this.budget.trackCost({ prompt_tokens: body.usage?.input_tokens ?? 0, completion_tokens: 0 });
      const scores = new Map<string, number>();
      picked.forEach((c, i) => {
        const n = body.answers?.[`c${i}`]?.noul;
        if (typeof n === "number" && Number.isFinite(n)) {
          scores.set(`${c.chain}:${c.tokenAddress}`, Math.min(1, Math.max(0, n)));
        }
      });
      if (scores.size === 0) this.log.warn("Jev returned no usable scores — pass-through");
      return scores;
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
