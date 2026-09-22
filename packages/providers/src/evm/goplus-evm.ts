/**
 * GoPlus EVM token security + holders.
 * Endpoint live-verified 2026-09-21 (verify-provider-api skill):
 *   GET https://api.gopluslabs.io/api/v1/token_security/{chain_id}?contract_addresses=<addr>
 * → { code:1, message:"OK", result: { "<lowercased addr>": { …flat "0"/"1" flags… } } }
 *
 * Shape differs from GoPlus Solana (no {authority,status} wrappers — plain
 * strings). Key verified fields:
 *   is_honeypot, cannot_buy, transfer_pausable, is_mintable, hidden_owner,
 *   selfdestruct, is_blacklisted, slippage_modifiable, personal_slippage_modifiable,
 *   is_anti_whale, anti_whale_modifiable, is_open_source, external_call,
 *   buy_tax/sell_tax (string %), owner_percent/creator_percent (decimal fraction),
 *   holder_count (string), trust_list (0|1), is_in_dex,
 *   holders → top-10 [{ address, balance, percent (decimal fraction), is_locked, is_contract }]
 *
 * Failure semantics: provider error or no data → UNKNOWN, never SAFE.
 */
import type { Chain, HolderSnapshot, SecurityAssessment, SecurityReason, SecurityStatus } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { HolderAnalyticsProvider, TokenSecurityProvider } from "../interfaces.js";

interface GoPlusEvmResult {
  is_honeypot?: string;
  cannot_buy?: string;
  transfer_pausable?: string;
  is_mintable?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  is_blacklisted?: string;
  slippage_modifiable?: string;
  personal_slippage_modifiable?: string;
  is_anti_whale?: string;
  anti_whale_modifiable?: string;
  is_open_source?: string;
  external_call?: string;
  buy_tax?: string;
  sell_tax?: string;
  owner_percent?: string;
  creator_percent?: string;
  holder_count?: string;
  trust_list?: number;
  is_in_dex?: string;
  holders?: Array<{ address?: string; balance?: string; percent?: string; is_locked?: number }>;
}

// ── Process-wide GoPlus call gate ────────────────────────────────────────────
// Keyless tier is 30 req/min per IP, shared by every chain registry in this
// process and by every retry. Observed live 2026-09-22: an unthrottled burst
// locks the IP with HTTP 200 body {code:4029} — invisible to a status check —
// and every token then reads as data-missing (holders "—", security UNKNOWN).
// So: serialize all calls with spacing, dedupe the security/holders
// double-fetch per token (TTL cache + in-flight sharing), never retry
// (a retry burns budget and the next scanner cycle re-fetches anyway), and
// cache only successes — failures fail through to UNKNOWN, never SAFE.
const GPLUS_MIN_INTERVAL_MS = 2_500;   // ~24/min, headroom under 30
const GPLUS_CACHE_TTL_MS = 5 * 60_000; // holder counts / top-10 move slowly
const GPLUS_CACHE_MAX = 1_000;
const GPLUS_BREAKOUT_MS = [30_000, 60_000, 120_000, 300_000]; // escalating lockout
// ponytail: solana/goplus-provider.ts hits the same per-IP 30/min budget
// unthrottled — route it through this gate before adding solana back to
// TRADING_CHAIN alongside EVM chains.

const gplusCache = new Map<string, { expiresAt: number; data: GoPlusEvmResult | null }>();
const gplusInflight = new Map<string, Promise<GoPlusEvmResult | null>>();
let gplusQueue: Promise<void> = Promise.resolve();
let gplusLastCallAt = 0;
// Circuit breaker: observed live 2026-09-22 — after sustained over-budget the
// IP stays 4029-boxed for minutes+ even with traffic stopped; spending into
// the penalty keeps it locked (same lesson as the GeckoTerminal backoff).
// Consecutive rate-limit hits escalate the lockout; any success resets it.
let gplusCooldownUntil = 0;
let gplusRateHits = 0;

