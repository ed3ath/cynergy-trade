/**
 * Trade journal repositories — immutable append-only records.
 * Every decision, risk evaluation, order, and position event is persisted
 * with the full context needed to reproduce why the system acted.
 */
import type {
  Chain,
  TokenDiscoveredEvent,
  MarketSnapshot,
  LiquiditySnapshot,
  HolderSnapshot,
  SecurityAssessment,
  TradeIntent,
  RiskDecision,
  StrategyDecision,
  ExecutionResult,
  PortfolioSnapshot,
  Position,
  PaperFillAccounting,
  TradeMode,
  TradeSide,
} from "@autonomous-trader/shared";
import type { Database } from "./database.js";

/** JSON-array columns come back parsed (pg jsonb) or as raw text (SQLite TEXT).
 *  Never spread/inspect the raw value before normalising it. */
function asStringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export interface AccountingFilter {
  mode: TradeMode;
  chain?: Chain;
  strategyId?: string;
  accountingVersion?: 1 | 2;
  from?: Date;
  to?: Date;
}

export interface AccountingFill extends PaperFillAccounting {
  orderId: string;
  tradeIntentId: string;
  positionId: string;
  tokenAddress: string;
  chain: Chain;
  strategyId: string;
  mode: TradeMode;
  side: TradeSide;
  accountingVersion: 1 | 2;
  inputAmount: bigint;
  outputAmount: bigint;
  feeUsd: number;
  confirmedAt: Date;
  dataQuality: string[];
}

export interface PaperAccountingState {
  source: "durable" | "session-only";
  complete: boolean;
  fills: AccountingFill[];
  legacyPositions: number;
  legacyOrders: number;
  unresolvedPositions: number;
  unreconciledOrders: number;
  issues: string[];
}

export interface ClosedTrade {
  id: string;
  tokenAddress: string;
  chain: Chain;
  strategyId: string;
  mode: TradeMode;
  accountingVersion: 1 | 2;
  entryPrice: number;
  sizeUsd: number;
  sizeTokens: string | null;
  initialSizeUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number;
  realizedGrossPnlUsd: number | null;
  totalFeesUsd: number | null;
  entryOrderId: string | null;
  exitOrderId: string | null;
  exitReason: string | null;
  dataQuality: string[];
  openedAt: Date;
  closedAt: Date | null;
}

