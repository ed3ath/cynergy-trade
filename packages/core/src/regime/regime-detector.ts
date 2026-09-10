/**
 * Market regime detection (spec §48).
 *
 * Classifies from:
 *   - SOL price series (trend + volatility) — sampled from Jupiter WSOL/USDC (free)
 *   - portfolio drawdown state (from risk engine inputs)
 *   - recent strategy win rate (optional, shrinkage-aware)
 *
 * Priority: safety states override trend states.
 */
import type { MarketRegime } from "@autonomous-trader/shared";

export interface RegimeInputs {
  /** SOL/USD samples, oldest first, at least a few minutes apart. */
  solPrices: number[];
  /** Current portfolio drawdown percent (0–100). */
  drawdownPct: number;
  /** Configured max drawdown percent (regular threshold, not emergency). */
  maxDrawdownPct: number;
  /** Daily loss as positive number when losing, USD. */
  dailyLossUsd: number;
  maxDailyLossUsd: number;
  /** Realized strategy win rate 0–1, or null when no sample. */
  recentWinRate: number | null;
}

export interface RegimeResult {
  regime: MarketRegime;
  solTrendPct1h: number;      // annualized-free simple % over sample window
  volatilityPct: number;      // stdev of per-sample returns, in %
  confidence: number;         // 0–1, grows with sample count
  reasons: string[];
}

const MIN_SAMPLES = 6;

export function classifyRegime(input: RegimeInputs): RegimeResult {
  const reasons: string[] = [];
  const prices = input.solPrices;

  // ── Safety overrides first ──────────────────────────────────────────────────
  if (input.drawdownPct >= input.maxDrawdownPct) {
    return result("RISK_OFF", 0, 0, 1.0, [`drawdown ${input.drawdownPct.toFixed(1)}% >= max ${input.maxDrawdownPct}%`]);
  }
  if (input.dailyLossUsd >= input.maxDailyLossUsd) {
    return result("RISK_OFF", 0, 0, 1.0, [`daily loss ${input.dailyLossUsd.toFixed(2)} >= max ${input.maxDailyLossUsd}`]);
  }

  // ── Not enough SOL data → UNKNOWN ──────────────────────────────────────────
  if (prices.length < MIN_SAMPLES) {
    return result("UNKNOWN", 0, 0, prices.length / MIN_SAMPLES * 0.5, [`only ${prices.length} SOL samples`]);
  }

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0) returns.push(((prices[i]! - prices[i - 1]!) / prices[i - 1]!) * 100);
  }
  const trend = prices[0]! > 0 ? ((prices[prices.length - 1]! - prices[0]!) / prices[0]!) * 100 : 0;
  const vol = stdev(returns);
  const confidence = Math.min(1, prices.length / 30);

  // ── Volatility dominates trend ─────────────────────────────────────────────
  if (vol > 1.2) {
    return result("HIGH_VOLATILITY", trend, vol, confidence, [
      `per-sample vol ${vol.toFixed(2)}% > 1.2%`,
    ]);
  }

  // ── Strategy performance signal (only with meaningful sample) ───────────────
  if (input.recentWinRate !== null) {
    if (input.recentWinRate < 0.25) {
      return result("RISK_OFF", trend, vol, Math.min(confidence + 0.2, 1), [
        `recent win rate ${(input.recentWinRate * 100).toFixed(0)}% — strategies failing`,
      ]);
    }
  }

  // ── Trend classification ───────────────────────────────────────────────────
  if (trend <= -3) {
    return result("BEAR", trend, vol, confidence, [`SOL trend ${trend.toFixed(2)}% <= -3%`]);
  }
  if (trend >= 2) {
    return result("BULL", trend, vol, confidence, [`SOL trend +${trend.toFixed(2)}%, vol ${vol.toFixed(2)}%`]);
  }
  if (vol < 0.15 && Math.abs(trend) < 1) {
    return result("LOW_VOLATILITY", trend, vol, confidence, [
      `quiet: trend ${trend.toFixed(2)}%, vol ${vol.toFixed(2)}%`,
    ]);
  }

  return result("UNKNOWN", trend, vol, confidence, [
    `mixed: trend ${trend.toFixed(2)}%, vol ${vol.toFixed(2)}%`,
  ]);
}

function result(
  regime: MarketRegime, trend: number, vol: number, confidence: number, reasons: string[],
): RegimeResult {
  return { regime, solTrendPct1h: trend, volatilityPct: vol, confidence, reasons };
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * SOL price sampler — keeps a bounded time series, one sample per interval.
 * Prices arrive from Jupiter WSOL→USDC quotes.
 */
export class SolPriceSampler {
  private samples: Array<{ t: number; price: number }> = [];
  private lastSampleAt = 0;

  constructor(
    private readonly maxSamples = 60,
    private readonly minIntervalMs = 60_000, // 1 sample/min → 60 min window
  ) {}

  add(price: number, at: number = Date.now()): void {
    if (at - this.lastSampleAt < this.minIntervalMs) return;
    this.lastSampleAt = at;
    this.samples.push({ t: at, price });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  prices(): number[] {
    return this.samples.map((s) => s.price);
  }

  get size(): number {
    return this.samples.length;
  }
}
