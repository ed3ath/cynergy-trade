import { ProviderError } from "@autonomous-trader/shared";
import type { ProviderHealth } from "@autonomous-trader/shared";
import type { BaseProvider } from "./interfaces.js";

/**
 * Abstract base for all providers.
 * Handles health tracking, retry with exponential backoff, and timeouts.
 */
export abstract class AbstractProvider implements BaseProvider {
  abstract readonly name: string;
  abstract readonly version: string;

  protected isInitialized = false;

  // Health tracking
  private _latencyMs = 0;
  private _lastSuccessAt?: Date;
  private _lastErrorAt?: Date;
  private _recentErrors: number[] = []; // timestamps
  private readonly ERROR_WINDOW_MS = 60_000;

  async initialize(): Promise<void> {
    this.isInitialized = true;
  }

  async shutdown(): Promise<void> {
    this.isInitialized = false;
  }

  async getHealth(): Promise<ProviderHealth> {
    const now = Date.now();
    // Prune errors outside window
    this._recentErrors = this._recentErrors.filter((t) => now - t < this.ERROR_WINDOW_MS);

    const health: ProviderHealth = {
      providerName: this.name,
      providerVersion: this.version,
      isAvailable: this.isInitialized,
      latencyMs: this._latencyMs,
      errorRate: this._recentErrors.length / 60,
      checkedAt: new Date(),
    };
    if (this._lastSuccessAt) health.lastSuccessAt = this._lastSuccessAt;
    if (this._lastErrorAt)   health.lastErrorAt   = this._lastErrorAt;
    return health;
  }

  /** Wrap an async call with timeout, latency tracking, and error recording. */
  protected async call<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    const start = Date.now();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new ProviderError(`Timeout after ${timeoutMs}ms`, this.name)), timeoutMs),
    );

    try {
      const result = await Promise.race([fn(), timeout]);
      this._latencyMs = Date.now() - start;
      this._lastSuccessAt = new Date();
      return result;
    } catch (err) {
      this._latencyMs = Date.now() - start;
      this._lastErrorAt = new Date();
      this._recentErrors.push(Date.now());
      throw err;
    }
  }

  /** Retry with exponential backoff. Does NOT retry on validation errors. */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    opts: { maxRetries?: number; delayMs?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const { maxRetries = 3, delayMs = 1_000, timeoutMs = 10_000 } = opts;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.call(fn, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          const wait = delayMs * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
          await sleep(wait);
        }
      }
    }

    throw lastErr;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
