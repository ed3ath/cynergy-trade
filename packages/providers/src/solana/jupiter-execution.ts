/**
 * Jupiter execution provider — builds swap transactions via Jupiter /swap endpoint,
 * submits via Solana RPC.
 *
 * POST /swap/v1/swap { quoteResponse, userPublicKey, ... } → base64 swapTransaction
 */
import type { QuoteResult, TradeIntent } from "@autonomous-trader/shared";
import { ProviderError } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { TradeExecutionProvider, TransactionStatus } from "../interfaces.js";
import type { SolanaRpcProvider } from "./solana-rpc-provider.js";

export class JupiterExecutionProvider extends AbstractProvider implements TradeExecutionProvider {
  readonly name = "jupiter-execution";
  readonly version = "1.0.0";

  constructor(
    private readonly rpc: SolanaRpcProvider,
    private readonly apiKey?: string,
    private readonly baseUrl = "https://lite-api.jup.ag",
    private readonly priorityFeeLamports = 100_000,
  ) {
    super();
  }

  private url(path: string): string {
    const base = this.apiKey ? "https://api.jup.ag" : this.baseUrl;
    return `${base}${path}`;
  }

  async buildSwapTransaction(
    quote: QuoteResult,
    walletPublicKey: string,
  ): Promise<{ transaction: Uint8Array; lastValidBlockHeight: number }> {
    // Jupiter embeds the blockhash in swapTransaction; fetch height for expiry tracking
    const { lastValidBlockHeight } = await this.rpc.getRecentBlockhash();

    const res = await fetch(this.url("/swap/v1/swap"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({
        quoteResponse: quote.rawQuote,
        userPublicKey: walletPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: this.priorityFeeLamports,
            priorityLevel: "high",
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new ProviderError(`Jupiter swap build HTTP ${res.status}: ${await res.text()}`, this.name);
    }

    const body = (await res.json()) as { swapTransaction?: string };
    if (!body.swapTransaction) {
      throw new ProviderError("Jupiter swap build missing swapTransaction", this.name);
    }

    const txBytes = new Uint8Array(Buffer.from(body.swapTransaction, "base64"));
    return { transaction: txBytes, lastValidBlockHeight };
  }

  async submitTransaction(
    signedTransaction: Uint8Array,
    _intent: TradeIntent,
  ): Promise<{ signature: string }> {
    return this.rpc.sendTransaction(signedTransaction);
  }

  async getTransactionStatus(signature: string): Promise<TransactionStatus> {
    return this.rpc.getTransactionStatus(signature);
  }
}
