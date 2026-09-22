/**
 * Position manager — tracks all open positions, monitors exit conditions,
 * and triggers exits through the execution router.
 *
 * Exit hierarchy (checked in order):
 * 1. Hard stop loss
 * 2. Security deterioration
 * 3. Liquidity deterioration
 * 4. Trailing stop (from peak)
 * 5. Take profit levels
 * 6. Time stop
 * 7. Momentum failure
 */
import {
  copytradeProfileFor,
  generatePositionId,
  type Position,
  type ExecutionResult,
  type MarketSnapshot,
  type LiquiditySnapshot,
  type SecurityAssessment,
  type Logger,
} from "@autonomous-trader/shared";
import { PositionStateMachine } from "@autonomous-trader/core";
import type { ExecutionRouter } from "@autonomous-trader/execution";
import type { TradeIntent } from "@autonomous-trader/shared";

export interface ExitSignal {
  reason: string;
  urgency: "NORMAL" | "URGENT" | "EMERGENCY";
  suggestedSellPct: number; // 0–100
}

export interface PositionMonitorInput {
  market: MarketSnapshot;
  liquidity: LiquiditySnapshot;
  security?: SecurityAssessment;
  timestampMs: number;
}

export class PositionManager {
  private positions = new Map<string, Position>();
  private stateMachines = new Map<string, PositionStateMachine>();

  constructor(
    private readonly executionRouter: ExecutionRouter,
    private readonly logger: Logger,
    private readonly maxPositionAgeMs = 2 * 60 * 60 * 1000, // 2h time stop — no profit thesis after this, exit
  ) {}

  /** Open a new position from a confirmed execution result. Multiple
   *  concurrent positions per token are allowed — they key by generated id
   *  and stay separated by strategyId (copytrade-scalp vs core etc.). */
  openPosition(
    result: ExecutionResult,
    intent: TradeIntent,
    stopLoss: number,
    takeProfit1?: number,
    takeProfit2?: number,
    trailingStopPct?: number,
    timeStopMs?: number,
  ): Position {
    const id = generatePositionId();
    const entryPrice = result.executedPrice;

    const position: Position = {
      id,
      tokenAddress: intent.tokenAddress,
      chain: intent.chain,
      status: "OPEN",
      mode: intent.mode,
      strategyId: intent.strategyId,
      entryPrice,
      currentPrice: entryPrice,
      sizeUsd: intent.positionSizeUsd,
      sizeTokens: result.outputAmount,
      stopLoss,
      peakPrice: entryPrice,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      drawdownFromPeakPct: 0,
      openedAt: new Date(),
      updatedAt: new Date(),
    };
    if (takeProfit1 !== undefined)    position.takeProfit1      = takeProfit1;
    if (takeProfit2 !== undefined)    position.takeProfit2      = takeProfit2;
    if (trailingStopPct !== undefined) position.trailingStopPct = trailingStopPct;
    if (timeStopMs !== undefined)     position.timeStopMs       = timeStopMs;
    if (result.txSignature)           position.entryTxSignature = result.txSignature;

    const sm = new PositionStateMachine("OPEN");
    this.positions.set(id, position);
    this.stateMachines.set(id, sm);

    this.logger.info("Position opened", {
      positionId: id,
      token: intent.tokenAddress,
      entryPrice,
      sizeUsd: intent.positionSizeUsd,
      stopLoss,
      takeProfit1,
      mode: intent.mode,
    });

    return position;
  }

  /** Update a position's current market data. Returns any exit signal. */
  updateAndCheckExit(positionId: string, input: PositionMonitorInput): ExitSignal | null {
    const position = this.positions.get(positionId);
    if (!position || position.status !== "OPEN") return null;

    const price = input.market.priceUsd;
    position.currentPrice = price;

    // Track peak
    if (price > (position.peakPrice ?? price)) {
      position.peakPrice = price;
    }

    // PnL
    position.unrealizedPnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    position.unrealizedPnlUsd = position.sizeUsd * (position.unrealizedPnlPct / 100);
    position.drawdownFromPeakPct = position.peakPrice > 0
      ? ((position.peakPrice - price) / position.peakPrice) * 100
      : 0;
    position.updatedAt = new Date();

    return this.checkExitConditions(position, input);
  }