/** Clears process-wide gate state — unit tests stub fetch per test. */
export function resetGoPlusGateForTests(): void {
  gplusCache.clear();
  gplusInflight.clear();
  gplusQueue = Promise.resolve();
  gplusLastCallAt = 0;
  gplusCooldownUntil = 0;
  gplusRateHits = 0;
}

function isRateLimitError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return msg.includes("rate limited") || msg.includes("GoPlus code 4029");
}

function gplusFetch(baseUrl: string, chainId: number, tokenAddress: string): Promise<GoPlusEvmResult | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = gplusCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
  if (Date.now() < gplusCooldownUntil) {
    return Promise.reject(new Error("GoPlus cooling down after rate limit"));
  }
  const inflight = gplusInflight.get(key);
  if (inflight) return inflight;

  const run = (async () => {
    // take a place in the process-wide serial queue, spaced off the last call
    const prev = gplusQueue;
    let release!: () => void;
    gplusQueue = new Promise<void>((r) => (release = r));
    await prev;
    const wait = gplusLastCallAt + GPLUS_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gplusLastCallAt = Date.now();
    try {
      const url = `${baseUrl}/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 429) throw new Error("GoPlus rate limited");
      if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`);
      const body = (await res.json()) as { code?: number; result?: Record<string, GoPlusEvmResult> };
      if (body.code !== 1) throw new Error(`GoPlus code ${body.code}`); // 4029 lands here — no retry
      const data = body.result?.[tokenAddress.toLowerCase()] ?? null;
      if (gplusCache.size >= GPLUS_CACHE_MAX) {
        for (const [k, v] of gplusCache) {
          if (v.expiresAt <= Date.now() || gplusCache.size >= GPLUS_CACHE_MAX) gplusCache.delete(k);
        }
      }
      gplusCache.set(key, { expiresAt: Date.now() + GPLUS_CACHE_TTL_MS, data });
      gplusRateHits = 0; // any success ends the breaker escalation
      return data;
    } catch (err) {
      if (isRateLimitError(err)) {
        const backoff = GPLUS_BREAKOUT_MS[Math.min(gplusRateHits, GPLUS_BREAKOUT_MS.length - 1)]!;
        gplusRateHits++;
        gplusCooldownUntil = Date.now() + backoff;
      }
      throw err;
    } finally {
      gplusInflight.delete(key);
      release();
    }
  })();
  gplusInflight.set(key, run);
  return run;
}

export class GoPlusEvmSecurityProvider extends AbstractProvider implements TokenSecurityProvider {
  readonly name = "goplus-evm";
  readonly version = "1.0.0";

  constructor(
    private readonly chainId: number,
    private readonly baseUrl = "https://api.gopluslabs.io",
  ) {
    super();
  }

