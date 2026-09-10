/**
 * Solana JSON-RPC provider — plain fetch, no SDK dependency.
 * Works with any Solana RPC endpoint (Helius, Triton, public).
 *
 * Standard JSON-RPC methods only — stable across providers.
 */
import { ProviderError } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type {
  ChainDataProvider,
  TransactionMonitoringProvider,
  TransactionStatus,
  ChainTransaction,
  SimulationResult,
} from "../interfaces.js";

export class SolanaRpcProvider extends AbstractProvider
  implements ChainDataProvider, TransactionMonitoringProvider {
  readonly name = "solana-rpc";
  readonly version = "1.0.0";

  private rpcIdCounter = 0;

  constructor(private readonly rpcUrl: string) {
    super();
  }

  /** Single JSON-RPC call with timeout. */
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return this.withRetry(async () => {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.rpcIdCounter,
          method,
          params,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 429) throw new ProviderError("RPC rate limited", this.name);
      if (!res.ok) throw new ProviderError(`RPC HTTP ${res.status}`, this.name);

      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new ProviderError(`RPC error: ${body.error.message}`, this.name);
      return body.result as T;
    }, { maxRetries: 2, timeoutMs: 15_000 });
  }

  async getTokenSupply(mintAddress: string): Promise<{ amount: bigint; decimals: number }> {
    const result = await this.rpc<{ value: { amount: string; decimals: number } }>(
      "getTokenSupply", [mintAddress],
    );
    return {
      amount: BigInt(result.value.amount),
      decimals: result.value.decimals,
    };
  }

  async getAccountBalance(publicKey: string): Promise<bigint> {
    const result = await this.rpc<{ value: number }>("getBalance", [publicKey, { commitment: "confirmed" }]);
    return BigInt(result.value);
  }

  async getTransaction(signature: string): Promise<ChainTransaction | null> {
    const result = await this.rpc<ChainTransaction | null>(
      "getTransaction",
      [signature, { jsonParsed: true, maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
    );
    return result;
  }

  async getRecentBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const result = await this.rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      "getLatestBlockhash", [{ commitment: "confirmed" }],
    );
    return {
      blockhash: result.value.blockhash,
      lastValidBlockHeight: result.value.lastValidBlockHeight,
    };
  }

  async simulateTransaction(serializedTx: Uint8Array): Promise<SimulationResult> {
    // base64-encode for RPC (transaction must be a message-only simulation)
    const b64 = Buffer.from(serializedTx).toString("base64");
    const result = await this.rpc<{
      value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
    }>("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, commitment: "confirmed" }]);

    const sim: SimulationResult = {
      success: result.value.err === null || result.value.err === undefined,
      logs: result.value.logs ?? [],
    };
    if (result.value.unitsConsumed !== undefined) sim.unitsConsumed = result.value.unitsConsumed;
    if (result.value.err) sim.error = JSON.stringify(result.value.err);
    return sim;
  }

  async getTransactionStatus(signature: string): Promise<TransactionStatus> {
    const result = await this.rpc<Array<{ confirmationStatus?: string; slot: number; confirmations: number | null; err: unknown } | null>>(
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
    );

    const status = result?.[0];
    if (!status) {
      return { signature, status: "not_found" };
    }
    if (status.err) {
      return { signature, status: "failed", slot: status.slot, error: JSON.stringify(status.err) };
    }
    if (status.confirmationStatus === "finalized") {
      return { signature, status: "finalized", slot: status.slot };
    }
    if (status.confirmationStatus === "confirmed") {
      return { signature, status: "confirmed", slot: status.slot, confirmations: status.confirmations ?? 32 };
    }
    return { signature, status: "pending", slot: status.slot };
  }

  /** Poll until terminal status or timeout. Never resubmits — monitoring only. */
  async monitorTransaction(
    signature: string,
    timeoutMs: number,
    onUpdate: (status: TransactionStatus) => void,
  ): Promise<TransactionStatus> {
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 1_500;

    while (Date.now() < deadline) {
      try {
        const status = await this.getTransactionStatus(signature);
        onUpdate(status);

        if (status.status === "finalized" || status.status === "failed") {
          return status;
        }
        if (status.status === "confirmed") {
          // confirmed is good enough to proceed; keep waiting briefly for finalized
          return status;
        }
      } catch (err) {
        // transient RPC error — keep polling until deadline
        onUpdate({ signature, status: "pending", error: (err as Error).message });
      }
      await sleep(POLL_MS);
    }

    return { signature, status: "not_found", error: `Timed out after ${timeoutMs}ms` };
  }

  /** Submit a signed transaction. Returns immediately with signature. */
  async sendTransaction(signedTx: Uint8Array): Promise<{ signature: string }> {
    const b64 = Buffer.from(signedTx).toString("base64");
    const signature = await this.rpc<string>(
      "sendTransaction",
      [b64, { encoding: "base64", skipPreflight: false, maxRetries: 2, preflightCommitment: "confirmed" }],
    );
    return { signature };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
