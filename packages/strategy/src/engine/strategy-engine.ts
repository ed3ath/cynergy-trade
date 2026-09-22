/**
 * Strategy engine — runs all enabled strategies against a candidate,
 * returns ranked decisions. Strategies are pure; engine manages routing.
 */
import type { StrategyDecision, Logger } from "@autonomous-trader/shared";
import type { TradingStrategy, StrategyContext } from "./strategy-interface.js";

export interface StrategyEnsembleResult {
  tokenAddress: string;
  decisions: StrategyDecision[];
  bestDecision?: StrategyDecision;
  /** All ENTER decisions, highest confidence first. Multiple strategies may
   *  hold the same token concurrently — one position per strategyId, aggregate
   *  token exposure still capped by the risk engine. */
  enterDecisions: StrategyDecision[];
  anyEnter: boolean;
  highestConfidence: number;
  evaluatedAt: Date;
}

export class StrategyEngine {
  private strategies: TradingStrategy[] = [];

  constructor(private readonly logger: Logger) {}

  register(strategy: TradingStrategy): void {
    this.strategies.push(strategy);
    this.logger.info("Strategy registered", { id: strategy.id, version: strategy.version });
  }

  unregister(strategyId: string): void {
    this.strategies = this.strategies.filter((s) => s.id !== strategyId);
  }

  evaluate(ctx: StrategyContext): StrategyEnsembleResult {
    const eligible = this.strategies.filter(
      (s) => ctx.candidate.scores.opportunity >= s.minimumOpportunityScore,
    );

    if (eligible.length === 0) {
      return {
        tokenAddress: ctx.candidate.tokenAddress,
        decisions: [],
        enterDecisions: [],
        anyEnter: false,
        highestConfidence: 0,
        evaluatedAt: new Date(),
      };
    }

    const decisions: StrategyDecision[] = [];

    for (const strategy of eligible) {
      try {
        const decision = strategy.evaluate(ctx);
        decisions.push(decision);
        this.logger.debug("Strategy evaluated", {
          strategy: strategy.id,
          token: ctx.candidate.tokenAddress,
          decision: decision.decision,
          confidence: decision.confidence,
        });
      } catch (err) {
        this.logger.error("Strategy evaluation error", {
          strategy: strategy.id,
          token: ctx.candidate.tokenAddress,
          error: (err as Error).message,
        });
      }
    }

    const enterDecisions = decisions
      .filter((d) => d.decision === "ENTER")
      .sort((a, b) => b.confidence - a.confidence);
    const bestDecision = enterDecisions[0];
    const highestConfidence = bestDecision?.confidence ?? 0;

    const result: StrategyEnsembleResult = {
      tokenAddress: ctx.candidate.tokenAddress,
      decisions,
      enterDecisions,
      anyEnter: enterDecisions.length > 0,
      highestConfidence,
      evaluatedAt: new Date(),
    };
    if (bestDecision) result.bestDecision = bestDecision;
    return result;
  }

  getRegisteredStrategies(): TradingStrategy[] {
    return [...this.strategies];
  }
}