  async analyzeToken(tokenAddress: string, chain: Chain): Promise<SecurityAssessment> {
    const checkedAt = new Date();
    try {
      const result = await gplusFetch(this.baseUrl, this.chainId, tokenAddress);

      if (!result) {
        // No data ≠ safe
        return assessment(tokenAddress, chain, "UNKNOWN", 30, [
          { code: "NO_DATA", message: "GoPlus returned no data for token", severity: "LOW" },
        ], checkedAt, 0.3);
      }

      const reasons: SecurityReason[] = [];
      let score = 100;
      const flag = (condition: boolean, code: string, message: string, severity: SecurityReason["severity"], penalty: number) => {
        if (condition) {
          reasons.push({ code, message, severity });
          score -= penalty;
        }
      };
      const on = (v?: string) => v === "1";

      // ── Critical: can't trade out ──────────────────────────────────────────
      flag(on(result.is_honeypot), "HONEYPOT", "Token is a honeypot — buys in, sells fail", "CRITICAL", 100);
      flag(on(result.cannot_buy), "CANNOT_BUY", "Token cannot be bought", "CRITICAL", 100);
      flag(on(result.transfer_pausable), "TRANSFER_PAUSABLE", "Owner can pause all transfers", "CRITICAL", 60);

      // ── Rug mechanics ──────────────────────────────────────────────────────
      flag(on(result.is_mintable), "MINTABLE", "Owner can mint more supply", "HIGH", 35);
      flag(on(result.hidden_owner), "HIDDEN_OWNER", "Ownership hidden behind a proxy", "MEDIUM", 20);
      flag(on(result.selfdestruct), "SELFDESTRUCT", "Contract can self-destruct", "HIGH", 35);
      flag(on(result.is_blacklisted), "BLACKLIST_MODE", "Contract maintains a transfer blacklist", "HIGH", 40);
      flag(on(result.slippage_modifiable), "SLIPPAGE_MODIFIABLE", "Tax can be raised after launch", "HIGH", 40);
      flag(on(result.personal_slippage_modifiable), "PERSONAL_TAX_MODIFIABLE", "Per-address tax can be set", "HIGH", 35);
      flag(on(result.is_anti_whale) && on(result.anti_whale_modifiable), "ANTI_WHALE_MODIFIABLE", "Anti-whale limits can change", "MEDIUM", 25);
      flag(on(result.external_call), "EXTERNAL_CALL", "Contract makes external calls during transfer", "MEDIUM", 15);
      flag(!on(result.is_open_source) && result.is_open_source !== undefined, "NOT_OPEN_SOURCE", "Contract source not verified — unreadable logic", "HIGH", 40);

      // ── Taxes (strings like "0.1" = 0.1%) ─────────────────────────────────
      const buyTax = parseFloat(result.buy_tax ?? "");
      const sellTax = parseFloat(result.sell_tax ?? "");
      if (Number.isFinite(sellTax) && sellTax > 10) {
        flag(true, "SELL_TAX_HIGH", `Sell tax ${sellTax.toFixed(1)}% — exit penalty`, "HIGH", 35);
      } else if (Number.isFinite(sellTax) && sellTax > 5) {
        flag(true, "SELL_TAX_ELEVATED", `Sell tax ${sellTax.toFixed(1)}%`, "MEDIUM", 15);
      }
      if (Number.isFinite(buyTax) && buyTax > 10) {
        flag(true, "BUY_TAX_HIGH", `Buy tax ${buyTax.toFixed(1)}%`, "HIGH", 25);
      }

      // ── Holder concentration (top-10, percent = decimal fraction) ─────────
      const holders = result.holders ?? [];
      if (holders.length >= 10) {
        const top10 = holders.slice(0, 10).reduce((s, h) => s + parseFloat(h.percent ?? "0") * 100, 0);
        const top10Unlocked = holders.slice(0, 10)
          .filter((h) => !h.is_locked)
          .reduce((s, h) => s + parseFloat(h.percent ?? "0") * 100, 0);
        flag(top10 > 80, "TOP10_CONCENTRATED", `Top 10 holders hold ${top10.toFixed(1)}% of supply`, "HIGH", 30);
        flag(top10Unlocked > 60, "TOP10_UNLOCKED_CONCENTRATED", `Top 10 unlocked hold ${top10Unlocked.toFixed(1)}% — can dump`, "HIGH", 35);
      }

      // ── Positive signals ──────────────────────────────────────────────────
      if (result.trust_list === 1) score = Math.min(100, score + 10);
      const hc = parseInt(result.holder_count ?? "0", 10);
      if (hc > 10_000) score = Math.min(100, score + 5);

      const hasCritical = reasons.some((r) => r.severity === "CRITICAL");
      const hasHigh = reasons.some((r) => r.severity === "HIGH");
      const status: SecurityStatus = hasCritical ? "REJECT" : hasHigh ? "WARNING" : "SAFE";

      return assessment(tokenAddress, chain, status, Math.max(0, Math.min(100, score)), reasons, checkedAt, 0.9);
    } catch (err) {
      // Provider failure → UNKNOWN, never SAFE
      return assessment(tokenAddress, chain, "UNKNOWN", 30, [
        { code: "PROVIDER_ERROR", message: (err as Error).message, severity: "LOW" },
      ], checkedAt, 0.2);
    }
  }

