/**
 * Trade journal repositories — immutable append-only records.
 * Every decision, risk evaluation, order, and position event is persisted
 * with the full context needed to reproduce why the system acted.
 */
import type {
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
} from "@autonomous-trader/shared";
import type { Database } from "./database.js";

export class JournalRepository {
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
  async recordStrategyDecision(decision: StrategyDecision, featureSnapshot: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO strategy_decisions
        (strategy_id, strategy_version, token_address, chain, decision, confidence,
         reasons, risks, invalidation_conds, suggested_entry, suggested_stop,
         suggested_tp1, suggested_tp2, feature_snapshot, evaluated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [decision.strategyId, decision.strategyVersion, decision.tokenAddress, "solana",
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
         position_size_usd, max_slippage_bps, max_price_impact_bps, reason, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [intent.id, intent.tokenAddress, intent.chain, intent.side, intent.mode,
       intent.strategyId, intent.strategyVersion, intent.riskVersion,
       intent.positionSizeUsd, intent.maxSlippageBps, intent.maxPriceImpactBps,
       intent.reason, intent.createdAt, intent.expiresAt],
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW(),NOW())`,
      [result.orderId, result.tradeIntentId, intent.tokenAddress, intent.chain, intent.side,
       result.mode, result.status, result.txSignature ?? null,
       result.inputAmount.toString(), result.outputAmount.toString(),
       result.executedPrice, result.actualSlippageBps, result.feeUsd,
       result.confirmedAt ?? null],
    );
  }

  async recordOrderStatusUpdate(orderId: string, status: string, error?: string): Promise<void> {
    await this.db.query(
      `UPDATE orders SET status = $2, error_message = $3, updated_at = NOW() WHERE id = $1`,
      [orderId, status, error ?? null],
    );
  }

  // ─── Positions ─────────────────────────────────────────────────────────────
  async insertPosition(position: Position): Promise<void> {
    await this.db.query(
      `INSERT INTO positions
        (id, token_address, chain, status, mode, strategy_id, strategy_version,
         entry_price, current_price, size_usd, size_tokens, stop_loss,
         take_profit_1, take_profit_2, trailing_stop_pct, peak_price,
         opened_at, updated_at, entry_order_id, exit_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18,$19)`,
      [position.id, position.tokenAddress, position.chain, position.status, position.mode,
       position.strategyId, "1.0.0", position.entryPrice, position.currentPrice,
       position.sizeUsd, position.sizeTokens.toString(), position.stopLoss,
       position.takeProfit1 ?? null, position.takeProfit2 ?? null,
       position.trailingStopPct ?? null, position.peakPrice,
       position.openedAt, null, position.exitReason ?? null],
    );
  }

  async updatePosition(position: Position): Promise<void> {
    await this.db.query(
      `UPDATE positions SET
         status = $2, current_price = $3, peak_price = $4,
         unrealized_pnl_usd = $5, unrealized_pnl_pct = $6,
         drawdown_from_peak_pct = $7, exit_reason = $8,
         closed_at = CASE WHEN $2 IN ('CLOSED','ERROR') THEN NOW() ELSE closed_at END,
         updated_at = NOW()
       WHERE id = $1`,
      [position.id, position.status, position.currentPrice, position.peakPrice,
       position.unrealizedPnlUsd, position.unrealizedPnlPct,
       position.drawdownFromPeakPct, position.exitReason ?? null],
    );
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

  // ─── Portfolio snapshots ───────────────────────────────────────────────────
  async recordPortfolioSnapshot(snap: PortfolioSnapshot, mode: "PAPER" | "SHADOW" | "LIVE"): Promise<void> {
    await this.db.query(
      `INSERT INTO portfolio_snapshots
        (mode, total_value_usd, available_usd, allocated_usd, open_positions,
         daily_pnl_usd, weekly_pnl_usd, monthly_pnl_usd, all_time_pnl_usd,
         drawdown_pct, peak_value_usd, snapshot_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [mode, snap.totalValueUsd, snap.availableCapitalUsd, snap.allocatedUsd,
       snap.openPositions, snap.dailyPnlUsd, snap.weeklyPnlUsd, snap.monthlyPnlUsd,
       snap.allTimePnlUsd, snap.currentDrawdownPct, snap.peakValueUsd, snap.snapshotAt],
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
