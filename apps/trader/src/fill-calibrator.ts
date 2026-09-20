/**
 * Fill calibrator (roadmap C2): for every PAPER fill, fetch a real quote for
 * the same intent and journal both — measures the gap between synthetic fills
 * and reality (slippage, price impact, fees follow from it).
 *
 * Strictly fire-and-forget: must never delay or break a trade. Quote failure
 * is recorded as a row with quote_error, not silence.
 */
import type { ExecutionResult, TradeIntent, Logger } from "@autonomous-trader/shared";
import type { JournalRepository } from "@autonomous-trader/core";
import type { SwapQuoteProvider } from "@autonomous-trader/providers";
import { quotesForIntent } from "@autonomous-trader/execution";

export class FillCalibrator {
  constructor(
    private readonly quoteProvider: SwapQuoteProvider,
    private readonly baseMint: string,
    private readonly journal: JournalRepository,
    private readonly logger: Logger,
  ) {}

  /** Call after a paper fill; never await-critical, never throws. */
  record(intent: TradeIntent, fill: ExecutionResult): void {
    void (async () => {
      try {
        const q = await quotesForIntent(this.quoteProvider, intent, this.baseMint);
        await this.journal.recordFillCalibration({
          tokenAddress: intent.tokenAddress,
          chain: intent.chain,
          side: intent.side,
          sizeUsd: intent.positionSizeUsd,
          paperPrice: fill.executedPrice,
          paperSlippageBps: fill.actualSlippageBps,
          quotePrice: q.expectedPrice,
          quotePriceImpactBps: q.priceImpactBps,
          quoteSlippageBps: q.slippageBps,
        });
      } catch (err) {
        try {
          await this.journal.recordFillCalibration({
            tokenAddress: intent.tokenAddress,
            chain: intent.chain,
            side: intent.side,
            sizeUsd: intent.positionSizeUsd,
            paperPrice: fill.executedPrice,
            paperSlippageBps: fill.actualSlippageBps,
            quoteError: (err as Error).message.slice(0, 200),
          });
        } catch {
          this.logger.warn("Fill calibration persist failed", { error: (err as Error).message });
        }
      }
    })();
  }
}