  /** One-way ratchet: only ever TIGHTENS risk. stopLoss can only move UP,
   *  take-profits and trailing stop can only move DOWN (closer). Widening
   *  requests are clamped to the current value and reported in `clamped`.
   *  The emergency tier (hard stop vs live price, security, liquidity) is
   *  computed from live inputs each tick — untouchable by this method. */
  tightenExits(
    positionId: string,
    opts: { stopLoss?: number; takeProfit1?: number; takeProfit2?: number; trailingStopPct?: number },
  ): { applied: { stopLoss?: number; takeProfit1?: number; takeProfit2?: number; trailingStopPct?: number }; clamped: string[] } {
    const position = this.positions.get(positionId);
    if (!position || position.status !== "OPEN") return { applied: {}, clamped: ["unknown-position"] };

    const applied: { stopLoss?: number; takeProfit1?: number; takeProfit2?: number; trailingStopPct?: number } = {};
    const clamped: string[] = [];
    const num = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

    if (num(opts.stopLoss)) {
      if (opts.stopLoss > position.stopLoss) {
        position.stopLoss = opts.stopLoss;
        applied.stopLoss = opts.stopLoss;
      } else {
        clamped.push(`stopLoss<=current(${position.stopLoss})`);
      }
    }
    if (num(opts.takeProfit1)) {
      if (position.takeProfit1 === undefined || opts.takeProfit1 < position.takeProfit1) {
        position.takeProfit1 = opts.takeProfit1;
        applied.takeProfit1 = opts.takeProfit1;
      } else {
        clamped.push(`takeProfit1>=current(${position.takeProfit1})`);
      }
    }
    if (num(opts.takeProfit2)) {
      if (position.takeProfit2 === undefined || opts.takeProfit2 < position.takeProfit2) {
        position.takeProfit2 = opts.takeProfit2;
        applied.takeProfit2 = opts.takeProfit2;
      } else {
        clamped.push(`takeProfit2>=current(${position.takeProfit2})`);
      }
    }
    if (num(opts.trailingStopPct)) {
      if (position.trailingStopPct === undefined || opts.trailingStopPct < position.trailingStopPct) {
        position.trailingStopPct = opts.trailingStopPct;
        applied.trailingStopPct = opts.trailingStopPct;
      } else {
        clamped.push(`trailingStopPct>=current(${position.trailingStopPct})`);
      }
    }

    if (Object.keys(applied).length > 0) position.updatedAt = new Date();
    this.logger.info("Exits tightened", { positionId, applied, clamped });
    return { applied, clamped };
  }

