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
