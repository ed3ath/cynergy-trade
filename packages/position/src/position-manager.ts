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
  type PaperFillAccounting,
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
  liquidity?: LiquiditySnapshot;
  security?: SecurityAssessment;
  timestampMs: number;
}

export const EMERGENCY_LIQUIDITY_FLOOR_USD = 20_000;

export class PositionManager {
  private positions = new Map<string, Position>();
  private stateMachines = new Map<string, PositionStateMachine>();
  private inFlight = new Set<string>();
  private appliedOrders = new Map<string, string>();
  private appliedIntents = new Set<string>();
  private lastAccounting = new Map<string, PaperFillAccounting>();

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
    this.validateFill(result, intent);
    if (intent.side !== "BUY" || !Number.isFinite(intent.positionSizeUsd) || intent.positionSizeUsd <= 0
        || !Number.isFinite(stopLoss) || stopLoss <= 0
        || [takeProfit1, takeProfit2, trailingStopPct, timeStopMs]
          .some((v) => v !== undefined && (!Number.isFinite(v) || v <= 0))) {
      throw new Error("Invalid position entry or exit parameters");
    }
    if (this.appliedOrders.has(result.orderId) || this.appliedIntents.has(intent.id)) {
      throw new Error(`Duplicate position entry ${result.orderId}`);
    }
    const id = generatePositionId();
    const entryPrice = result.executedPrice;
    const sizeUsd = intent.mode === "PAPER" ? Number(result.inputAmount) / 1e6 : intent.positionSizeUsd;
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0
        || (intent.mode === "PAPER" && !Number.isSafeInteger(Number(result.inputAmount)))
        || (intent.mode === "PAPER" && result.inputAmount !== BigInt(Math.round(intent.positionSizeUsd * 1e6)))) {
      throw new Error("PAPER entry cash does not match the confirmed intent");
    }

    const position: Position = {
      id,
      tokenAddress: intent.tokenAddress,
      chain: intent.chain,
      status: "OPEN",
      mode: intent.mode,
      strategyId: intent.strategyId,
      entryPrice,
      currentPrice: entryPrice,
      sizeUsd,
      sizeTokens: result.outputAmount,
      stopLoss,
      peakPrice: entryPrice,
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      drawdownFromPeakPct: 0,
      openedAt: result.confirmedAt ?? new Date(),
      updatedAt: new Date(),
    };
    if (intent.mode === "PAPER") {
      position.accountingVersion = 2;
      position.initialSizeUsd = sizeUsd;
      position.initialSizeTokens = result.outputAmount;
      position.entryFeeUsd = result.feeUsd;
      position.remainingEntryFeeUsd = result.feeUsd;
      position.realizedPnlUsd = 0;
      position.realizedGrossPnlUsd = 0;
      position.totalFeesUsd = result.feeUsd;
      position.entryOrderId = result.orderId;
      this.markPosition(position, entryPrice);
      this.lastAccounting.set(id, {
        cashDeltaUsd: -sizeUsd - result.feeUsd,
        realizedPnlDeltaUsd: 0,
        realizedGrossPnlDeltaUsd: 0,
        soldCostBasisUsd: 0,
        allocatedEntryFeeUsd: 0,
      });
    }
    if (takeProfit1 !== undefined)    position.takeProfit1      = takeProfit1;
    if (takeProfit2 !== undefined)    position.takeProfit2      = takeProfit2;
    if (trailingStopPct !== undefined) position.trailingStopPct = trailingStopPct;
    if (timeStopMs !== undefined)     position.timeStopMs       = timeStopMs;
    if (result.txSignature)           position.entryTxSignature = result.txSignature;

    const sm = new PositionStateMachine("OPEN");
    this.positions.set(id, position);
    this.stateMachines.set(id, sm);
    this.appliedOrders.set(result.orderId, id);
    this.appliedIntents.add(intent.id);

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
    if (!position || (position.status !== "OPEN" && position.status !== "PARTIAL_EXIT")) return null;

    const price = input.market.priceUsd;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(input.timestampMs)) return null;
    this.markPosition(position, price);
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
    if (!position || (position.status !== "OPEN" && position.status !== "PARTIAL_EXIT")) {
      return { applied: {}, clamped: ["unknown-position"] };
    }

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
      if (position.status === "PARTIAL_EXIT" && position.takeProfit1 === undefined) {
        clamped.push("takeProfit1-already-spent");
      } else if (position.takeProfit1 === undefined || opts.takeProfit1 < position.takeProfit1) {
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
    if (input.liquidity && Number.isFinite(input.liquidity.liquidityUsd)
        && input.liquidity.liquidityUsd >= 0 && input.liquidity.liquidityUsd < EMERGENCY_LIQUIDITY_FLOOR_USD) {
      return {
        reason: `Liquidity collapsed: $${input.liquidity.liquidityUsd.toFixed(0)}`,
        urgency: "URGENT",
        suggestedSellPct: 100,
      };
    }
    if (input.liquidity && Number.isFinite(input.liquidity.liquidityChange5m)
        && input.liquidity.liquidityChange5m < -30) {
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
        suggestedSellPct: 100,
      };
    }
    if (position.takeProfit1 && price >= position.takeProfit1) {
      return {
        reason: `Take profit 1 hit: ${price.toFixed(8)} >= ${position.takeProfit1.toFixed(8)}`,
        urgency: "NORMAL",
        suggestedSellPct: 50,
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

  /** Sell exact remaining-token quantity, not a USD notional. Fractions round
   *  down to the smallest token unit; the final exit consumes that remainder. */
  async reducePosition(
    positionId: string,
    sellFraction: number,
    currentPriceUsd: number,
    intent: TradeIntent,
  ): Promise<{ result: ExecutionResult; position: Position; accounting?: PaperFillAccounting }> {
    if (!Number.isFinite(sellFraction) || sellFraction <= 0 || sellFraction >= 1) {
      throw new Error(`sellFraction must be in (0,1), got ${sellFraction}`);
    }
    const result = await this.sellPosition(positionId, sellFraction, currentPriceUsd, intent);
    const position = this.positions.get(positionId)!;
    const accounting = this.lastAccounting.get(positionId);
    return accounting ? { result, position, accounting: { ...accounting } } : { result, position };
  }

  /** Execute an exit for a given position. */
  async exitPosition(
    positionId: string,
    signal: ExitSignal,
    currentPriceUsd: number,
    intent: TradeIntent,
  ): Promise<ExecutionResult> {
    return this.sellPosition(positionId, 1, currentPriceUsd, intent, signal.reason);
  }

  private async sellPosition(
    positionId: string,
    fraction: number,
    currentPriceUsd: number,
    intent: TradeIntent,
    reason?: string,
  ): Promise<ExecutionResult> {
    const position = this.positions.get(positionId);
    const sm = this.stateMachines.get(positionId);
    if (!position || !sm) throw new Error(`Position ${positionId} not found`);
    if ((position.status !== "OPEN" && position.status !== "PARTIAL_EXIT") || this.inFlight.has(positionId)) {
      throw new Error(`Position ${positionId} not open for sell or execution already in flight`);
    }
    if (this.appliedIntents.has(intent.id)) throw new Error(`Duplicate sell intent ${intent.id}`);
    if (position.dataQuality?.includes("legacy-quantity-unresolved")) {
      throw new Error("Legacy remaining quantity is unresolved; retain exposure for reconciliation");
    }
    if (intent.side !== "SELL" || intent.mode !== position.mode || intent.chain !== position.chain
        || intent.tokenAddress !== position.tokenAddress || intent.strategyId !== position.strategyId
        || (intent.positionId !== undefined && intent.positionId !== position.id)
        || !Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0
        || !Number.isFinite(intent.positionSizeUsd) || intent.positionSizeUsd <= 0
        || !Number.isFinite(position.sizeUsd) || position.sizeUsd <= 0 || position.sizeTokens <= 0n) {
      throw new Error("Invalid sell identity, price, or remaining position size");
    }
    if (position.accountingVersion === 2) this.validateAccounting(position);
    const quantity = fraction === 1 ? position.sizeTokens
      : fraction === 0.5 ? position.sizeTokens / 2n
      : position.sizeTokens * BigInt(Math.floor(fraction * 1e9)) / 1_000_000_000n;
    if (quantity <= 0n || quantity > position.sizeTokens || (fraction < 1 && quantity === position.sizeTokens)) {
      throw new Error("Sell quantity is empty or exceeds remaining tokens");
    }
    if (position.mode === "PAPER" && intent.paperTokenQuantity !== undefined && intent.paperTokenQuantity !== quantity) {
      throw new Error("PAPER sell quantity does not match the requested position fraction");
    }
    const executionIntent = position.mode === "PAPER"
      ? { ...intent, positionId, paperTokenQuantity: quantity } : intent;
    this.inFlight.add(positionId);
    try {
      const result = await this.executionRouter.execute(executionIntent, currentPriceUsd);
      this.validateFill(result, executionIntent);
      if (this.appliedOrders.has(result.orderId)) throw new Error(`Duplicate sell order ${result.orderId}`);
      // Provider-native token amounts are never converted using PAPER scales.
      const soldTokens = result.inputAmount;
      if (soldTokens > position.sizeTokens || (position.mode === "PAPER" && soldTokens !== quantity)
          || (fraction === 1 && soldTokens !== position.sizeTokens)
          || (fraction < 1 && soldTokens === position.sizeTokens)) {
        throw new Error("Confirmed sell quantity does not match remaining position tokens");
      }
      const soldFraction = fraction === 1 ? 1 : Number(soldTokens) / Number(position.sizeTokens);
      const soldBasis = fraction === 1 ? position.sizeUsd : position.sizeUsd * soldFraction;
      const next: Position = {
        ...position,
        sizeTokens: position.sizeTokens - soldTokens,
        sizeUsd: fraction === 1 ? 0 : position.sizeUsd - soldBasis,
        currentPrice: result.executedPrice,
        status: fraction === 1 ? "CLOSED" : "PARTIAL_EXIT",
        exitOrderId: result.orderId,
        updatedAt: result.confirmedAt ?? new Date(),
      };
      if (reason !== undefined) next.exitReason = reason;
      delete next.takeProfit1;
      if (fraction === 1) next.closedAt = result.confirmedAt ?? new Date();
      let accounting: PaperFillAccounting | undefined;
      if (position.mode === "PAPER") {
        const proceeds = Number(result.outputAmount) / 1e6;
        if (!Number.isFinite(proceeds) || !Number.isSafeInteger(Number(result.outputAmount))) {
          throw new Error("Invalid PAPER proceeds");
        }
        accounting = {
          cashDeltaUsd: proceeds - result.feeUsd,
          realizedPnlDeltaUsd: null,
          realizedGrossPnlDeltaUsd: null,
          soldCostBasisUsd: null,
          allocatedEntryFeeUsd: null,
        };
        if (position.accountingVersion === 2) {
          const allocatedEntryFee = fraction === 1 ? position.remainingEntryFeeUsd!
            : position.remainingEntryFeeUsd! * soldFraction;
          const gross = proceeds - soldBasis;
          const net = gross - allocatedEntryFee - result.feeUsd;
          next.remainingEntryFeeUsd = fraction === 1 ? 0 : position.remainingEntryFeeUsd! - allocatedEntryFee;
          next.realizedGrossPnlUsd = position.realizedGrossPnlUsd! + gross;
          next.realizedPnlUsd = position.realizedPnlUsd! + net;
          next.totalFeesUsd = position.totalFeesUsd! + result.feeUsd;
          accounting = {
            cashDeltaUsd: proceeds - result.feeUsd,
            realizedPnlDeltaUsd: net,
            realizedGrossPnlDeltaUsd: gross,
            soldCostBasisUsd: soldBasis,
            allocatedEntryFeeUsd: allocatedEntryFee,
          };
        }
      }
      if (position.accountingVersion === 2) this.validateAccounting(next);
      if (fraction === 1 && position.accountingVersion !== 2) {
        next.dataQuality = [...new Set([...(position.dataQuality ?? []), "legacy-realized-pnl-unknown"])];
      } else {
        this.markPosition(next, result.executedPrice);
      }
      if (fraction === 1) {
        sm.transition("CLOSING");
        sm.transition("CLOSED");
      } else if (sm.status === "OPEN") {
        sm.transition("PARTIAL_EXIT");
      }
      Object.assign(position, next);
      delete position.takeProfit1;
      this.appliedOrders.set(result.orderId, positionId);
      this.appliedIntents.add(intent.id);
      if (accounting) this.lastAccounting.set(positionId, accounting);
      this.logger.info(fraction === 1 ? "Position closed" : "Position reduced", {
        positionId, soldTokens: soldTokens.toString(), remainingUsd: position.sizeUsd,
        realizedPnlUsd: accounting?.realizedPnlDeltaUsd, executedPrice: result.executedPrice,
      });
      return result;
    } catch (err) {
      // An unknown real fill must remain exposure, never silently become an
      // executable OPEN position again. PAPER failures have no external fill.
      if (position.mode !== "PAPER") {
        position.status = "CLOSING";
        this.stateMachines.set(positionId, new PositionStateMachine("CLOSING"));
        position.updatedAt = new Date();
      }
      throw err;
    } finally {
      this.inFlight.delete(positionId);
    }
  }

  /** Restore exact persisted remaining sizes. Transient/unknown states stay
   *  unresolved exposure until reconciled; restoration never retries a fill. */
  restorePosition(position: Position): void {
    if (this.positions.has(position.id)) return;
    if (position.accountingVersion === 2) {
      try {
        this.validateAccounting(position);
      } catch {
        position.status = "ERROR";
        position.dataQuality = [...new Set([...(position.dataQuality ?? []), "invalid-accounting"])];
      }
    } else {
      position.dataQuality = [...new Set([...(position.dataQuality ?? []), "legacy-unreconciled"])];
      if (position.status === "PARTIAL_EXIT" && !position.exitOrderId) {
        position.dataQuality.push("legacy-quantity-unresolved");
      }
    }
    if (position.entryOrderId) this.appliedOrders.set(position.entryOrderId, position.id);
    if (position.exitOrderId) this.appliedOrders.set(position.exitOrderId, position.id);
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
    return [...this.positions.values()]
      .filter((p) => p.status === "OPEN" || p.status === "PARTIAL_EXIT");
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  getAllPositions(): Position[] {
    return [...this.positions.values()];
  }

  getExposurePositions(): Position[] {
    return this.getAllPositions().filter((p) => p.status !== "CLOSED");
  }

  getLastAccounting(positionId: string): PaperFillAccounting | undefined {
    const accounting = this.lastAccounting.get(positionId);
    return accounting ? { ...accounting } : undefined;
  }

  getTotalExposureUsd(): number {
    return this.getExposurePositions().reduce((sum, p) => sum + (Number.isFinite(p.sizeUsd) && p.sizeUsd >= 0 ? p.sizeUsd : Infinity), 0);
  }

  getTokenExposureUsd(tokenAddress: string): number {
    return this.getExposurePositions()
      .filter((p) => p.tokenAddress === tokenAddress)
      .reduce((sum, p) => sum + (Number.isFinite(p.sizeUsd) && p.sizeUsd >= 0 ? p.sizeUsd : Infinity), 0);
  }

  private validateFill(result: ExecutionResult, intent: TradeIntent): void {
    if (result.status !== "CONFIRMED") throw new Error(`Execution not confirmed (${result.status}); holdings unchanged`);
    if (result.tradeIntentId !== intent.id || result.mode !== intent.mode || !result.orderId
        || typeof result.inputAmount !== "bigint" || typeof result.outputAmount !== "bigint"
        || result.inputAmount <= 0n || result.outputAmount <= 0n
        || !Number.isFinite(result.executedPrice) || result.executedPrice <= 0
        || !Number.isFinite(result.feeUsd) || result.feeUsd < 0
        || !Number.isFinite(result.actualSlippageBps) || result.actualSlippageBps < 0
        || (result.confirmedAt !== undefined && !Number.isFinite(result.confirmedAt.getTime()))) {
      throw new Error("Invalid confirmed execution result");
    }
  }

  private validateAccounting(position: Position): void {
    if (position.mode !== "PAPER" || !position.entryOrderId
        || ![position.sizeUsd, position.initialSizeUsd, position.entryFeeUsd, position.remainingEntryFeeUsd,
          position.realizedPnlUsd, position.realizedGrossPnlUsd, position.totalFeesUsd]
          .every((v) => typeof v === "number" && Number.isFinite(v))
        || position.sizeUsd < 0 || position.initialSizeUsd! <= 0 || position.sizeUsd > position.initialSizeUsd!
        || position.entryFeeUsd! < 0 || position.remainingEntryFeeUsd! < 0
        || position.remainingEntryFeeUsd! > position.entryFeeUsd! || position.totalFeesUsd! < position.entryFeeUsd!
        || typeof position.sizeTokens !== "bigint" || position.sizeTokens < 0n || typeof position.initialSizeTokens !== "bigint"
        || position.initialSizeTokens <= 0n || position.sizeTokens > position.initialSizeTokens
        || (position.status === "PARTIAL_EXIT" && (!position.exitOrderId || position.takeProfit1 !== undefined))
        || (position.status === "CLOSED" && (position.sizeTokens !== 0n || position.sizeUsd !== 0 || position.remainingEntryFeeUsd !== 0
          || !position.exitOrderId || !position.closedAt || !Number.isFinite(position.closedAt.getTime())))) {
      throw new Error(`Unreconciled PAPER accounting for ${position.id}`);
    }
    const ratio = Number(position.sizeTokens) / Number(position.initialSizeTokens);
    const consistent = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b)
      && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (!consistent(position.sizeUsd, position.initialSizeUsd! * ratio)
        || !consistent(position.remainingEntryFeeUsd!, position.entryFeeUsd! * ratio)
        || !consistent(position.realizedPnlUsd!, position.realizedGrossPnlUsd! - position.totalFeesUsd! + position.remainingEntryFeeUsd!)) {
      throw new Error(`Inconsistent PAPER cost basis or fees for ${position.id}`);
    }
  }

  private markPosition(position: Position, price: number): void {
    const peak = Math.max(position.peakPrice, price);
    const pnl = position.mode === "PAPER" && position.accountingVersion === 2
      ? Number(position.sizeTokens) / 1e9 * price - position.sizeUsd - position.remainingEntryFeeUsd!
      : position.sizeUsd * ((price - position.entryPrice) / position.entryPrice);
    const pct = position.sizeUsd > 0 ? pnl / position.sizeUsd * 100 : 0;
    const drawdown = peak > 0 ? (peak - price) / peak * 100 : 0;
    if (![pnl, pct, drawdown, peak].every(Number.isFinite)) throw new Error("Non-finite position mark");
    position.currentPrice = price;
    position.peakPrice = peak;
    position.unrealizedPnlUsd = pnl;
    position.unrealizedPnlPct = pct;
    position.drawdownFromPeakPct = drawdown;
  }
}
