import type { Chain, DataFreshnessConfig, LiquiditySnapshot, MarketSnapshot, Position, SecurityAssessment } from "@autonomous-trader/shared";
import type { PositionMonitorInput } from "@autonomous-trader/position";
import { currentObservation, tokenKey } from "./trade-guards.js";

export async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Market data deadline exceeded")), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ExitProviders {
  market(token: string, chain: Chain): Promise<MarketSnapshot>;
  liquidity(token: string, chain: Chain): Promise<LiquiditySnapshot>;
  security(token: string, chain: Chain): Promise<SecurityAssessment>;
}

/** Optional observations refresh independently: a slow liquidity/security
 * request must never hold a price-based stop hostage. No financial mutation. */
export class ExitObservations {
  private readonly liquidity = new Map<string, LiquiditySnapshot>();
  private readonly security = new Map<string, SecurityAssessment>();
  private readonly flights = new Map<string, Promise<unknown>>();
  private readonly nextRefresh = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly providers: ExitProviders,
    private readonly freshness: DataFreshnessConfig,
    private readonly onError: (token: string, kind: string, error: unknown) => void,
  ) {}

  async observe(position: Position): Promise<PositionMonitorInput> {
    if (this.disposed) throw new Error("Position observations stopped");
    const token = position.tokenAddress;
    const chain = position.chain;
    const key = tokenKey(chain, token);
    this.refresh(`${key}:liquidity`, token, "liquidity", this.freshness.liquidityMs,
      () => this.providers.liquidity(token, chain), (value) => this.liquidity.set(key, value));
    this.refresh(`${key}:security`, token, "security", this.freshness.securityMs,
      () => this.providers.security(token, chain), (value) => this.security.set(key, value));

    const marketKey = `${key}:market`;
    let flight = this.flights.get(marketKey) as Promise<MarketSnapshot> | undefined;
    if (!flight) {
      flight = Promise.resolve().then(() => this.providers.market(token, chain));
      this.flights.set(marketKey, flight);
      void flight.then(() => this.flights.delete(marketKey), () => this.flights.delete(marketKey));
    }
    const market = await withinDeadline(flight, this.freshness.priceMs);
    const now = Date.now();
    if (this.disposed || !currentObservation(market, token, chain, this.freshness.priceMs, now)
        || !Number.isFinite(market.priceUsd) || market.priceUsd <= 0) {
      throw new Error("No fresh valid price for position exit");
    }
    const input: PositionMonitorInput = { market, timestampMs: now };
    const liquidity = this.liquidity.get(key);
    if (liquidity && currentObservation(liquidity, token, chain, this.freshness.liquidityMs, now)
        && Number.isFinite(liquidity.liquidityUsd) && liquidity.liquidityUsd >= 0
        && Number.isFinite(liquidity.liquidityChange5m)) input.liquidity = liquidity;
    const security = this.security.get(key);
    if (security && currentObservation({ ...security, observedAt: security.dataTimestamp }, token, chain, this.freshness.securityMs, now)) {
      input.security = security;
    }
    return input;
  }

  dispose(): void { this.disposed = true; }

  private refresh<T>(key: string, token: string, kind: string, ttlMs: number, load: () => Promise<T>, store: (value: T) => void): void {
    if (this.flights.has(key) || (this.nextRefresh.get(key) ?? 0) > Date.now()) return;
    const flight = Promise.resolve().then(load);
    this.flights.set(key, flight);
    // Retain the latch until actual settlement even if a provider ignores its
    // own timeout; repeated ticks cannot pile up unbounded requests.
    void flight.then((value) => {
      if (!this.disposed) { store(value); this.nextRefresh.set(key, Date.now() + ttlMs); }
    }, (error: unknown) => {
      if (!this.disposed) {
        this.nextRefresh.set(key, Date.now() + Math.min(ttlMs, 10_000));
        this.onError(token, kind, error);
      }
    }).finally(() => this.flights.delete(key));
  }
}