  async analyzeTokens(tokenAddresses: string[], chain: Chain): Promise<SecurityAssessment[]> {
    return Promise.all(tokenAddresses.map((a) => this.analyzeToken(a, chain)));
  }
}

export class GoPlusEvmHoldersProvider extends AbstractProvider implements HolderAnalyticsProvider {
  readonly name = "goplus-evm-holders";
  readonly version = "1.0.0";

  constructor(
    private readonly chainId: number,
    private readonly baseUrl = "https://api.gopluslabs.io",
  ) {
    super();
  }

  async getHolderSnapshot(tokenAddress: string, chain: Chain): Promise<HolderSnapshot> {
    const now = new Date();
    try {
      const result = await gplusFetch(this.baseUrl, this.chainId, tokenAddress);
      const holders = result?.holders ?? [];
      const totalHolders = parseInt(result?.holder_count ?? "0", 10);
      if (holders.length === 0 || !Number.isFinite(totalHolders) || totalHolders <= 0) {
        return emptySnapshot(tokenAddress, chain, now, this.name, 0.1);
      }

      // percent arrives as a decimal fraction ("0.1414…" = 14.14%) — verified
      // against WBNB top holder 220347/1557835 supply on 2026-09-21.
      const pct = (i: number): number => parseFloat(holders[i]?.percent ?? "0") * 100;
      const top = (n: number): number => {
        let s = 0;
        for (let i = 0; i < Math.min(n, holders.length); i++) s += pct(i);
        return s;
      };

      return {
        tokenAddress,
        chain,
        totalHolders,
        top1Pct: top(1),
        top5Pct: top(5),
        top10Pct: top(10),
        top20Pct: top(10), // API returns top-10 only — top20 ≥ top10, understated
        creatorPct: parseFloat(result?.creator_percent ?? "0") * 100,
        insiderPct: 0,   // EVM-only-via-GoPlus fields — 0 = filters treat as pass
        sniperPct: 0,
        bundlerPct: 0,
        whalePct: 0,
        holderGrowth5m: 0,
        holderGrowth15m: 0,
        holderGrowth1h: 0,
        concentrationChange5m: 0,
        concentrationChange15m: 0,
        observedAt: now,
        provider: this.name,
        confidence: 0.7,
      };
    } catch {
      // missing data = zeroed low-confidence snapshot → filters reject safely
      return emptySnapshot(tokenAddress, chain, now, this.name, 0.1);
    }
  }
}

function assessment(
  tokenAddress: string,
  chain: Chain,
  status: SecurityStatus,
  score: number,
  reasons: SecurityReason[],
  checkedAt: Date,
  confidence: number,
): SecurityAssessment {
  return {
    tokenAddress,
    chain,
    status,
    score,
    reasons,
    providerResults: [{ provider: "goplus-evm", status, rawData: {}, checkedAt, latencyMs: 0 }],
    checkedAt,
    dataTimestamp: checkedAt,
    ageMs: 0,
    confidence,
  };
}

function emptySnapshot(
  tokenAddress: string, chain: Chain, now: Date, provider: string, confidence: number,
): HolderSnapshot {
  return {
    tokenAddress, chain,
    totalHolders: 0, top1Pct: 0, top5Pct: 0, top10Pct: 0, top20Pct: 0,
    creatorPct: 0, insiderPct: 0, sniperPct: 0, bundlerPct: 0, whalePct: 0,
    holderGrowth5m: 0, holderGrowth15m: 0, holderGrowth1h: 0,
    concentrationChange5m: 0, concentrationChange15m: 0,
    observedAt: now, provider, confidence,
  };
}