  private checkExitConditions(position: Position, input: PositionMonitorInput): ExitSignal | null {
    const price = position.currentPrice;

    // ── 1. Hard stop loss ─────────────────────────────────────────────────────
    if (price <= position.stopLoss) {
      return {
        reason: `Hard stop loss hit: ${price.toFixed(8)} <= ${position.stopLoss.toFixed(8)}`,
        urgency: "EMERGENCY",
        suggestedSellPct: 100,
      };
    }

    // ── 2. Security deterioration ─────────────────────────────────────────────
    if (input.security?.status === "REJECT") {
      return {
        reason: "Security status deteriorated to REJECT",
        urgency: "EMERGENCY",
        suggestedSellPct: 100,
      };
    }

    // ── 3. Liquidity collapse ─────────────────────────────────────────────────
    if (input.liquidity.liquidityUsd < 20_000) {
      return {
        reason: `Liquidity collapsed: $${input.liquidity.liquidityUsd.toFixed(0)}`,
        urgency: "URGENT",
        suggestedSellPct: 100,
      };
    }
    if (input.liquidity.liquidityChange5m < -30) {
      return {
        reason: `Liquidity draining fast: ${input.liquidity.liquidityChange5m.toFixed(1)}%/5m`,
        urgency: "URGENT",
        suggestedSellPct: 75,
      };
    }

    // ── 4. Trailing stop ──────────────────────────────────────────────────────
    if (position.trailingStopPct && position.drawdownFromPeakPct >= position.trailingStopPct) {
      return {
        reason: `Trailing stop: -${position.drawdownFromPeakPct.toFixed(1)}% from peak`,
        urgency: "NORMAL",
        suggestedSellPct: 100,
      };
    }

    // ── 5. Take profit levels ─────────────────────────────────────────────────
    if (position.takeProfit2 && price >= position.takeProfit2) {
      return {
        reason: `Take profit 2 hit: ${price.toFixed(8)} >= ${position.takeProfit2.toFixed(8)}`,
        urgency: "NORMAL",
        suggestedSellPct: 50,
      };
    }
    if (position.takeProfit1 && price >= position.takeProfit1) {
      return {
        reason: `Take profit 1 hit: ${price.toFixed(8)} >= ${position.takeProfit1.toFixed(8)}`,
        urgency: "NORMAL",
        suggestedSellPct: 25,
      };
    }

    // ── 6. Time stop ──────────────────────────────────────────────────────────
    const ageMs = input.timestampMs - position.openedAt.getTime();
    // copy-trade scalps run a much shorter clock; strategyId fallback covers
    // positions restored from the journal (in-memory timeStopMs is lost)
    const maxAgeMs = position.timeStopMs
      ?? copytradeProfileFor(position.strategyId)?.timeStopMs
      ?? this.maxPositionAgeMs;
    if (ageMs >= maxAgeMs) {
      return {
        reason: `Time stop: position held ${(ageMs / 3_600_000).toFixed(1)}h`,
        urgency: "NORMAL",
        suggestedSellPct: 100,
      };
    }

    return null;
  }

  /** Execute an exit for a given position. */
  async exitPosition(
    positionId: string,
    signal: ExitSignal,
    currentPriceUsd: number,
    intent: TradeIntent,
  ): Promise<ExecutionResult> {
    const position = this.positions.get(positionId);
    const sm = this.stateMachines.get(positionId);
    if (!position || !sm) throw new Error(`Position ${positionId} not found`);

    sm.transition("CLOSING");
    position.status = "CLOSING";
    position.exitReason = signal.reason;

    this.logger.info("Exiting position", {
      positionId,
      token: position.tokenAddress,
      reason: signal.reason,
      urgency: signal.urgency,
      pnlPct: position.unrealizedPnlPct?.toFixed(2),
    });

    const result = await this.executionRouter.execute(intent, currentPriceUsd);

    sm.transition("CLOSED");
    position.status = "CLOSED";
    position.updatedAt = new Date();

    return result;
  }

  /** Re-register a position loaded from persistence (restart recovery).
   *  No execution — the position already exists on-chain/on-paper. */
  restorePosition(position: Position): void {
    if (this.positions.has(position.id)) return;
    this.positions.set(position.id, position);
    this.stateMachines.set(position.id, new PositionStateMachine(position.status));
    this.logger.warn("Position restored from persistence", {
      positionId: position.id,
      token: position.tokenAddress,
      status: position.status,
      entryPrice: position.entryPrice,
      ageHours: ((Date.now() - position.openedAt.getTime()) / 3_600_000).toFixed(1),
    });
  }

  getOpenPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === "OPEN");
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  getAllPositions(): Position[] {
    return [...this.positions.values()];
  }

  getTotalExposureUsd(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.sizeUsd, 0);
  }

  getTokenExposureUsd(tokenAddress: string): number {
    return this.getOpenPositions()
      .filter((p) => p.tokenAddress === tokenAddress)
      .reduce((sum, p) => sum + p.sizeUsd, 0);
  }
}
