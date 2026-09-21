/**
 * Shared tonapi.io client — serial queue, min gap 1100ms (free tier ~1 rps,
 * security + holders providers share one queue so bursts can't 429).
 *
 * Endpoints live-verified 2026-09-16 (see verify-provider-api skill):
 *   GET /v2/jettons/<addr>          → mintable, total_supply, admin{is_scam}, verification, holders_count
 *   GET /v2/jettons/<addr>/holders  → top wallet jetton balances, desc
 *
 * ponytail: tonconsole API key raises the limit — pass apiKey and drop the
 * gap to ~100ms when TON goes beyond paper trading.
 */
export interface TonJetton {
  mintable?: boolean;
  total_supply?: string;
  admin?: { address?: string; is_scam?: boolean } | null;
  verification?: "whitelist" | "blacklist" | "none" | string;
  holders_count?: number;
  metadata?: { name?: string; symbol?: string; decimals?: string };
}

export interface TonHolder {
  address?: string;
  owner?: { address?: string; is_scam?: boolean; name?: string };
  balance?: string;
}

// ─── Account events (wallet swap feed for copy-trade) ────────────────────────
// Live-verified 2026-09-21: envelope {events: [...], next_from}; event keys
// event_id/timestamp(sec)/lt/is_scam/in_progress/actions[type=JettonSwap].
export interface TonJettonRef {
  address: string; // raw 0:hex
  name?: string;
  symbol?: string;
  decimals?: number;
  verification?: string;
}

export interface TonJettonSwapPayload {
  dex?: string;
  amount_in?: number | string; // "" when the in-leg is native TON
  amount_out?: number | string;
  ton_in?: number;
  ton_out?: number;
  user_wallet?: { address?: string; is_scam?: boolean };
  jetton_master_in?: TonJettonRef;
  jetton_master_out?: TonJettonRef;
}

export interface TonAccountEvent {
  event_id: string;
  timestamp: number;
  lt: number;
  is_scam?: boolean;
  in_progress?: boolean;
  actions?: { type: string; JettonSwap?: TonJettonSwapPayload }[];
}

export class TonApiClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    private readonly baseUrl = "https://tonapi.io",
    private readonly minGapMs = 1_100,
  ) {}

  getJetton(address: string): Promise<TonJetton> {
    return this.enqueue<TonJetton>(`/v2/jettons/${address}`);
  }

  getHolders(address: string, limit = 20): Promise<TonHolder[]> {
    // endpoint envelope is {addresses: [...]} — live-verified 2026-09-16
    return this.enqueue<{ addresses?: TonHolder[] }>(`/v2/jettons/${address}/holders?limit=${limit}`)
      .then((b) => b.addresses ?? []);
  }

  /** Newest events first; `beforeLt` pages via next_from / lt cursor. */
  getAccountEvents(address: string, limit = 50, beforeLt?: number): Promise<{ events?: TonAccountEvent[] }> {
    const page = beforeLt !== undefined ? `&before_lt=${beforeLt}` : "";
    return this.enqueue<{ events?: TonAccountEvent[] }>(`/v2/accounts/${address}/events?limit=${limit}${page}`);
  }

  private enqueue<T>(path: string): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.lastCallAt + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();

      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) throw new Error("tonapi rate limited");
      if (!res.ok) throw new Error(`tonapi HTTP ${res.status}`);
      return (await res.json()) as T;
    };
    const next = this.queue.then(run, run); // previous failure must not stall the queue
    this.queue = next.catch(() => undefined);
    return next;
  }
}
