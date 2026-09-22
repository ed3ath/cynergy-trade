/**
 * Backtest replay engine (roadmap Phase B, step 1).
 *
 * Replays recorded snapshot series through the SAME code paths the live
 * trader uses — computeMarketFeatures → runFilters → scoreCandidate →
 * FreshMomentum.evaluate → PositionManager.updateAndCheckExit — so results
 * reflect production logic, not a parallel reimplementation.
 *
 * Deliberate simplifications (upgrade when the data warrants):
 *  - liquidity/holders/security are static per token (first recorded sample);
 *    market features are per-row. Live refreshes all layers.
 *  - exits are full-position at signal (live TP1/TP2 suggest partial sells but
 *    the paper path also fills them whole).
 *  - one position per token, no re-entry cooldown after exit.
 *  - regime is a fixed input — real conditioning (B3) joins regime_history by
 *    entry time once that table has coverage.
 */
import type {
  Chain, LiquiditySnapshot, MarketSnapshot, SecurityAssessment,
  HolderSnapshot, DataFreshnessConfig, MarketConfig, MarketRegime, TradeIntent,
  ExecutionResult, Logger,
} from "@autonomous-trader/shared";
import { generateOrderId } from "@autonomous-trader/shared";
import type { TokenCandidate } from "@autonomous-trader/scanner";
import {
  computeMarketFeatures, computeLiquidityFeatures, computeHolderFeatures,
  computeSecurityFeatures, mergeFeatures, scoreCandidate, runFilters,
} from "@autonomous-trader/scanner";
import { FreshMomentumStrategy } from "@autonomous-trader/strategy";
import { PositionManager } from "@autonomous-trader/position";
import type { ExecutionRouter } from "@autonomous-trader/execution";

export interface TokenSeries {
  token: string;
  chain: Chain;
  rows: Array<{ at: Date; market: MarketSnapshot }>;
  liquidity?: LiquiditySnapshot;
  holders?: HolderSnapshot;
  security?: SecurityAssessment;
}

export interface BacktestTrade {
  token: string;
  entryAt: Date;
  exitAt: Date;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  holdMinutes: number;
  reason: string;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  tokensWithTrades: number;
  totalTokens: number;
  winRate: number;         // share of trades with returnPct > 0
  avgReturnPct: number;    // expectancy per trade
  avgHoldMinutes: number;
  byExitReason: Record<string, { count: number; avgReturnPct: number }>;
}

export interface BacktestOptions {
  marketConfig: MarketConfig;
  freshnessConfig: DataFreshnessConfig;
  regime?: MarketRegime;
  portfolioValueUsd?: number;
  entrySlippageBps?: number;  // default 50 — paper router charges maxSlippage/2
  exitSlippageBps?: number;
  timeStopMs?: number;        // default 4h, matches live PositionManager
}

const noopLogger: Logger = {
  debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined,
  child: () => noopLogger,
};

