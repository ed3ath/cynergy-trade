/**
 * Risk Engine — the deterministic financial firewall.
 *
 * ALL trade decisions pass through here. No bypass path exists.
 * The AI, strategy engine, and any other component can only SUGGEST.
 * This engine APPROVES or REJECTS.
 *
 * Hard gates are checked first. Soft adjustments applied after.
 * If ANY hard gate fails → REJECTED, full stop.
 */
import {
  RiskRejectionError,
  type RiskConfig,
  type TradeIntent,
  type PortfolioSnapshot,
  type LiquiditySnapshot,
  type SecurityAssessment,
  type MarketRegime,
  type RiskDecision,
} from "@autonomous-trader/shared";
import { generateOrderId } from "@autonomous-trader/shared";

export interface RiskEngineInput {
  intent: TradeIntent;
  portfolio: PortfolioSnapshot;
  liquidity: LiquiditySnapshot;
  security: SecurityAssessment;
  marketRegime: MarketRegime;
  strategyConfidence: number;       // 0–1
  strategyPerformanceMultiplier: number; // 0.5–2.0, shrunk toward 1 for small samples
  openPositionCount: number;
  dailyLossUsd: number;
  weeklyLossUsd: number;
  currentDrawdownPct: number;
  existingTokenExposureUsd: number;
  existingStrategyExposureUsd: number;
}

export interface RiskEngineOutput {
  decision: "APPROVED" | "REJECTED" | "REDUCED";
  approvedSizeUsd: number;
  approvedRiskFraction: number;
  maxSlippageBps: number;
  rejectionReasons: string[];
  appliedMultipliers: Record<string, number>;
  riskDecision: RiskDecision;
}

export class RiskEngine {
  constructor(
    private readonly config: RiskConfig,
    private readonly killSwitchFn: () => boolean,
    private readonly stopNewEntriesFn: () => boolean,
  ) {}

