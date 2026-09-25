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

// ─── Idempotency: injected guard (in-memory default, DB/Redis in production) ──
import type { IdempotencyGuard } from "./idempotency.js";
import { assertNotDuplicate, InMemoryIdempotencyGuard } from "./idempotency.js";

const defaultGuard = new InMemoryIdempotencyGuard();

// ─── Paper execution (no I/O) ─────────────────────────────────────────────────
export class PaperExecutionRouter implements ExecutionRouter {
  constructor(
    private readonly logger: Logger,
    private readonly guard: IdempotencyGuard = defaultGuard,
  ) {}

  async execute(intent: TradeIntent, currentPriceUsd: number): Promise<ExecutionResult> {
    if (intent.mode !== "PAPER" || (intent.side !== "BUY" && intent.side !== "SELL")
        || !Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0
        || !Number.isFinite(intent.positionSizeUsd) || intent.positionSizeUsd <= 0
        || !Number.isFinite(intent.maxSlippageBps) || intent.maxSlippageBps < 0 || intent.maxSlippageBps >= 20_000
        || !Number.isFinite(intent.maxPriceImpactBps) || intent.maxPriceImpactBps < 0
        || !Number.isFinite(intent.expiresAt.getTime()) || intent.expiresAt.getTime() <= Date.now()) {
      throw new ExecutionError("Invalid or expired PAPER intent or execution price", { intentId: intent.id });
    }
    if (intent.side === "SELL" && (typeof intent.paperTokenQuantity !== "bigint" || intent.paperTokenQuantity <= 0n)) {
      throw new ExecutionError("PAPER SELL requires a positive exact paperTokenQuantity", { intentId: intent.id });
    }

    // Mode-specific units: PAPER buys spend USD-micro and receive token-nano;
    // sells spend the exact token-nano quantity and receive USD-micro. These
    // synthetic scales must never be used for SHADOW/LIVE provider amounts.
    const slippageFactor = 1 - (intent.maxSlippageBps / 2) / 10_000;
    const filledPrice = intent.side === "BUY"
      ? currentPriceUsd / slippageFactor
      : currentPriceUsd * slippageFactor;
    const inputUsdMicro = Math.round(intent.positionSizeUsd * 1e6);
    const output = intent.side === "BUY"
      ? Math.round((inputUsdMicro / 1e6 / filledPrice) * 1e9)
      : Math.round(Number(intent.paperTokenQuantity) / 1e9 * filledPrice * 1e6);
    if (!Number.isFinite(filledPrice) || filledPrice <= 0
        || (intent.side === "BUY" && (!Number.isSafeInteger(inputUsdMicro) || inputUsdMicro <= 0))
        || !Number.isFinite(output) || output <= 0
        || (intent.side === "BUY" && output >= 1e30)
        || (intent.side === "SELL" && !Number.isSafeInteger(output))) {
      throw new ExecutionError("PAPER fill is non-finite, empty, or outside monetary precision", { intentId: intent.id });
    }

    await assertNotDuplicate(this.guard, intent.id);

    const orderId = generateOrderId();
    const sm = new OrderStateMachine();

    sm.transition("VALIDATING");
    sm.transition("SIMULATING");
    sm.transition("SIGNED");
    sm.transition("SUBMITTED");
    sm.transition("CONFIRMING");
    sm.transition("CONFIRMED");

    const inputAmount = intent.side === "BUY" ? BigInt(inputUsdMicro) : intent.paperTokenQuantity!;
    const outputAmount = BigInt(output);

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

/**
 * Real quote(s) for an intent's size and side. BUY → one quote. SELL → the
 * token's smallest-unit count for $positionSizeUsd is unknown here, so buy the
 * notional first, then quote selling those exact units (two quotes).
 */
export async function quotesForIntent(
  provider: SwapQuoteProvider,
  intent: TradeIntent,
  baseMint: string,
): Promise<QuoteResult> {
  const baseAmount = BigInt(Math.round(intent.positionSizeUsd * 1e6)); // base asset, 6 decimals
  if (intent.side === "BUY") {
    return provider.getQuote({
      inputMint: baseMint,
      outputMint: intent.tokenAddress,
      amount: baseAmount,
      slippageBps: intent.maxSlippageBps,
      chain: intent.chain,
    });
  }
  const notional = await provider.getQuote({
    inputMint: baseMint,
    outputMint: intent.tokenAddress,
    amount: baseAmount,
    slippageBps: intent.maxSlippageBps,
    chain: intent.chain,
  });
  return provider.getQuote({
    inputMint: intent.tokenAddress,
    outputMint: baseMint,
    amount: notional.outputAmount,
    slippageBps: intent.maxSlippageBps,
    chain: intent.chain,
  });
}

export class ShadowExecutionRouter implements ExecutionRouter {
  constructor(
    private readonly quoteProvider: SwapQuoteProvider,
    private readonly logger: Logger,
    /** Base (quote) asset of the chain — WSOL on Solana, USDT on TON. */
    private readonly baseMint = "So11111111111111111111111111111111111111112",
    private readonly guard: IdempotencyGuard = defaultGuard,
  ) {}

  async execute(intent: TradeIntent, currentPriceUsd: number): Promise<ExecutionResult> {
    await assertNotDuplicate(this.guard, intent.id);

    const orderId = generateOrderId();
    const sm = new OrderStateMachine();
    sm.transition("VALIDATING");

    sm.transition("SIMULATING");
    let quote: QuoteResult;
    try {
      quote = await quotesForIntent(this.quoteProvider, intent, this.baseMint);
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
    private readonly guard: IdempotencyGuard = defaultGuard,
  ) {}

  async execute(intent: TradeIntent, currentPriceUsd: number): Promise<ExecutionResult> {
    await assertNotDuplicate(this.guard, intent.id);

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
    baseMint?: string | undefined;
    execution?: TradeExecutionProvider;
    monitoring?: TransactionMonitoringProvider;
    chain?: ChainDataProvider;
    walletPublicKey?: string;
    signTransaction?: (tx: Uint8Array) => Promise<Uint8Array>;
    logger: Logger;
    guard?: IdempotencyGuard;
  },
): ExecutionRouter {
  switch (mode) {
    case "PAPER":
      return new PaperExecutionRouter(deps.logger, deps.guard ?? defaultGuard);

    case "SHADOW":
      if (!deps.quote) throw new Error("Shadow mode requires quoteProvider");
      return new ShadowExecutionRouter(deps.quote, deps.logger, deps.baseMint, deps.guard ?? defaultGuard);

    case "LIVE":
      if (!deps.quote || !deps.execution || !deps.monitoring || !deps.chain ||
          !deps.walletPublicKey || !deps.signTransaction) {
        throw new Error("Live mode requires all execution dependencies");
      }
      return new LiveExecutionRouter(
        deps.quote, deps.execution, deps.monitoring, deps.chain,
        deps.walletPublicKey, deps.signTransaction, deps.logger, undefined,
        deps.guard ?? defaultGuard,
      );
  }
}
