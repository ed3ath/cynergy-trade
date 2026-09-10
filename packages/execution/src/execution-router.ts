/**
 * Execution router — handles PAPER, SHADOW, and LIVE modes.
 *
 * PAPER:  No I/O. Returns synthetic fill at current quote price.
 * SHADOW: Gets real quote, simulates fill, records hypothetical result.
 * LIVE:   Full execution pipeline with simulation, signing, submission, monitoring.
 *
 * Idempotency: each TradeIntent ID is executed at most once.
 */
import {
  generateOrderId,
  ExecutionError,
  type TradeIntent,
  type ExecutionResult,
  type QuoteResult,
  type Logger,
} from "@autonomous-trader/shared";
import { OrderStateMachine } from "@autonomous-trader/core";
import type {
  SwapQuoteProvider,
  SwapQuoteRequest,
  TradeExecutionProvider,
  TransactionMonitoringProvider,
  ChainDataProvider,
} from "@autonomous-trader/providers";

export interface ExecutionRouter {
  execute(intent: TradeIntent, currentPriceUsd: number): Promise<ExecutionResult>;
}

// ─── Idempotency guard ────────────────────────────────────────────────────────
const executed = new Set<string>(); // in-memory; swap for Redis in prod

function guardDuplicate(intentId: string): void {
  if (executed.has(intentId)) {
    throw new ExecutionError(`Duplicate execution prevented for intent ${intentId}`, { intentId });
  }
  executed.add(intentId);
}

// ─── Paper execution (no I/O) ─────────────────────────────────────────────────
export class PaperExecutionRouter implements ExecutionRouter {
  constructor(private readonly logger: Logger) {}

  async execute(intent: TradeIntent, currentPriceUsd: number): Promise<ExecutionResult> {
    guardDuplicate(intent.id);

    const orderId = generateOrderId();
    const sm = new OrderStateMachine();

    sm.transition("VALIDATING");
    sm.transition("SIMULATING");
    sm.transition("SIGNED");
    sm.transition("SUBMITTED");
    sm.transition("CONFIRMING");
    sm.transition("CONFIRMED");

    // Synthetic fill: apply half the max slippage as simulated cost
    const slippageFactor = 1 - (intent.maxSlippageBps / 2) / 10_000;
    const filledPrice = intent.side === "BUY"
      ? currentPriceUsd / slippageFactor
      : currentPriceUsd * slippageFactor;

    const inputAmount = BigInt(Math.round(intent.positionSizeUsd * 1e6));
    const outputAmount = BigInt(Math.round(
      intent.side === "BUY"
        ? (intent.positionSizeUsd / filledPrice) * 1e9
        : intent.positionSizeUsd * slippageFactor * 1e6,
    ));

    const result: ExecutionResult = {
      tradeIntentId: intent.id,
      orderId,
      status: "CONFIRMED",
      txSignature: `paper_${orderId}`,
      inputAmount,
      outputAmount,
      executedPrice: filledPrice,
      actualSlippageBps: intent.maxSlippageBps / 2,
      feesLamports: 5000n,
      feeUsd: 0.0005,
      confirmedAt: new Date(),
      mode: "PAPER",
    };

    this.logger.info("Paper trade executed", {
      intentId: intent.id,
      token: intent.tokenAddress,
      side: intent.side,
      sizeUsd: intent.positionSizeUsd,
      price: filledPrice,
    });

    return result;
  }
}

// ─── Shadow execution (real quotes, no on-chain tx) ───────────────────────────
export class ShadowExecutionRouter implements ExecutionRouter {
  constructor(
    private readonly quoteProvider: SwapQuoteProvider,
    private readonly logger: Logger,
    private readonly solMint = "So11111111111111111111111111111111111111112",
  ) {}

  async execute(intent: TradeIntent, currentPriceUsd: number): Promise<ExecutionResult> {
    guardDuplicate(intent.id);

    const orderId = generateOrderId();
    const sm = new OrderStateMachine();
    sm.transition("VALIDATING");

    // Get real quote
    const quoteReq: SwapQuoteRequest = {
      inputMint: intent.side === "BUY" ? this.solMint : intent.tokenAddress,
      outputMint: intent.side === "BUY" ? intent.tokenAddress : this.solMint,
      amount: BigInt(Math.round(intent.positionSizeUsd * 1e6)),
      slippageBps: intent.maxSlippageBps,
      chain: intent.chain,
    };

    sm.transition("SIMULATING");
    let quote: QuoteResult;
    try {
      quote = await this.quoteProvider.getQuote(quoteReq);
    } catch (err) {
      sm.transition("FAILED");
      throw new ExecutionError(`Shadow quote failed: ${(err as Error).message}`, { intentId: intent.id });
    }

    sm.transition("SIGNED");
    sm.transition("SUBMITTED");
    sm.transition("CONFIRMED");

    const result: ExecutionResult = {
      tradeIntentId: intent.id,
      orderId,
      status: "CONFIRMED",
      txSignature: `shadow_${orderId}`,
      inputAmount: quote.inputAmount,
      outputAmount: quote.outputAmount,
      executedPrice: quote.expectedPrice,
      actualSlippageBps: quote.slippageBps,
      feesLamports: quote.estimatedFeeLamports,
      feeUsd: Number(quote.estimatedFeeLamports) / 1e9 * currentPriceUsd,
      confirmedAt: new Date(),
      mode: "SHADOW",
    };

    this.logger.info("Shadow trade recorded", {
      intentId: intent.id,
      token: intent.tokenAddress,
      side: intent.side,
      priceImpactBps: quote.priceImpactBps,
    });

    return result;
  }
}