  evaluate(input: RiskEngineInput): RiskEngineOutput {
    const rejections: string[] = [];

    // ── Hard gate 1: kill switch ─────────────────────────────────────────────
    if (this.killSwitchFn()) {
      rejections.push("KILL_SWITCH_ACTIVE");
    }

    // ── Hard gate 2: stop new entries ────────────────────────────────────────
    if (this.stopNewEntriesFn()) {
      rejections.push("STOP_NEW_ENTRIES_ACTIVE");
    }

    // ── Hard gate 3: security rejection ──────────────────────────────────────
    if (input.security.status === "REJECT") {
      rejections.push(`SECURITY_REJECTED: ${input.security.reasons.map((r) => r.code).join(",")}`);
    }
    if (input.security.status === "UNKNOWN" && input.security.confidence < 0.5) {
      rejections.push("SECURITY_UNKNOWN_LOW_CONFIDENCE");
    }

    // ── Hard gate 4: liquidity minimum ───────────────────────────────────────
    if (input.liquidity.liquidityUsd < this.config.minLiquidityUsd) {
      rejections.push(
        `LIQUIDITY_BELOW_MINIMUM: ${input.liquidity.liquidityUsd.toFixed(0)} < ${this.config.minLiquidityUsd}`,
      );
    }

    // ── Hard gate 5: slippage maximum ────────────────────────────────────────
    const slippageForSize = estimateSlippage(input.intent.positionSizeUsd, input.liquidity);
    if (slippageForSize > this.config.maxSlippageBps) {
      rejections.push(
        `SLIPPAGE_EXCEEDS_MAX: ${slippageForSize.toFixed(0)}bps > ${this.config.maxSlippageBps}bps`,
      );
    }

    // ── Hard gate 6: daily loss limit ────────────────────────────────────────
    if (input.dailyLossUsd >= this.config.maxDailyLossUsd) {
      rejections.push(
        `DAILY_LOSS_LIMIT: ${input.dailyLossUsd.toFixed(2)} >= ${this.config.maxDailyLossUsd}`,
      );
    }

    // ── Hard gate 7: weekly loss limit ───────────────────────────────────────
    if (input.weeklyLossUsd >= this.config.maxWeeklyLossUsd) {
      rejections.push(
        `WEEKLY_LOSS_LIMIT: ${input.weeklyLossUsd.toFixed(2)} >= ${this.config.maxWeeklyLossUsd}`,
      );
    }

    // ── Hard gate 8: drawdown emergency threshold ─────────────────────────────
    if (input.currentDrawdownPct >= this.config.maxDrawdownEmergencyPct) {
      rejections.push(
        `EMERGENCY_DRAWDOWN: ${input.currentDrawdownPct.toFixed(2)}% >= ${this.config.maxDrawdownEmergencyPct}%`,
      );
    }

    // ── Hard gate 9: max concurrent positions ────────────────────────────────
    if (input.openPositionCount >= this.config.maxConcurrentPositions) {
      rejections.push(
        `MAX_POSITIONS: ${input.openPositionCount} >= ${this.config.maxConcurrentPositions}`,
      );
    }

    // ── Hard gate 10: wallet balance sufficiency ──────────────────────────────
    if (input.intent.positionSizeUsd > input.portfolio.availableCapitalUsd) {
      rejections.push(
        `INSUFFICIENT_CAPITAL: need ${input.intent.positionSizeUsd.toFixed(2)}, have ${input.portfolio.availableCapitalUsd.toFixed(2)}`,
      );
    }

    // ── Hard gate 11: token exposure ──────────────────────────────────────────
    const totalTokenExposure = input.existingTokenExposureUsd + input.intent.positionSizeUsd;
    if (totalTokenExposure > this.config.maxTokenExposureUsd) {
      rejections.push(
        `TOKEN_EXPOSURE_EXCEEDED: ${totalTokenExposure.toFixed(2)} > ${this.config.maxTokenExposureUsd}`,
      );
    }

    // ── Hard gate 12: total portfolio exposure ────────────────────────────────
    const totalExposure = input.portfolio.allocatedUsd + input.intent.positionSizeUsd;
    if (totalExposure > this.config.maxTotalExposureUsd) {
      rejections.push(
        `TOTAL_EXPOSURE_EXCEEDED: ${totalExposure.toFixed(2)} > ${this.config.maxTotalExposureUsd}`,
      );
    }

    // ── Hard gate 13: strategy exposure ──────────────────────────────────────
    const strategyExposurePct =
      ((input.existingStrategyExposureUsd + input.intent.positionSizeUsd) /
        input.portfolio.totalValueUsd) * 100;
    if (strategyExposurePct > this.config.maxStrategyExposurePct) {
      rejections.push(
        `STRATEGY_EXPOSURE_EXCEEDED: ${strategyExposurePct.toFixed(2)}% > ${this.config.maxStrategyExposurePct}%`,
      );
    }

    // ── Hard gate 14: intent expiry ───────────────────────────────────────────
    if (input.intent.expiresAt <= new Date()) {
      rejections.push("INTENT_EXPIRED");
    }

    // ── Any hard gate failed → reject immediately ─────────────────────────────
    if (rejections.length > 0) {
      return this.rejected(input, rejections);
    }

    // ── Position sizing (soft multipliers) ────────────────────────────────────
    const multipliers: Record<string, number> = {};

    // Strategy confidence
    multipliers["strategy_confidence"] = 0.5 + input.strategyConfidence * 0.5; // 0.5–1.0

    // Strategy performance (shrunk for small samples)
    multipliers["strategy_performance"] = clamp(input.strategyPerformanceMultiplier, 0.5, 1.5);

    // Market regime
    multipliers["market_regime"] = marketRegimeMultiplier(input.marketRegime);

    // Liquidity quality (more liquid = larger allowed)
    multipliers["liquidity"] = liquidityMultiplier(input.liquidity.liquidityUsd, this.config.minLiquidityUsd);

    // Drawdown reduction
    multipliers["drawdown"] = drawdownMultiplier(input.currentDrawdownPct, this.config.maxDrawdownPct);

    // Security warning penalty
    if (input.security.status === "WARNING") {
      multipliers["security_warning"] = 0.6;
    }

    const composite = Object.values(multipliers).reduce((acc, m) => acc * m, 1.0);

    const baseRiskFraction = this.config.baseRiskPct / 100;
    const adjustedRiskFraction = clamp(
      baseRiskFraction * composite,
      this.config.minRiskPct / 100,
      this.config.maxRiskPct / 100,
    );

    let approvedSizeUsd = input.portfolio.totalValueUsd * adjustedRiskFraction;

    // Clamp absolute maximum
    approvedSizeUsd = Math.min(approvedSizeUsd, this.config.maxPositionValueUsd);
    approvedSizeUsd = Math.min(approvedSizeUsd, input.portfolio.availableCapitalUsd * 0.95);

    // If the requested size was already smaller, use that (don't force up)
    approvedSizeUsd = Math.min(approvedSizeUsd, input.intent.positionSizeUsd);

    const wasReduced = approvedSizeUsd < input.intent.positionSizeUsd * 0.99;

    const riskDecision: RiskDecision = {
      tradeIntentId: input.intent.id,
      decision: wasReduced ? "REDUCED" : "APPROVED",
      rejectionReasons: [],
      approvedPositionSizeUsd: approvedSizeUsd,
      approvedRiskFraction: adjustedRiskFraction,
      maxSlippageBps: Math.min(input.intent.maxSlippageBps, this.config.maxSlippageBps),
      riskVersion: this.config.version,
      decidedAt: new Date(),
    };

    return {
      decision: wasReduced ? "REDUCED" : "APPROVED",
      approvedSizeUsd,
      approvedRiskFraction: adjustedRiskFraction,
      maxSlippageBps: riskDecision.maxSlippageBps,
      rejectionReasons: [],
      appliedMultipliers: multipliers,
      riskDecision,
    };
  }