export class JournalRepository {
  readonly durable: boolean = true;
  private positionWrites = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Database) {}

  // ─── Tokens ────────────────────────────────────────────────────────────────
  async upsertToken(event: TokenDiscoveredEvent, status: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tokens (address, chain, status, first_seen_at, last_updated_at, discovery_source, discovery_pool)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6)
       ON CONFLICT (address, chain)
       DO UPDATE SET last_updated_at = NOW(), status = EXCLUDED.status`,
      [event.tokenAddress, event.chain, status, event.firstSeenAt, event.source, event.pool ?? null],
    );
  }

  async updateTokenStatus(address: string, chain: string, status: string): Promise<void> {
    await this.db.query(
      `UPDATE tokens SET status = $3, last_updated_at = NOW() WHERE address = $1 AND chain = $2`,
      [address, chain, status],
    );
  }

  // ─── Snapshots (append-only time series) ───────────────────────────────────
  async recordMarketSnapshot(snap: MarketSnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO token_market_snapshots
        (token_address, chain, price_usd, market_cap_usd, volume_usd_1m, volume_usd_5m,
         volume_usd_15m, volume_usd_1h, volume_usd_24h, price_change_1m, price_change_5m,
         price_change_15m, price_change_1h, price_change_24h, buy_count_1m, sell_count_1m,
         buy_volume_usd_1m, sell_volume_usd_1m, unique_buyers_1m, unique_sellers_1m,
         trade_count_24h, provider, confidence, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [snap.tokenAddress, snap.chain, snap.priceUsd, snap.marketCapUsd ?? null,
       snap.volumeUsd1m, snap.volumeUsd5m, snap.volumeUsd15m, snap.volumeUsd1h, snap.volumeUsd24h,
       snap.priceChange1m, snap.priceChange5m, snap.priceChange15m, snap.priceChange1h, snap.priceChange24h,
       snap.buyCount1m, snap.sellCount1m, snap.buyVolumeUsd1m, snap.sellVolumeUsd1m,
       snap.uniqueBuyers1m, snap.uniqueSellers1m, snap.tradeCount24h,
       snap.provider, snap.confidence, snap.observedAt],
    );
  }

  async recordLiquiditySnapshot(snap: LiquiditySnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO liquidity_snapshots
        (token_address, chain, pool_address, dex, liquidity_usd, pool_age_ms,
         slippage_bps_50, slippage_bps_500, slippage_bps_5000,
         liquidity_change_5m, liquidity_change_15m, provider, confidence, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [snap.tokenAddress, snap.chain, snap.poolAddress, snap.dex, snap.liquidityUsd,
       snap.poolAgeMs, snap.estimatedSlippageBps50, snap.estimatedSlippageBps500,
       snap.estimatedSlippageBps5000, snap.liquidityChange5m, snap.liquidityChange15m,
       snap.provider, snap.confidence, snap.observedAt],
    );
  }

  async recordHolderSnapshot(snap: HolderSnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO holder_snapshots
        (token_address, chain, total_holders, top1_pct, top5_pct, top10_pct, top20_pct,
         creator_pct, insider_pct, sniper_pct, bundler_pct, whale_pct,
         holder_growth_5m, holder_growth_15m, holder_growth_1h,
         concentration_chg_5m, concentration_chg_15m, provider, confidence, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [snap.tokenAddress, snap.chain, snap.totalHolders, snap.top1Pct, snap.top5Pct,
       snap.top10Pct, snap.top20Pct, snap.creatorPct, snap.insiderPct, snap.sniperPct,
       snap.bundlerPct, snap.whalePct, snap.holderGrowth5m, snap.holderGrowth15m,
       snap.holderGrowth1h, snap.concentrationChange5m, snap.concentrationChange15m,
       snap.provider, snap.confidence, snap.observedAt],
    );
  }

  async recordSecurityAssessment(assessment: SecurityAssessment): Promise<void> {
    await this.db.query(
      `INSERT INTO security_assessments
        (token_address, chain, status, score, reasons, provider_results, confidence, checked_at, data_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [assessment.tokenAddress, assessment.chain, assessment.status, assessment.score,
       JSON.stringify(assessment.reasons), JSON.stringify(assessment.providerResults),
       assessment.confidence, assessment.checkedAt, assessment.dataTimestamp],
    );
  }

  // ─── Decisions ─────────────────────────────────────────────────────────────
  async recordStrategyDecision(
    decision: StrategyDecision,
    featureSnapshot: unknown,
    chain: Chain = "solana",
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO strategy_decisions
        (strategy_id, strategy_version, token_address, chain, decision, confidence,
         reasons, risks, invalidation_conds, suggested_entry, suggested_stop,
         suggested_tp1, suggested_tp2, feature_snapshot, evaluated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [decision.strategyId, decision.strategyVersion, decision.tokenAddress, chain,
       decision.decision, decision.confidence, JSON.stringify(decision.reasons),
       JSON.stringify(decision.risks), JSON.stringify(decision.invalidationConditions),
       decision.suggestedEntryPrice ?? null, decision.suggestedStopLoss ?? null,
       decision.suggestedTakeProfit1 ?? null, decision.suggestedTakeProfit2 ?? null,
       JSON.stringify(featureSnapshot), decision.evaluatedAt],
    );
  }

  // ─── Trade pipeline ────────────────────────────────────────────────────────
  async recordTradeIntent(intent: TradeIntent): Promise<void> {
    await this.db.query(
      `INSERT INTO trade_intents
        (id, token_address, chain, side, mode, strategy_id, strategy_version, risk_version,
         position_size_usd, max_slippage_bps, max_price_impact_bps, reason, created_at, expires_at,
         paper_token_quantity, position_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [intent.id, intent.tokenAddress, intent.chain, intent.side, intent.mode,
       intent.strategyId, intent.strategyVersion, intent.riskVersion,
       intent.positionSizeUsd, intent.maxSlippageBps, intent.maxPriceImpactBps,
        intent.reason, intent.createdAt, intent.expiresAt,
        intent.paperTokenQuantity?.toString() ?? null, intent.positionId ?? null],
    );
  }

  async recordRiskDecision(decision: RiskDecision): Promise<void> {
    await this.db.query(
      `INSERT INTO risk_decisions
        (trade_intent_id, decision, rejection_reasons, approved_size_usd,
         approved_risk_fraction, max_slippage_bps, risk_version, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [decision.tradeIntentId, decision.decision, JSON.stringify(decision.rejectionReasons),
       decision.approvedPositionSizeUsd, decision.approvedRiskFraction,
       decision.maxSlippageBps, decision.riskVersion, decision.decidedAt],
    );
  }

  async recordExecutionResult(result: ExecutionResult, intent: TradeIntent): Promise<void> {
    await this.db.query(
      `INSERT INTO orders
        (id, trade_intent_id, token_address, chain, side, mode, status, tx_signature,
         actual_input, actual_output, actual_price, actual_slippage_bps, fee_usd,
         confirmed_at, created_at, submitted_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW(),NOW())
        ON CONFLICT (id) DO NOTHING`,
      [result.orderId, result.tradeIntentId, intent.tokenAddress, intent.chain, intent.side,
       result.mode, result.status, result.txSignature ?? null,
       result.inputAmount.toString(), result.outputAmount.toString(),
       result.executedPrice, result.actualSlippageBps, result.feeUsd,
       result.confirmedAt ?? null],
    );
  }

  async recordOrderStatusUpdate(orderId: string, status: string, error?: string): Promise<void> {
    await this.db.query(
      `UPDATE orders SET status = $2, error_message = $3, updated_at = NOW()
       WHERE id = $1 AND (cash_delta_usd IS NULL OR status = $2)`,
      [orderId, status, error ?? null],
    );
  }

  // ─── Positions ─────────────────────────────────────────────────────────────
  async insertPosition(position: Position): Promise<void> {
    const snapshot = structuredClone(position);
    await this.serializePositionWrite(position.id, () => this.insertPositionRow(this.db, snapshot));
  }

  private async insertPositionRow(writer: Pick<Database, "query">, position: Position): Promise<void> {
    await writer.query(
      `INSERT INTO positions
        (id, token_address, chain, status, mode, strategy_id, strategy_version,
         entry_price, current_price, size_usd, size_tokens, stop_loss,
         take_profit_1, take_profit_2, trailing_stop_pct, peak_price,
          opened_at, updated_at, entry_order_id, exit_reason, accounting_version,
          initial_size_usd, initial_size_tokens, entry_fee_usd, remaining_entry_fee_usd,
          realized_pnl_usd, realized_gross_pnl_usd, total_fees_usd, exit_order_id, closed_at,
          unrealized_pnl_usd, unrealized_pnl_pct, drawdown_from_peak_pct, data_quality)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)`,
      [position.id, position.tokenAddress, position.chain, position.status, position.mode,
       position.strategyId, "1.0.0", position.entryPrice, position.currentPrice,
       position.sizeUsd, position.sizeTokens.toString(), position.stopLoss,
       position.takeProfit1 ?? null, position.takeProfit2 ?? null,
       position.trailingStopPct ?? null, position.peakPrice,
        position.openedAt, position.updatedAt, position.entryOrderId ?? null, position.exitReason ?? null,
        position.accountingVersion ?? 1, position.initialSizeUsd ?? null, position.initialSizeTokens?.toString() ?? null,
        position.entryFeeUsd ?? null, position.remainingEntryFeeUsd ?? null, position.realizedPnlUsd ?? 0,
        position.realizedGrossPnlUsd ?? null, position.totalFeesUsd ?? null,
        position.exitOrderId ?? null, position.closedAt ?? null,        position.unrealizedPnlUsd, position.unrealizedPnlPct, position.drawdownFromPeakPct, JSON.stringify(position.dataQuality ?? [])],
    );
  }

  /** Full state write-back — exit params included so restart restores the
   *  tightened stops, not the entry-time ones. */
  async updatePosition(position: Position): Promise<void> {
    const snapshot = structuredClone(position);
    await this.serializePositionWrite(position.id, () => this.updatePositionRow(this.db, snapshot, false));
  }

  private async updatePositionRow(writer: Pick<Database, "query">, position: Position, confirmedFill: boolean): Promise<void> {
    const updated = await writer.query(
      `UPDATE positions SET
         status = $2, current_price = $3, peak_price = $4,
         unrealized_pnl_usd = $5, unrealized_pnl_pct = $6,
         drawdown_from_peak_pct = $7, exit_reason = $8,
         stop_loss = $9, take_profit_1 = $10, take_profit_2 = $11,
          trailing_stop_pct = $12, size_usd = $13, size_tokens = $14,
          realized_pnl_usd = COALESCE($15, realized_pnl_usd), realized_gross_pnl_usd = $16,
          total_fees_usd = $17, remaining_entry_fee_usd = $18,
          entry_order_id = $19, exit_order_id = $20, closed_at = $21,
          data_quality = $22, updated_at = $23
        WHERE id = $1 AND accounting_version = $24
          AND ($25 OR ((mode <> 'PAPER' OR exit_order_id IS NOT DISTINCT FROM $20) AND updated_at <= $23
                       AND (status <> 'CLOSED' OR $2::position_status = 'CLOSED')))`,
      [position.id, position.status, position.currentPrice, position.peakPrice,
       position.unrealizedPnlUsd, position.unrealizedPnlPct,
       position.drawdownFromPeakPct, position.exitReason ?? null,
       position.stopLoss, position.takeProfit1 ?? null, position.takeProfit2 ?? null,
        position.trailingStopPct ?? null, position.sizeUsd, position.sizeTokens.toString(),
        position.realizedPnlUsd ?? null, position.realizedGrossPnlUsd ?? null, position.totalFeesUsd ?? null,
        position.remainingEntryFeeUsd ?? null, position.entryOrderId ?? null, position.exitOrderId ?? null,
        position.closedAt ?? null, JSON.stringify(position.dataQuality ?? []), position.updatedAt,
        position.accountingVersion ?? 1, confirmedFill],
    );
    if (confirmedFill && updated.rowCount !== 1) throw new Error(`Confirmed PAPER position write failed for ${position.id}`);
  }

  /** The order itself is the cash/PnL ledger fact. A duplicate never reapplies
   *  its position snapshot; a conflicting identity fails closed. */
  async recordConfirmedPaperFill(
    result: ExecutionResult,
    intent: TradeIntent,
    position: Position,
    facts: PaperFillAccounting,
  ): Promise<boolean> {
    intent = structuredClone(intent);
    const snapshot = structuredClone(position);
    const fill = structuredClone(result);
    const accounting = { ...facts };
    const version = snapshot.accountingVersion ?? 1;
    const closeEnough = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b)
      && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (fill.status !== "CONFIRMED" || fill.mode !== "PAPER" || intent.mode !== "PAPER" || snapshot.mode !== "PAPER"
        || fill.tradeIntentId !== intent.id || snapshot.tokenAddress !== intent.tokenAddress
        || snapshot.chain !== intent.chain || snapshot.strategyId !== intent.strategyId
        || !fill.confirmedAt || !Number.isFinite(fill.confirmedAt.getTime())
        || typeof fill.inputAmount !== "bigint" || typeof fill.outputAmount !== "bigint"
        || fill.inputAmount <= 0n || fill.outputAmount <= 0n
        || !Number.isFinite(fill.executedPrice) || fill.executedPrice <= 0
        || !Number.isFinite(fill.feeUsd) || fill.feeUsd < 0
        || !Number.isFinite(accounting.cashDeltaUsd)
        || Object.values(accounting).some((v) => v !== null && !Number.isFinite(v))
        || !Number.isFinite(snapshot.sizeUsd) || snapshot.sizeUsd < 0 || typeof snapshot.sizeTokens !== "bigint" || snapshot.sizeTokens < 0n
        || ![snapshot.entryPrice, snapshot.currentPrice, snapshot.peakPrice, snapshot.stopLoss,
          snapshot.unrealizedPnlUsd, snapshot.unrealizedPnlPct, snapshot.drawdownFromPeakPct,
          snapshot.openedAt.getTime(), snapshot.updatedAt.getTime(), fill.actualSlippageBps].every(Number.isFinite)
        || snapshot.entryPrice <= 0 || snapshot.currentPrice <= 0 || snapshot.stopLoss <= 0
        || (version === 2 && Object.values(accounting).some((v) => v === null))) {
      throw new Error("Invalid confirmed PAPER accounting fact");
    }
    const cash = intent.side === "BUY" ? -Number(fill.inputAmount) / 1e6 - fill.feeUsd
      : Number(fill.outputAmount) / 1e6 - fill.feeUsd;
    if (!closeEnough(accounting.cashDeltaUsd, cash)) throw new Error("PAPER cash delta does not match fill");
    if (intent.side === "BUY") {
      if (version !== 2 || snapshot.status !== "OPEN" || snapshot.entryOrderId !== fill.orderId
          || snapshot.sizeTokens !== fill.outputAmount || snapshot.initialSizeTokens !== fill.outputAmount
          || !closeEnough(snapshot.sizeUsd, Number(fill.inputAmount) / 1e6)
          || !closeEnough(snapshot.initialSizeUsd!, snapshot.sizeUsd)
          || !closeEnough(snapshot.entryFeeUsd!, fill.feeUsd) || !closeEnough(snapshot.remainingEntryFeeUsd!, fill.feeUsd)
          || !closeEnough(snapshot.totalFeesUsd!, fill.feeUsd) || snapshot.realizedPnlUsd !== 0
          || snapshot.realizedGrossPnlUsd !== 0 || accounting.realizedPnlDeltaUsd !== 0
          || accounting.realizedGrossPnlDeltaUsd !== 0 || accounting.soldCostBasisUsd !== 0
          || accounting.allocatedEntryFeeUsd !== 0) {
        throw new Error("PAPER entry position does not match fill accounting");
      }
    } else {
      if (intent.positionId !== snapshot.id || intent.paperTokenQuantity !== fill.inputAmount
          || snapshot.exitOrderId !== fill.orderId || !["PARTIAL_EXIT", "CLOSED"].includes(snapshot.status)
          || (snapshot.status === "CLOSED" && (snapshot.sizeTokens !== 0n || snapshot.sizeUsd !== 0 || !snapshot.closedAt))) {
        throw new Error("PAPER exit position does not match fill accounting");
      }
      if (version === 2 && (!closeEnough(accounting.realizedGrossPnlDeltaUsd!, Number(fill.outputAmount) / 1e6 - accounting.soldCostBasisUsd!)
          || !closeEnough(accounting.realizedPnlDeltaUsd!, accounting.realizedGrossPnlDeltaUsd! - accounting.allocatedEntryFeeUsd! - fill.feeUsd))) {
        throw new Error("PAPER realized delta does not match proceeds, basis, and fees");
      }
      if (version === 1 && [accounting.realizedPnlDeltaUsd, accounting.realizedGrossPnlDeltaUsd,
        accounting.soldCostBasisUsd, accounting.allocatedEntryFeeUsd].some((v) => v !== null)) {
        throw new Error("Legacy PAPER fills cannot claim reconciled realization");
      }
    }

    return this.serializePositionWrite(snapshot.id, () => this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orders
          (id, trade_intent_id, token_address, chain, side, mode, status, tx_signature,
           actual_input, actual_output, actual_price, actual_slippage_bps, fee_usd, confirmed_at,
           created_at, submitted_at, updated_at, position_id, accounting_version,
           cash_delta_usd, realized_pnl_delta_usd, realized_gross_pnl_delta_usd,
           sold_cost_basis_usd, allocated_entry_fee_usd, data_quality)
         VALUES ($1,$2,$3,$4,$5,'PAPER','CONFIRMED',$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),NOW(),
                 $13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [fill.orderId, intent.id, intent.tokenAddress, intent.chain, intent.side, fill.txSignature ?? null,
         fill.inputAmount.toString(), fill.outputAmount.toString(), fill.executedPrice, fill.actualSlippageBps,
         fill.feeUsd, fill.confirmedAt, snapshot.id, version, accounting.cashDeltaUsd,
         accounting.realizedPnlDeltaUsd, accounting.realizedGrossPnlDeltaUsd, accounting.soldCostBasisUsd,
         accounting.allocatedEntryFeeUsd, JSON.stringify(snapshot.dataQuality ?? [])],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          trade_intent_id: string; position_id: string | null; status: string; mode: string;
          token_address: string; chain: string; side: string; actual_price: string; confirmed_at: Date;
          actual_input: string; actual_output: string; cash_delta_usd: string | null;
          accounting_version: number; realized_pnl_delta_usd: string | null; fee_usd: string;
          realized_gross_pnl_delta_usd: string | null; sold_cost_basis_usd: string | null; allocated_entry_fee_usd: string | null;
        }>(`SELECT trade_intent_id, position_id, status, mode, token_address, chain, side, actual_price, confirmed_at,
                   actual_input, actual_output, cash_delta_usd, accounting_version, realized_pnl_delta_usd, fee_usd,
                   realized_gross_pnl_delta_usd, sold_cost_basis_usd, allocated_entry_fee_usd
            FROM orders WHERE id = $1`, [fill.orderId]);
        const row = existing.rows[0];
        if (!row || row.trade_intent_id !== intent.id || row.position_id !== snapshot.id
            || row.status !== "CONFIRMED" || row.mode !== "PAPER" || row.accounting_version !== version
            || row.token_address !== intent.tokenAddress || row.chain !== intent.chain || row.side !== intent.side
            || !closeEnough(Number(row.actual_price), fill.executedPrice)
            || new Date(row.confirmed_at).getTime() !== fill.confirmedAt!.getTime()
            || BigInt(row.actual_input) !== fill.inputAmount || BigInt(row.actual_output) !== fill.outputAmount
            || row.cash_delta_usd === null || !closeEnough(Number(row.cash_delta_usd), accounting.cashDeltaUsd)
            || !closeEnough(Number(row.fee_usd), fill.feeUsd)
            || ([
              [row.realized_pnl_delta_usd, accounting.realizedPnlDeltaUsd],
              [row.realized_gross_pnl_delta_usd, accounting.realizedGrossPnlDeltaUsd],
              [row.sold_cost_basis_usd, accounting.soldCostBasisUsd],
              [row.allocated_entry_fee_usd, accounting.allocatedEntryFeeUsd],
            ] as const).some(([stored, value]) => value === null ? stored !== null
              : stored === null || !closeEnough(Number(stored), value))) {
          throw new Error(`Conflicting PAPER order identity ${fill.orderId}`);
        }
        return false;
      }
      const { rows } = await client.query<{
        token_address: string; chain: string; mode: string; status: string; accounting_version: number;
        size_tokens: string | null; size_usd: string; realized_pnl_usd: string;
        realized_gross_pnl_usd: string | null; total_fees_usd: string | null;
        remaining_entry_fee_usd: string | null; entry_order_id: string | null;
      }>(`SELECT token_address, chain, mode, status, accounting_version, size_tokens, size_usd,
                 realized_pnl_usd, realized_gross_pnl_usd, total_fees_usd, remaining_entry_fee_usd, entry_order_id
          FROM positions WHERE id = $1 FOR UPDATE`, [snapshot.id]);
      const previous = rows[0];
      if (intent.side === "BUY") {
        if (previous) throw new Error(`Position already exists for PAPER entry ${snapshot.id}`);
        await this.insertPositionRow(client, snapshot);
      } else {
        if (!previous || previous.mode !== "PAPER" || previous.chain !== snapshot.chain
            || previous.token_address !== snapshot.tokenAddress || previous.accounting_version !== version
            || !["OPEN", "PARTIAL_EXIT"].includes(previous.status) || previous.size_tokens === null
            || BigInt(previous.size_tokens) !== snapshot.sizeTokens + fill.inputAmount) {
          throw new Error(`PAPER position quantity or identity conflict ${snapshot.id}`);
        }
        if (version === 2 && (previous.entry_order_id !== snapshot.entryOrderId
            || !closeEnough(Number(previous.size_usd), snapshot.sizeUsd + accounting.soldCostBasisUsd!)
            || !closeEnough(Number(previous.realized_pnl_usd) + accounting.realizedPnlDeltaUsd!, snapshot.realizedPnlUsd!)
            || previous.realized_gross_pnl_usd === null
            || !closeEnough(Number(previous.realized_gross_pnl_usd) + accounting.realizedGrossPnlDeltaUsd!, snapshot.realizedGrossPnlUsd!)
            || previous.remaining_entry_fee_usd === null
            || !closeEnough(Number(previous.remaining_entry_fee_usd), snapshot.remainingEntryFeeUsd! + accounting.allocatedEntryFeeUsd!)
            || previous.total_fees_usd === null
            || !closeEnough(Number(previous.total_fees_usd) + fill.feeUsd, snapshot.totalFeesUsd!))) {
          throw new Error(`PAPER position accounting conflict ${snapshot.id}`);
        }
        await this.updatePositionRow(client, snapshot, true);
      }
      return true;
    }));
  }

  private serializePositionWrite<T>(positionId: string, write: () => Promise<T>): Promise<T> {
    const pending = (this.positionWrites.get(positionId) ?? Promise.resolve()).catch(() => undefined).then(write);
    this.positionWrites.set(positionId, pending);
    const cleanup = () => {
      if (this.positionWrites.get(positionId) === pending) this.positionWrites.delete(positionId);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  async recordPositionEvent(
    positionId: string,
    eventType: string,
    price: number,
    pnlUsd: number,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO position_events (position_id, event_type, price, pnl_usd, details, occurred_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [positionId, eventType, price, pnlUsd, JSON.stringify(details)],
    );
  }

  // ─── Restore on restart ────────────────────────────────────────────────────
  /** Open positions for a mode — used to restore the position manager on boot. */
  async getOpenPositions(
    mode: "PAPER" | "SHADOW" | "LIVE",
    chain: Chain = "solana",
  ): Promise<Position[]> {
    const { rows } = await this.db.query<{
      id: string;
      token_address: string;
      chain: string;
      status: string;
      strategy_id: string;
      entry_price: string;
      current_price: string | null;
      size_usd: string;
      size_tokens: string | null;
      stop_loss: string;
      take_profit_1: string | null;
      take_profit_2: string | null;
      trailing_stop_pct: string | null;
      peak_price: string | null;
      unrealized_pnl_usd: string | null;
      unrealized_pnl_pct: string | null;
      drawdown_from_peak_pct: string | null;
      entry_tx_signature: string | null;
      exit_reason: string | null;
      accounting_version: 1 | 2;
      initial_size_usd: string | null;
      initial_size_tokens: string | null;
      entry_fee_usd: string | null;
      remaining_entry_fee_usd: string | null;
      realized_pnl_usd: string;
      realized_gross_pnl_usd: string | null;
      total_fees_usd: string | null;
      entry_order_id: string | null;
      exit_order_id: string | null;
      closed_at: Date | null;
      data_quality: string[] | null;
      opened_at: Date;
      updated_at: Date;
    }>(
      `SELECT p.id, p.token_address, p.chain, p.status, p.strategy_id,
              p.entry_price, p.current_price, p.size_usd, p.size_tokens,
              p.stop_loss, p.take_profit_1, p.take_profit_2, p.trailing_stop_pct,
              p.peak_price, p.unrealized_pnl_usd, p.unrealized_pnl_pct,
              p.drawdown_from_peak_pct, o.tx_signature AS entry_tx_signature,
               p.exit_reason, p.opened_at, p.updated_at, p.accounting_version,
               p.initial_size_usd, p.initial_size_tokens, p.entry_fee_usd, p.remaining_entry_fee_usd,
               p.realized_pnl_usd, p.realized_gross_pnl_usd, p.total_fees_usd,
               p.entry_order_id, p.exit_order_id, p.closed_at, p.data_quality
       FROM positions p
       LEFT JOIN orders o ON o.id = p.entry_order_id
        WHERE p.status IN ('OPENING','OPEN','PARTIAL_EXIT','CLOSING','ERROR') AND p.mode = $1 AND p.chain = $2
       ORDER BY p.opened_at`,
      [mode, chain],
    );

    return rows.map((r) => {
      const position: Position = {
        id: r.id,
        tokenAddress: r.token_address,
        chain: r.chain as Position["chain"],
        status: r.status as Position["status"],
        mode,
        strategyId: r.strategy_id,
        entryPrice: parseFloat(r.entry_price),
        currentPrice: r.current_price !== null ? parseFloat(r.current_price) : parseFloat(r.entry_price),
        sizeUsd: parseFloat(r.size_usd),
        sizeTokens: r.size_tokens !== null ? BigInt(r.size_tokens) : 0n,
        accountingVersion: r.accounting_version,
        realizedPnlUsd: Number(r.realized_pnl_usd),
        dataQuality: asStringArray(r.data_quality),
        stopLoss: parseFloat(r.stop_loss),
        peakPrice: r.peak_price !== null ? parseFloat(r.peak_price) : parseFloat(r.entry_price),
        unrealizedPnlUsd: r.unrealized_pnl_usd !== null ? parseFloat(r.unrealized_pnl_usd) : 0,
        unrealizedPnlPct: r.unrealized_pnl_pct !== null ? parseFloat(r.unrealized_pnl_pct) : 0,
        drawdownFromPeakPct: r.drawdown_from_peak_pct !== null ? parseFloat(r.drawdown_from_peak_pct) : 0,
        openedAt: new Date(r.opened_at),
        updatedAt: new Date(r.updated_at),
      };
      if (r.take_profit_1 !== null)    position.takeProfit1 = parseFloat(r.take_profit_1);
      if (r.take_profit_2 !== null)    position.takeProfit2 = parseFloat(r.take_profit_2);
      if (r.trailing_stop_pct !== null) position.trailingStopPct = parseFloat(r.trailing_stop_pct);
      if (r.entry_tx_signature !== null) position.entryTxSignature = r.entry_tx_signature;
      if (r.exit_reason !== null)       position.exitReason = r.exit_reason;
      if (r.initial_size_usd !== null) position.initialSizeUsd = Number(r.initial_size_usd);
      if (r.initial_size_tokens !== null) position.initialSizeTokens = BigInt(r.initial_size_tokens);
      if (r.entry_fee_usd !== null) position.entryFeeUsd = Number(r.entry_fee_usd);
      if (r.remaining_entry_fee_usd !== null) position.remainingEntryFeeUsd = Number(r.remaining_entry_fee_usd);
      if (r.realized_gross_pnl_usd !== null) position.realizedGrossPnlUsd = Number(r.realized_gross_pnl_usd);
      if (r.total_fees_usd !== null) position.totalFeesUsd = Number(r.total_fees_usd);
      if (r.entry_order_id !== null) position.entryOrderId = r.entry_order_id;
      if (r.exit_order_id !== null) position.exitOrderId = r.exit_order_id;
      if (r.closed_at !== null) position.closedAt = new Date(r.closed_at);
      if (r.accounting_version === 1) position.dataQuality = [...new Set([...position.dataQuality!, "legacy-unreconciled"])];
      return position;
    });
  }

  /** Closed positions — trade history for a mode+chain, newest first. */
  async getClosedTrades(
    mode: "PAPER" | "SHADOW" | "LIVE",
    chain: Chain = "solana",
    limit: number | null = 50,
    filter: Omit<AccountingFilter, "mode" | "chain"> = {},
  ): Promise<ClosedTrade[]> {
    const { rows } = await this.db.query<{
      id: string;
      token_address: string;
      chain: string;
      strategy_id: string;
      entry_price: string;
      size_usd: string;
      size_tokens: string | null;
      initial_size_usd: string | null;
      accounting_version: 1 | 2;
      realized_pnl_usd: string;
      realized_gross_pnl_usd: string | null;
      total_fees_usd: string | null;
      entry_order_id: string | null;
      exit_order_id: string | null;
      data_quality: string[] | null;
      unrealized_pnl_pct: string | null;
      exit_reason: string | null;
      opened_at: Date;
      closed_at: Date | null;
    }>(
      `SELECT id, token_address, chain, strategy_id, entry_price,
               COALESCE(initial_size_usd, size_usd) AS size_usd, size_tokens, initial_size_usd,
               accounting_version, realized_pnl_usd, realized_gross_pnl_usd, total_fees_usd,
               entry_order_id, exit_order_id, data_quality, unrealized_pnl_pct, exit_reason, opened_at, closed_at
       FROM positions
        WHERE status = 'CLOSED' AND mode = $1 AND chain = $2
          AND ($4::timestamptz IS NULL OR closed_at >= $4)
          AND ($5::timestamptz IS NULL OR closed_at < $5)
          AND ($6::text IS NULL OR strategy_id = $6)
          AND ($7::smallint IS NULL OR accounting_version = $7)
       ORDER BY closed_at DESC NULLS LAST
       LIMIT $3`,
      [mode, chain, limit, filter.from ?? null, filter.to ?? null, filter.strategyId ?? null, filter.accountingVersion ?? null],
    );
    return rows.map((r) => {
      const dataQuality = asStringArray(r.data_quality);
      return {
        id: r.id,
        tokenAddress: r.token_address,
        chain: r.chain as Chain,
        strategyId: r.strategy_id,
        mode,
        accountingVersion: r.accounting_version,
        entryPrice: parseFloat(r.entry_price),
        sizeUsd: parseFloat(r.size_usd),
        sizeTokens: r.size_tokens,
        initialSizeUsd: r.initial_size_usd === null ? null : Number(r.initial_size_usd),
        pnlUsd: dataQuality.includes("legacy-realized-pnl-unknown") ? null : parseFloat(r.realized_pnl_usd),
        pnlPct: r.accounting_version === 2 && Number(r.initial_size_usd) > 0
          ? Number(r.realized_pnl_usd) / Number(r.initial_size_usd) * 100
          : r.unrealized_pnl_pct !== null ? parseFloat(r.unrealized_pnl_pct) : 0,
        realizedGrossPnlUsd: r.realized_gross_pnl_usd === null ? null : Number(r.realized_gross_pnl_usd),
        totalFeesUsd: r.total_fees_usd === null ? null : Number(r.total_fees_usd),
        entryOrderId: r.entry_order_id,
        exitOrderId: r.exit_order_id,
        dataQuality: r.accounting_version === 1
          ? [...new Set([...dataQuality, "legacy-unreconciled"])] : dataQuality,
        exitReason: r.exit_reason,
        openedAt: new Date(r.opened_at),
        closedAt: r.closed_at !== null ? new Date(r.closed_at) : null,
      };
    });
  }

  /** Date bounds are half-open [from, to), and never limited to dashboard history. */
  async getAccountingFills(filter: AccountingFilter): Promise<AccountingFill[]> {
    const { rows } = await this.db.query<{
      id: string; trade_intent_id: string; position_id: string; token_address: string;
      chain: Chain; strategy_id: string; mode: TradeMode; side: TradeSide; accounting_version: 1 | 2;
      actual_input: string; actual_output: string; fee_usd: string; confirmed_at: Date;
      cash_delta_usd: string; realized_pnl_delta_usd: string | null; realized_gross_pnl_delta_usd: string | null;
      sold_cost_basis_usd: string | null; allocated_entry_fee_usd: string | null; data_quality: string[] | null;
    }>(
      `SELECT o.id, o.trade_intent_id, o.position_id, o.token_address, o.chain, i.strategy_id,
              o.mode, o.side, o.accounting_version, o.actual_input, o.actual_output, o.fee_usd,
              o.confirmed_at, o.cash_delta_usd, o.realized_pnl_delta_usd, o.realized_gross_pnl_delta_usd,
              o.sold_cost_basis_usd, o.allocated_entry_fee_usd, o.data_quality
       FROM orders o JOIN trade_intents i ON i.id = o.trade_intent_id
       WHERE o.status = 'CONFIRMED' AND o.position_id IS NOT NULL AND o.cash_delta_usd IS NOT NULL
         AND o.mode = $1 AND ($2::chain_type IS NULL OR o.chain = $2)
         AND ($3::text IS NULL OR i.strategy_id = $3)
         AND ($4::smallint IS NULL OR o.accounting_version = $4)
         AND ($5::timestamptz IS NULL OR o.confirmed_at >= $5)
         AND ($6::timestamptz IS NULL OR o.confirmed_at < $6)
       ORDER BY o.confirmed_at, o.id`,
      [filter.mode, filter.chain ?? null, filter.strategyId ?? null, filter.accountingVersion ?? null,
       filter.from ?? null, filter.to ?? null],
    );
    return rows.map((row) => ({
      orderId: row.id, tradeIntentId: row.trade_intent_id, positionId: row.position_id,
      tokenAddress: row.token_address, chain: row.chain, strategyId: row.strategy_id,
      mode: row.mode, side: row.side, accountingVersion: row.accounting_version,
      inputAmount: BigInt(row.actual_input), outputAmount: BigInt(row.actual_output), feeUsd: Number(row.fee_usd),
      confirmedAt: new Date(row.confirmed_at), cashDeltaUsd: Number(row.cash_delta_usd),
      realizedPnlDeltaUsd: row.realized_pnl_delta_usd === null ? null : Number(row.realized_pnl_delta_usd),
      realizedGrossPnlDeltaUsd: row.realized_gross_pnl_delta_usd === null ? null : Number(row.realized_gross_pnl_delta_usd),
      soldCostBasisUsd: row.sold_cost_basis_usd === null ? null : Number(row.sold_cost_basis_usd),
      allocatedEntryFeeUsd: row.allocated_entry_fee_usd === null ? null : Number(row.allocated_entry_fee_usd),
      dataQuality: asStringArray(row.data_quality),
    }));
  }

  /** No historical guesses/backfills: any legacy or unlinked fact makes the
   *  book incomplete. The application additionally reconciles token balances. */
  async getPaperAccountingState(chain: Chain): Promise<PaperAccountingState> {
    const fills = await this.getAccountingFills({ mode: "PAPER", chain });
    const { rows } = await this.db.query<{
      legacy_positions: string; legacy_orders: string; unresolved_positions: string; unreconciled_orders: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM positions WHERE mode = 'PAPER' AND chain = $1 AND accounting_version <> 2) AS legacy_positions,
         (SELECT COUNT(*) FROM orders WHERE mode = 'PAPER' AND chain = $1 AND accounting_version <> 2) AS legacy_orders,
         (SELECT COUNT(*) FROM positions WHERE mode = 'PAPER' AND chain = $1
            AND (status IN ('OPENING','CLOSING','ERROR') OR (status <> 'CLOSED' AND (size_tokens IS NULL OR size_tokens <= 0)))) AS unresolved_positions,
         (SELECT COUNT(*) FROM orders WHERE mode = 'PAPER' AND chain = $1
            AND (status NOT IN ('CONFIRMED','FAILED','CANCELLED')
              OR (status = 'CONFIRMED' AND (position_id IS NULL OR cash_delta_usd IS NULL OR confirmed_at IS NULL)))) AS unreconciled_orders`,
      [chain],
    );
    const row = rows[0];
    if (!row) throw new Error("PAPER accounting coverage could not be established");
    const legacyPositions = Number(row.legacy_positions);
    const legacyOrders = Number(row.legacy_orders);
    const unresolvedPositions = Number(row.unresolved_positions);
    const unreconciledOrders = Number(row.unreconciled_orders);
    const issues: string[] = [];
    if (![legacyPositions, legacyOrders, unresolvedPositions, unreconciledOrders].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      issues.push("Invalid PAPER accounting coverage counts");
    }
    if (fills.some((fill) => fill.inputAmount <= 0n || fill.outputAmount <= 0n
        || !Number.isFinite(fill.confirmedAt.getTime()) || !Number.isFinite(fill.cashDeltaUsd)
        || !Number.isFinite(fill.feeUsd) || fill.feeUsd < 0
        || (fill.accountingVersion === 2 && [fill.realizedPnlDeltaUsd, fill.realizedGrossPnlDeltaUsd,
          fill.soldCostBasisUsd, fill.allocatedEntryFeeUsd].some((v) => v === null || !Number.isFinite(v))))) {
      issues.push("Invalid confirmed PAPER accounting facts");
    }
    if (legacyPositions || legacyOrders) issues.push(`Legacy/unreconciled PAPER history: ${legacyPositions} positions, ${legacyOrders} orders`);
    if (unresolvedPositions) issues.push(`Unresolved PAPER positions: ${unresolvedPositions}`);
    if (unreconciledOrders) issues.push(`Unreconciled PAPER orders: ${unreconciledOrders}`);
    return { source: "durable", complete: issues.length === 0, fills, legacyPositions, legacyOrders,
      unresolvedPositions, unreconciledOrders, issues };
  }

  /** Last persisted portfolio snapshot for a mode+chain — total value / peak baseline. */
  async getLatestPortfolioSnapshot(
    mode: "PAPER" | "SHADOW" | "LIVE",
    chain: Chain = "solana",
  ): Promise<PortfolioSnapshot | null> {
    const { rows } = await this.db.query<{
      total_value_usd: string;
      available_usd: string;
      allocated_usd: string;
      open_positions: number;
      daily_pnl_usd: string | null;
      weekly_pnl_usd: string | null;
      monthly_pnl_usd: string | null;
      all_time_pnl_usd: string | null;
      drawdown_pct: string | null;
      peak_value_usd: string | null;
      snapshot_at: Date;
    }>(
      `SELECT total_value_usd, available_usd, allocated_usd, open_positions,
              daily_pnl_usd, weekly_pnl_usd, monthly_pnl_usd, all_time_pnl_usd,
              drawdown_pct, peak_value_usd, snapshot_at
       FROM portfolio_snapshots WHERE mode = $1 AND chain = $2
       ORDER BY snapshot_at DESC LIMIT 1`,
      [mode, chain],
    );
    const r = rows[0];
    if (!r) return null;

    return {
      totalValueUsd: parseFloat(r.total_value_usd),
      availableCapitalUsd: parseFloat(r.available_usd),
      allocatedUsd: parseFloat(r.allocated_usd),
      openPositions: r.open_positions,
      dailyPnlUsd: r.daily_pnl_usd !== null ? parseFloat(r.daily_pnl_usd) : 0,
      weeklyPnlUsd: r.weekly_pnl_usd !== null ? parseFloat(r.weekly_pnl_usd) : 0,
      monthlyPnlUsd: r.monthly_pnl_usd !== null ? parseFloat(r.monthly_pnl_usd) : 0,
      allTimePnlUsd: r.all_time_pnl_usd !== null ? parseFloat(r.all_time_pnl_usd) : 0,
      currentDrawdownPct: r.drawdown_pct !== null ? parseFloat(r.drawdown_pct) : 0,
      peakValueUsd: r.peak_value_usd !== null ? parseFloat(r.peak_value_usd) : parseFloat(r.total_value_usd),
      snapshotAt: new Date(r.snapshot_at),
    };
  }

  // ─── Portfolio snapshots ───────────────────────────────────────────────────
  /** Equity-curve points (oldest first) for a mode+chain — feeds the dashboard. */
  async getPortfolioHistory(
    mode: "PAPER" | "SHADOW" | "LIVE",
    limit = 500,
    chain: Chain = "solana",
  ): Promise<Array<{ at: string; totalValueUsd: number; drawdownPct: number }>> {
    const { rows } = await this.db.query<{
      total_value_usd: string;
      drawdown_pct: string | null;
      snapshot_at: Date;
    }>(
      `SELECT total_value_usd, drawdown_pct, snapshot_at FROM (
         SELECT total_value_usd, drawdown_pct, snapshot_at
         FROM portfolio_snapshots WHERE mode = $1 AND chain = $3
         ORDER BY snapshot_at DESC LIMIT $2
       ) recent ORDER BY snapshot_at ASC`,
      [mode, limit, chain],
    );
    return rows.map((r) => ({
      at: new Date(r.snapshot_at).toISOString(),
      totalValueUsd: parseFloat(r.total_value_usd),
      drawdownPct: r.drawdown_pct !== null ? parseFloat(r.drawdown_pct) : 0,
    }));
  }

  /** Persisted price points for one token, oldest first — feeds the dashboard sparkline. */
  async getMarketSnapshotHistory(
    tokenAddress: string,
    limit = 240,
    chain?: Chain,
  ): Promise<Array<{ at: string; priceUsd: number; volumeUsd1h: number }>> {
    const { rows } = await this.db.query<{ price_usd: string; volume_usd_1h: string; observed_at: Date }>(
      `SELECT price_usd, volume_usd_1h, observed_at FROM (
         SELECT price_usd, volume_usd_1h, observed_at FROM token_market_snapshots
          WHERE token_address = $1 AND ($3::chain_type IS NULL OR chain = $3)
          ORDER BY observed_at DESC LIMIT $2
       ) recent ORDER BY observed_at ASC`,
      [tokenAddress, limit, chain ?? null],
    );
    return rows.map((r) => ({
      at: new Date(r.observed_at).toISOString(),
      priceUsd: parseFloat(r.price_usd),
      volumeUsd1h: parseFloat(r.volume_usd_1h),
    }));
  }

  async recordPortfolioSnapshot(
    snap: PortfolioSnapshot,
    mode: "PAPER" | "SHADOW" | "LIVE",
    chain: Chain = "solana",
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO portfolio_snapshots
        (mode, chain, total_value_usd, available_usd, allocated_usd, open_positions,
         daily_pnl_usd, weekly_pnl_usd, monthly_pnl_usd, all_time_pnl_usd,
         drawdown_pct, peak_value_usd, snapshot_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [mode, chain, snap.totalValueUsd, snap.availableCapitalUsd, snap.allocatedUsd,
       snap.openPositions, snap.dailyPnlUsd, snap.weeklyPnlUsd, snap.monthlyPnlUsd,
       snap.allTimePnlUsd, snap.currentDrawdownPct, snap.peakValueUsd, snap.snapshotAt],
    );
  }

  // ─── Shadow decisions (signal-quality evidence, spec §43) ──────────────────
  async insertShadowDecision(d: {
    tokenAddress: string;
    chain: string;
    strategyId: string;
    decisionPrice: number;
    confidence: number;
    horizonMinutes: number;
    decidedAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO shadow_decisions
        (token_address, chain, strategy_id, decision, decision_price, confidence, horizon_minutes, decided_at)
       VALUES ($1,$2,$3,'ENTER',$4,$5,$6,$7)`,
      [d.tokenAddress, d.chain, d.strategyId, d.decisionPrice, d.confidence, d.horizonMinutes, d.decidedAt],
    );
  }

  async getDueShadowDecisions(horizonMinutes: number, limit: number, chain?: string): Promise<Array<{
    id: number;
    tokenAddress: string;
    decisionPrice: number;
    decidedAt: Date;
  }>> {
    const { rows } = await this.db.query<{ id: number; token_address: string; decision_price: string; decided_at: Date }>(
      `SELECT id, token_address, decision_price, decided_at
       FROM shadow_decisions
       WHERE evaluated_at IS NULL AND decided_at < NOW() - ($1 || ' minutes')::interval
         AND ($3::chain_type IS NULL OR chain = $3::chain_type)
       ORDER BY decided_at LIMIT $2`,
      [String(horizonMinutes), limit, chain ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      tokenAddress: r.token_address,
      decisionPrice: parseFloat(r.decision_price),
      decidedAt: new Date(r.decided_at),
    }));
  }

  async updateShadowOutcome(id: number, outcomePrice: number, returnPct: number): Promise<void> {
    await this.db.query(
      `UPDATE shadow_decisions SET outcome_price = $2, outcome_return_pct = $3,
              evaluated_at = NOW() WHERE id = $1`,
      [id, outcomePrice, returnPct],
    );
  }

  async getShadowStats(chain?: string): Promise<{ total: number; evaluated: number; avgReturnPct: number; winRate: number }> {
    const { rows } = await this.db.query<{ total: string; evaluated: string; avg_ret: string | null; win_rate: string | null }>(
      `SELECT COUNT(*) AS total,
              COUNT(evaluated_at) AS evaluated,
              AVG(outcome_return_pct) FILTER (WHERE evaluated_at IS NOT NULL) AS avg_ret,
              AVG(CASE WHEN outcome_return_pct > 0 THEN 1.0 ELSE 0 END)
                FILTER (WHERE evaluated_at IS NOT NULL) AS win_rate
       FROM shadow_decisions
       WHERE ($1::chain_type IS NULL OR chain = $1::chain_type)`,
      [chain ?? null],
    );
    const r = rows[0];
    return {
      total: parseInt(r?.total ?? "0", 10),
      evaluated: parseInt(r?.evaluated ?? "0", 10),
      avgReturnPct: r?.avg_ret !== null && r?.avg_ret !== undefined ? parseFloat(r.avg_ret) : 0,
      winRate: r?.win_rate !== null && r?.win_rate !== undefined ? parseFloat(r.win_rate) : 0,
    };
  }

  // ─── Fill calibration (roadmap C2) ──────────────────────────────────────────
  async recordFillCalibration(row: {
    tokenAddress: string;
    chain: string;
    side: string;
    sizeUsd: number;
    paperPrice: number;
    paperSlippageBps: number;
    quotePrice?: number | null;
    quotePriceImpactBps?: number | null;
    quoteSlippageBps?: number | null;
    quoteError?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO fill_calibration
        (token_address, chain, side, size_usd, paper_price, paper_slippage_bps,
         quote_price, quote_price_impact_bps, quote_slippage_bps, quote_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.tokenAddress, row.chain, row.side, row.sizeUsd, row.paperPrice, row.paperSlippageBps,
       row.quotePrice ?? null, row.quotePriceImpactBps ?? null, row.quoteSlippageBps ?? null,
       row.quoteError ?? null],
    );
  }

  // ─── System events ─────────────────────────────────────────────────────────
  async recordSystemEvent(
    type: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO system_events (event_type, message, metadata, occurred_at)
       VALUES ($1,$2,$3,NOW())`,
      [type, message, JSON.stringify(metadata)],
    );
  }

  // ─── System state (kill switch etc.) ───────────────────────────────────────
  async getSystemState(key: string): Promise<string | null> {
    const { rows } = await this.db.query<{ value: string }>(
      `SELECT value FROM system_state WHERE key = $1`, [key],
    );
    return rows[0]?.value ?? null;
  }

  async setSystemState(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO system_state (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }
}