// ─── Live execution (real on-chain transactions) ──────────────────────────────
export class LiveExecutionRouter implements ExecutionRouter {
  constructor(
    private readonly quoteProvider: SwapQuoteProvider,
    private readonly executionProvider: TradeExecutionProvider,
    private readonly monitoringProvider: TransactionMonitoringProvider,
    private readonly chainProvider: ChainDataProvider,
    private readonly walletPublicKey: string,
    private readonly signTransaction: (tx: Uint8Array) => Promise<Uint8Array>,
    private readonly logger: Logger,
    private readonly solMint = "So11111111111111111111111111111111111111112",
  ) {}

  async execute(intent: TradeIntent, currentPriceUsd: number): Promise<ExecutionResult> {
    guardDuplicate(intent.id);

    if (intent.expiresAt <= new Date()) {
      throw new ExecutionError("Intent expired before execution", { intentId: intent.id });
    }

    const orderId = generateOrderId();
    const sm = new OrderStateMachine();

    // ── Step 1: Quote ─────────────────────────────────────────────────────────
    sm.transition("VALIDATING");
    const quoteReq: SwapQuoteRequest = {
      inputMint: intent.side === "BUY" ? this.solMint : intent.tokenAddress,
      outputMint: intent.side === "BUY" ? intent.tokenAddress : this.solMint,
      amount: BigInt(Math.round(intent.positionSizeUsd * 1e6)),
      slippageBps: intent.maxSlippageBps,
      chain: intent.chain,
    };

    const quote = await this.quoteProvider.getQuote(quoteReq);

    // Validate slippage before proceeding
    if (quote.priceImpactBps > intent.maxPriceImpactBps) {
      sm.transition("CANCELLED");
      throw new ExecutionError(
        `Price impact ${quote.priceImpactBps}bps exceeds limit ${intent.maxPriceImpactBps}bps`,
        { intentId: intent.id },
      );
    }

    // ── Step 2: Build + simulate ──────────────────────────────────────────────
    sm.transition("SIMULATING");
    const { transaction, lastValidBlockHeight } = await this.executionProvider.buildSwapTransaction(
      quote,
      this.walletPublicKey,
    );

    const simulation = await this.chainProvider.simulateTransaction(transaction);
    if (!simulation.success) {
      sm.transition("FAILED");
      throw new ExecutionError(`Simulation failed: ${simulation.error}`, { intentId: intent.id, logs: simulation.logs });
    }

    // ── Step 3: Sign ──────────────────────────────────────────────────────────
    sm.transition("SIGNED");
    const signed = await this.signTransaction(transaction);

    // ── Step 4: Submit ────────────────────────────────────────────────────────
    sm.transition("SUBMITTED");
    const { signature } = await this.executionProvider.submitTransaction(signed, intent);

    this.logger.info("Transaction submitted", {
      intentId: intent.id,
      signature,
      token: intent.tokenAddress,
    });

    // ── Step 5: Monitor confirmation ─────────────────────────────────────────
    sm.transition("CONFIRMING");
    const txStatus = await this.monitoringProvider.monitorTransaction(
      signature,
      60_000,
      (status) => this.logger.debug("Tx status update", { signature, status: status.status }),
    );

    if (txStatus.status === "failed") {
      sm.transition("FAILED");
      throw new ExecutionError(`Transaction failed on-chain: ${txStatus.error}`, {
        intentId: intent.id,
        signature,
      });
    }

    if (txStatus.status === "not_found" || txStatus.status === "pending") {
      sm.transition("UNKNOWN");
      // CRITICAL: do NOT resubmit. Caller must investigate chain state.
      throw new ExecutionError(
        `Transaction status unknown after timeout — DO NOT RESUBMIT. Investigate: ${signature}`,
        { intentId: intent.id, signature },
      );
    }

    sm.transition("CONFIRMED");

    const result: ExecutionResult = {
      tradeIntentId: intent.id,
      orderId,
      status: "CONFIRMED",
      txSignature: signature,
      inputAmount: quote.inputAmount,
      outputAmount: quote.outputAmount,
      executedPrice: quote.expectedPrice,
      actualSlippageBps: quote.slippageBps,
      feesLamports: quote.estimatedFeeLamports,
      feeUsd: Number(quote.estimatedFeeLamports) / 1e9 * currentPriceUsd,
      confirmedAt: new Date(),
      mode: "LIVE",
    };

    this.logger.info("Live trade confirmed", {
      intentId: intent.id,
      signature,
      token: intent.tokenAddress,
      side: intent.side,
    });

    return result;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
export function createExecutionRouter(
  mode: "PAPER" | "SHADOW" | "LIVE",
  deps: {
    quote?: SwapQuoteProvider;
    execution?: TradeExecutionProvider;
    monitoring?: TransactionMonitoringProvider;
    chain?: ChainDataProvider;
    walletPublicKey?: string;
    signTransaction?: (tx: Uint8Array) => Promise<Uint8Array>;
    logger: Logger;
  },
): ExecutionRouter {
  switch (mode) {
    case "PAPER":
      return new PaperExecutionRouter(deps.logger);

    case "SHADOW":
      if (!deps.quote) throw new Error("Shadow mode requires quoteProvider");
      return new ShadowExecutionRouter(deps.quote, deps.logger);

    case "LIVE":
      if (!deps.quote || !deps.execution || !deps.monitoring || !deps.chain ||
          !deps.walletPublicKey || !deps.signTransaction) {
        throw new Error("Live mode requires all execution dependencies");
      }
      return new LiveExecutionRouter(
        deps.quote, deps.execution, deps.monitoring, deps.chain,
        deps.walletPublicKey, deps.signTransaction, deps.logger,
      );
  }
}