  private rejected(input: RiskEngineInput, reasons: string[]): RiskEngineOutput {
    const riskDecision: RiskDecision = {
      tradeIntentId: input.intent.id,
      decision: "REJECTED",
      rejectionReasons: reasons,
      approvedPositionSizeUsd: 0,
      approvedRiskFraction: 0,
      maxSlippageBps: 0,
      riskVersion: this.config.version,
      decidedAt: new Date(),
    };
    return {
      decision: "REJECTED",
      approvedSizeUsd: 0,
      approvedRiskFraction: 0,
      maxSlippageBps: 0,
      rejectionReasons: reasons,
      appliedMultipliers: {},
      riskDecision,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function estimateSlippage(tradeSizeUsd: number, liquidity: LiquiditySnapshot): number {
  // Interpolate from stored slippage estimates
  if (tradeSizeUsd <= 50) return liquidity.estimatedSlippageBps50;
  if (tradeSizeUsd <= 500) {
    const t = (tradeSizeUsd - 50) / 450;
    return liquidity.estimatedSlippageBps50 * (1 - t) + liquidity.estimatedSlippageBps500 * t;
  }
  if (tradeSizeUsd <= 5000) {
    const t = (tradeSizeUsd - 500) / 4500;
    return liquidity.estimatedSlippageBps500 * (1 - t) + liquidity.estimatedSlippageBps5000 * t;
  }
  // Beyond $5k: linear extrapolation (conservative)
  return liquidity.estimatedSlippageBps5000 * (tradeSizeUsd / 5000);
}

function marketRegimeMultiplier(regime: MarketRegime): number {
  switch (regime) {
    case "BULL":            return 1.0;
    case "LOW_VOLATILITY":  return 1.0;
    case "UNKNOWN":         return 0.7;
    case "HIGH_VOLATILITY": return 0.6;
    case "RISK_OFF":        return 0.4;
    case "BEAR":            return 0.4;
  }
}

function liquidityMultiplier(liquidityUsd: number, minLiquidityUsd: number): number {
  // Scales from 0.6 (just above minimum) to 1.0 (10× minimum)
  const ratio = liquidityUsd / minLiquidityUsd;
  return clamp(0.6 + (ratio - 1) * 0.04, 0.6, 1.0);
}

function drawdownMultiplier(drawdownPct: number, maxDrawdownPct: number): number {
  // 0% drawdown → 1.0, at max → 0.2
  const fraction = drawdownPct / maxDrawdownPct;
  return clamp(1.0 - fraction * 0.8, 0.2, 1.0);
}
