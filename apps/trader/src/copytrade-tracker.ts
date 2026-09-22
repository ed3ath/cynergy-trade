/**
 * Copy-trade wallet tracker — polls followed wallets' swaps and emits fresh
 * BUY signals (and keeps recent activity, incl. SELLS, for the AI's
 * take-profit analysis). Deterministic and non-fatal: any provider failure
 * logs and returns empty — copy-trading never blocks the 10s loop.
 *
 * TON-only today (TonApiClient). ponytail: solana needs a Helius/GMGN wallet
 * feed adapter (verify with verify-provider-api); EVM a GMGN/Cielo one —
 * add per-chain trackers when those chains leave paper mode.
 */
import type { CopyTradeConfig, Logger } from "@autonomous-trader/shared";
import { getWalletSwaps, type TonApiClient, type WalletSwap } from "@autonomous-trader/providers";

/** A tracked wallet's swap worth acting on (BUY) or seeing (either side). */
export interface CopyTradeSignal {
  wallet: string;      // as configured (raw or EQ)
  label: string;
  swap: WalletSwap;
}

export class CopyTradeTracker {
  /** wallet → highest lt already processed. The first successful fetch per
   *  wallet is a baseline only (even with zero events) — history is not
   *  copy-traded. In-memory; restart re-baselines (worst case: swaps from the
   *  downtime window are skipped, never re-copied). */
  private readonly cursors = new Map<string, number>();
  private readonly baselined = new Set<string>();
  /** `${eventId}:${side}:${jettonMaster}` → seen. Bounded ring. */
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** Last N swaps across all wallets, newest last — AI snapshot context and
   *  the dashboard's trader-records tab (observe mode records without trading). */
  private readonly recent: CopyTradeSignal[] = [];

  constructor(
    private readonly client: TonApiClient,
    private readonly cfg: CopyTradeConfig,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    /** Audit hook — fired once for EVERY fresh swap (BUY and SELL), including
     *  in observe mode. JSONL/actvity wiring lives in index.ts. */
    private readonly onRecord?: (s: CopyTradeSignal) => void,
  ) {}

  /** Poll all followed wallets. Returns fresh BUY signals (age-filtered). */
  async poll(): Promise<CopyTradeSignal[]> {
    const signals: CopyTradeSignal[] = [];
    for (const w of this.cfg.wallets) {
      let swaps: WalletSwap[];
      try {
        swaps = await getWalletSwaps(this.client, w.address);
      } catch (err) {
        this.log.warn("copytrade wallet poll failed", {
          wallet: w.label ?? w.address.slice(0, 16),
          error: (err as Error).message,
        });
        continue;
      }

      if (!this.baselined.has(w.address)) {
        this.baselined.add(w.address);
        const newest = swaps.reduce((max, s) => Math.max(max, s.lt), 0);
        this.cursors.set(w.address, newest);
        continue; // first fetch: baseline only, don't emit history
      }

      const cursor = this.cursors.get(w.address) ?? 0;
      let newest = cursor;
      for (const swap of swaps) {
        if (swap.lt > newest) newest = swap.lt;
        if (swap.lt <= cursor) continue; // already processed
        const key = `${swap.eventId}:${swap.side}:${swap.jettonMaster}`;
        if (this.seen.has(key)) continue;
        this.markSeen(key);

        const signal: CopyTradeSignal = {
          wallet: w.address,
          label: w.label ?? w.address.slice(0, 12),
          swap,
        };
        this.recent.push(signal);
        if (this.recent.length > 200) this.recent.shift();
        this.onRecord?.(signal);

        const ageSec = this.now() / 1000 - swap.timestampSec;
        if (swap.side === "BUY" && ageSec <= this.cfg.maxSignalAgeSec) {
          signals.push(signal);
        }
      }
      this.cursors.set(w.address, newest);
    }
    if (signals.length > 0) {
      this.log.info("copytrade signals", {
        count: signals.length,
        tokens: signals.map((s) => `${s.swap.side === "BUY" ? "+" : "-"}${s.swap.symbol}`).join(","),
      });
    }
    return signals;
  }

  /** Recent tracked-wallet activity for the AI snapshot (both sides,
   *  newest last, capped). SELLs of held tokens are take-profit hints. */
  recentActivity(limit = 10): CopyTradeSignal[] {
    return this.recent.slice(-limit);
  }

  private markSeen(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 500) {
      const drop = this.seenOrder.splice(0, this.seenOrder.length - 500);
      for (const k of drop) this.seen.delete(k);
    }
  }
}
