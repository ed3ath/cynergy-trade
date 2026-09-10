/**
 * Raydium new-token discovery — poll-based, no webhook receiver needed.
 *
 * Method (live-verified 2026-09-10 against mainnet):
 *   Poll getSignaturesForAddress on Raydium LaunchLab + classic V4 AMM programs.
 *   Parse each tx's postTokenBalances → non-quote mints = tokens in first trade.
 *   First-seen mint → TokenDiscoveredEvent.
 *
 * This catches tokens at their first trades (seconds after pool creation) —
 * exactly the observation-window entry point the scanner wants.
 *
 * Rate limits: use a paid RPC (Helius) in production. Public RPC polling at
 * short intervals will 429.
 *
 * ponytail: replace polling with Helius webhooks when deployed on a host with
 * a public URL (adapter boundary stays — scanner sees the same events).
 */
import type { TokenDiscoveredEvent } from "@autonomous-trader/shared";
import { createLogger, type Logger } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { TokenDiscoveryProvider } from "../interfaces.js";
import type { SolanaRpcProvider } from "./solana-rpc-provider.js";

// Raydium classic AMM v4 + LaunchLab bonding-curve launchpad
export const RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_LAUNCHLAB = "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9";

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "4zMMC9srt5Ri5a14ra27C66vfh6Vq2s2tX4qA9at6BZJ", // USDC (dev)
  "JUPyiwrYJFskUPiHa7hkeR8VUaoJeM9Z29pOHKcfjFr",  // JUP (common quote)
]);

export interface RaydiumDiscoveryConfig {
  pollIntervalMs: number;   // default 15s
  signaturesPerPoll: number; // default 40
  maxSeenMints: number;       // LRU cap, default 50_000
}

const DEFAULTS: RaydiumDiscoveryConfig = {
  pollIntervalMs: 15_000,
  signaturesPerPoll: 40,
  maxSeenMints: 50_000,
};

export class RaydiumDiscoveryProvider extends AbstractProvider implements TokenDiscoveryProvider {
  readonly name = "raydium-discovery";
  readonly version = "1.0.0";

  private handlers: Array<(e: TokenDiscoveredEvent) => void> = [];
  private seenMints = new Set<string>();
  private cursorPerProgram = new Map<string, string>(); // program → oldest processed signature
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private readonly log: Logger;
  private readonly cfg: RaydiumDiscoveryConfig;

  constructor(
    private readonly rpc: SolanaRpcProvider,
    cfg: Partial<RaydiumDiscoveryConfig> = {},
  ) {
    super();
    this.cfg = { ...DEFAULTS, ...cfg };
    this.log = createLogger({ component: "raydium-discovery" });
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    this.pollTimer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs);
    this.log.info("Raydium discovery polling started", {
      programs: [RAYDIUM_LAUNCHLAB.slice(0, 8), RAYDIUM_V4.slice(0, 8)],
      intervalMs: this.cfg.pollIntervalMs,
    });
  }

  override async shutdown(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await super.shutdown();
  }

  subscribe(handler: (event: TokenDiscoveredEvent) => void): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  async getRecentTokens(_since: Date, _limit?: number): Promise<TokenDiscoveredEvent[]> {
    return []; // polling provider has no historical replay; backtester uses recorded snapshots
  }

  /** One poll cycle — public for testing. */
  async pollOnce(): Promise<void> {
    if (this.polling) return; // avoid overlap if RPC is slow
    this.polling = true;
    try {
      for (const program of [RAYDIUM_LAUNCHLAB, RAYDIUM_V4]) {
        await this.pollProgram(program);
      }
    } catch (err) {
      this.log.warn("Discovery poll failed", { error: (err as Error).message });
    } finally {
      this.polling = false;
    }
  }

  private async pollProgram(program: string): Promise<void> {
    const cursor = this.cursorPerProgram.get(program);
    const sigs = await this.rpc.getSignaturesForAddress(program, this.cfg.signaturesPerPoll);
    if (sigs.length === 0) return;

    if (!cursor) {
      // First poll: set cursor, don't backfill history (avoids discovering stale tokens on boot)
      this.cursorPerProgram.set(program, sigs[sigs.length - 1]!.signature);
      return;
    }

    // New signatures = those newer than anything we processed (sigs are newest-first)
    const cursorIdx = sigs.findIndex((s) => s.signature === cursor);
    const newSigs = cursorIdx === -1 ? sigs : sigs.slice(0, cursorIdx);
    if (newSigs.length === 0) return;

    this.cursorPerProgram.set(program, sigs[sigs.length - 1]!.signature);

    for (const sig of newSigs) {
      if (sig.err) continue; // failed tx — skip
      try {
        await this.processTransaction(sig.signature, program);
      } catch {
        // individual tx parse failure is non-fatal
      }
    }
  }

  private async processTransaction(signature: string, program: string): Promise<void> {
    const tx = await this.rpc.getTransaction(signature);
    if (!tx) return;

    const balances = (tx.meta as { postTokenBalances?: Array<{ mint: string }> } | undefined)?.postTokenBalances ?? [];
    const mints = new Set<string>();
    for (const b of balances) {
      if (!QUOTE_MINTS.has(b.mint)) mints.add(b.mint);
    }

    for (const mint of mints) {
      if (this.seenMints.has(mint)) continue;
      this.rememberMint(mint);

      const event: TokenDiscoveredEvent = {
        tokenAddress: mint,
        chain: "solana",
        firstSeenAt: new Date(),
        source: program === RAYDIUM_LAUNCHLAB ? "raydium-launchlab" : "raydium-v4",
      };
      this.log.debug("Token discovered", { mint, source: event.source });
      this.handlers.forEach((h) => h(event));
    }
  }

  private rememberMint(mint: string): void {
    this.seenMints.add(mint);
    // crude LRU: clear entirely when full (fine — re-discovery is harmless, scanner dedupes)
    if (this.seenMints.size > this.cfg.maxSeenMints) this.seenMints.clear();
  }
}