export function runBacktest(series: TokenSeries[], opts: BacktestOptions): BacktestResult {
  const strategy = new FreshMomentumStrategy();
  const entrySlip = (opts.entrySlippageBps ?? 50) / 10_000;
  const exitSlip = (opts.exitSlippageBps ?? 50) / 10_000;
  const portfolioValueUsd = opts.portfolioValueUsd ?? 10_000;
  const trades: BacktestTrade[] = [];
  const tokensWithTrades = new Set<string>();

  for (const s of series) {
    if (!s.liquidity || !s.holders || !s.security || s.rows.length === 0) continue;

    // The live manager reused as-is: entry via openPosition, exits via
    // updateAndCheckExit. Its execution router is never called (we close by
    // mutating status), so a never-invoked stub satisfies the constructor.
    const pm = new PositionManager(
      null as unknown as ExecutionRouter, noopLogger, opts.timeStopMs ?? 4 * 3_600_000,
    );
    const staticFeatures = {
      ...computeLiquidityFeatures(s.liquidity),
      ...computeHolderFeatures(s.holders),
      ...computeSecurityFeatures(s.security),
    };

    let openId: string | null = null;
    let entry: { at: Date; price: number } | null = null;

    for (const row of s.rows) {
      if (openId === null) {
        const candidate = {
          tokenAddress: s.token, chain: s.chain,
          status: "TRADE_CANDIDATE" as const,
          firstSeenAt: s.rows[0]!.at, lastUpdatedAt: row.at,
          discoverySource: "backtest",
          market: row.market, liquidity: s.liquidity,
          holders: s.holders, security: s.security,
          features: mergeFeatures(computeMarketFeatures(row.market), staticFeatures),
          rejectionReasons: [], refreshCount: 1,
        } as unknown as TokenCandidate;
        candidate.scores = scoreCandidate(candidate);

        if (runFilters(candidate, opts.marketConfig).length > 0) continue;

        const decision = strategy.evaluate({
          candidate,
          marketRegime: opts.regime ?? "BULL",
          portfolioValueUsd,
          availableCapitalUsd: portfolioValueUsd,
          openPositionCount: 0,
          existingTokenExposureUsd: 0,
          freshnessConfig: opts.freshnessConfig,
          marketConfig: opts.marketConfig,
          timestamp: row.at,
        });
        if (decision.decision !== "ENTER") continue;

        const price = row.market.priceUsd * (1 + entrySlip);
        const intent: TradeIntent = {
          id: `bt_${generateOrderId()}`, tokenAddress: s.token, chain: s.chain,
          side: "BUY", mode: "PAPER", strategyId: strategy.id,
          strategyVersion: strategy.version, riskVersion: "backtest",
          positionSizeUsd: 15, maxSlippageBps: 100, maxPriceImpactBps: 300,
          reason: "backtest", createdAt: row.at, expiresAt: new Date(row.at.getTime() + 30_000),
        };
        const fill: ExecutionResult = {
          tradeIntentId: intent.id, orderId: `bt_${generateOrderId()}`, status: "CONFIRMED",
          inputAmount: BigInt(15e6), outputAmount: BigInt(Math.round(15 / price * 1e9)),
          executedPrice: price, actualSlippageBps: 100, feesLamports: 0n, feeUsd: 0,
          confirmedAt: row.at, mode: "PAPER",
        };
        const position = pm.openPosition(
          fill, intent,
          decision.suggestedStopLoss ?? price * 0.85,
          decision.suggestedTakeProfit1,
          decision.suggestedTakeProfit2,
          15,
        );
        openId = position.id;
        entry = { at: row.at, price };
        continue;
      }

      const signal = pm.updateAndCheckExit(openId, {
        market: row.market, liquidity: s.liquidity, timestampMs: row.at.getTime(),
      });
      if (signal) {
        trades.push(closeTrade(s.token, entry!, row, exitSlip, signal.reason));
        tokensWithTrades.add(s.token);
        const p = pm.getPosition(openId);
        if (p) p.status = "CLOSED";
        openId = null;
        entry = null;
      }
    }

    if (openId !== null && entry) {
      const last = s.rows[s.rows.length - 1]!;
      trades.push(closeTrade(s.token, entry, last, exitSlip, "END_OF_DATA"));
      tokensWithTrades.add(s.token);
    }
  }

  return summarize(trades, series.length, tokensWithTrades.size);
}

function closeTrade(
  token: string, entry: { at: Date; price: number },
  row: { at: Date; market: MarketSnapshot }, exitSlip: number, reason: string,
): BacktestTrade {
  const exitPrice = row.market.priceUsd * (1 - exitSlip);
  return {
    token,
    entryAt: entry.at,
    exitAt: row.at,
    entryPrice: entry.price,
    exitPrice,
    returnPct: ((exitPrice - entry.price) / entry.price) * 100,
    holdMinutes: (row.at.getTime() - entry.at.getTime()) / 60_000,
    reason,
  };
}

function summarize(trades: BacktestTrade[], totalTokens: number, tokensWithTrades: number): BacktestResult {
  const wins = trades.filter((t) => t.returnPct > 0);
  const byReason: Record<string, { count: number; avgReturnPct: number }> = {};
  for (const t of trades) {
    const r = (byReason[t.reason.split(":")[0]!] ??= { count: 0, avgReturnPct: 0 });
    r.count++;
    r.avgReturnPct += (t.returnPct - r.avgReturnPct) / r.count; // running mean
  }
  return {
    trades,
    totalTokens,
    tokensWithTrades,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgReturnPct: trades.length ? trades.reduce((s, t) => s + t.returnPct, 0) / trades.length : 0,
    avgHoldMinutes: trades.length ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0,
    byExitReason: byReason,
  };
}
