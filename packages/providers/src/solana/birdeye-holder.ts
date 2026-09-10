/**
 * Birdeye holder analytics adapter.
 *
 * UNVERIFIED: no API key available at build time (2026-09-10) — endpoint shape
 * follows Birdeye's documented holder API family but MUST be live-verified with
 * a key before trusting its output (see verify-provider-api skill).
 * Activation is key-gated; without BIRDEYE_API_KEY the factory keeps the mock.
 *
 * On any parse surprise this adapter returns low-confidence/zeroed fields so
 * HolderFilter's hard gates reject safely (missing data = no trade).
 */
import type { Chain, HolderSnapshot } from "@autonomous-trader/shared";
import { ProviderError } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { HolderAnalyticsProvider } from "../interfaces.js";

interface RawHolderItem {
  owner?: string;
  balance?: string | number;
  pct?: string | number;
  percentage?: string | number;
  is_locked?: boolean;
  tags?: string[];
}

export class BirdeyeHolderProvider extends AbstractProvider implements HolderAnalyticsProvider {
  readonly name = "birdeye-holders";
  readonly version = "0.1.0-unverified";

  private readonly baseUrl = "https://public-api.birdeye.so";

  constructor(private readonly apiKey: string) {
    super();
  }

  async getHolderSnapshot(tokenAddress: string, chain: Chain): Promise<HolderSnapshot> {
    const now = new Date();

    // /defi/holder — top holders list; shape varies, parse tolerantly
    const data = await this.withRetry(async () => {
      const res = await fetch(
        `${this.baseUrl}/defi/holder?address=${tokenAddress}`,
        {
          headers: { "X-API-KEY": this.apiKey, "X-CHAIN": "solana", accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.status === 429) throw new ProviderError("Birdeye holder rate limited", this.name);
      if (!res.ok) throw new ProviderError(`Birdeye holder HTTP ${res.status}`, this.name);
      const body = (await res.json()) as { success?: boolean; data?: unknown };
      return body.data;
    }, { maxRetries: 2 });

    const items = extractHolderItems(data);
    if (items === null) {
      // Unexpected shape — safe snapshot: zero data, low confidence → filters reject
      return emptySnapshot(tokenAddress, chain, now, this.name, 0.1);
    }

    const pct = (i: RawHolderItem): number => {
      const v = i.pct ?? i.percentage;
      if (v === undefined) return 0;
      const n = typeof v === "string" ? parseFloat(v) : v;
      return Number.isFinite(n) ? n : 0;
    };

    const sorted = [...items].sort((a, b) => pct(b) - pct(a));
    const top = (n: number): number =>
      sorted.slice(0, n).reduce((s, i) => s + pct(i), 0);

    // Tagged categories (bundlers/snipers/insiders) only when the API provides them
    const taggedPct = (tag: string): number =>
      sorted.filter((i) => i.tags?.some((t) => t.toLowerCase().includes(tag)))
        .reduce((s, i) => s + pct(i), 0);

    return {
      tokenAddress, chain,
      totalHolders: extractHolderCount(data) ?? sorted.length,
      top1Pct: top(1),
      top5Pct: top(5),
      top10Pct: top(10),
      top20Pct: top(20),
      creatorPct: taggedPct("creator") + taggedPct("dev"),
      insiderPct: taggedPct("insider"),
      sniperPct: taggedPct("sniper"),
      bundlerPct: taggedPct("bundler"),
      whalePct: 0, // not derivable from a plain holder list; zeroed (conservative for filters)
      holderGrowth5m: 0,
      holderGrowth15m: 0,
      holderGrowth1h: 0,
      concentrationChange5m: 0,
      concentrationChange15m: 0,
      observedAt: now,
      provider: this.name,
      // Growth/concentration deltas need prior snapshots — scanner computes them
      // over time; until then confidence stays modest.
      confidence: 0.6,
    };
  }
}

/** Pulls a holder array out of whatever envelope Birdeye returns. */
function extractHolderItems(data: unknown): RawHolderItem[] | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  for (const key of ["holderItem", "holders", "items", "topHolders", "data"]) {
    const v = d[key];
    if (Array.isArray(v)) return v as RawHolderItem[];
  }
  if (Array.isArray(data)) return data as RawHolderItem[];
  return null;
}

function extractHolderCount(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  for (const key of ["holderCount", "totalHolders", "holders", "count"]) {
    const v = d[key];
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return null;
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
