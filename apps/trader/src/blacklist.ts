/**
 * Persistent token blacklist — tokens the AI veto agent flagged as sus
 * (wash-trading, rug patterns, honeypot hints) are never re-evaluated.
 * Auto-populated from REJECT verdicts; survives restarts via journal
 * system_state. Without a DB the list is in-memory only (lost on restart).
 *
 * ponytail: permanent entries, no TTL and no manual remove — if a false
 * positive ever matters, add an expiry + a POST /blacklist/remove route.
 */
import type { Logger } from "@autonomous-trader/shared";

export const BLACKLIST_KEY = "blacklist:tokens";
const MAX_ENTRIES = 1000;

export interface BlacklistEntry {
  token: string;
  chain: string;
  reason: string;
  at: string;
}

/** Minimal journal surface this module needs (both Pg + Null satisfy it). */
export interface BlacklistStore {
  getSystemState(key: string): Promise<string | null>;
  setSystemState(key: string, value: string): Promise<void>;
}

export class TokenBlacklist {
  private readonly entries = new Map<string, BlacklistEntry>(); // token → entry, insertion-ordered

  constructor(
    private readonly store: BlacklistStore | null,
    private readonly log: Logger,
  ) {}

  /** Load persisted entries. Tolerant: bad JSON → empty list, never blocks boot. */
  async load(): Promise<void> {
    if (!this.store) return;
    try {
      const raw = await this.store.getSystemState(BLACKLIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as BlacklistEntry[];
      if (!Array.isArray(parsed)) return;
      for (const e of parsed) {
        if (e && typeof e.token === "string") {
          this.entries.set(e.token, {
            token: e.token,
            chain: typeof e.chain === "string" ? e.chain : "",
            reason: typeof e.reason === "string" ? e.reason.slice(0, 300) : "",
            at: typeof e.at === "string" ? e.at : "",
          });
        }
      }
      this.log.info("Token blacklist loaded", { count: this.entries.size });
    } catch (err) {
      this.log.warn("Token blacklist load failed — starting empty", { error: (err as Error).message });
    }
  }

  isListed(token: string): boolean {
    return this.entries.has(token);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Record one vetoed token. Memory-first (sync effect), persist best-effort. */
  add(token: string, chain: string, reason: string): void {
    if (this.entries.has(token)) return;
    this.entries.set(token, { token, chain, reason: reason.slice(0, 300), at: new Date().toISOString() });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    if (!this.store) return;
    void this.store.setSystemState(BLACKLIST_KEY, JSON.stringify([...this.entries.values()]))
      .catch((err: unknown) => this.log.warn("Blacklist persist failed", { error: (err as Error).message }));
  }

  /** Newest-last snapshot for GET /blacklist. */
  snapshot(): BlacklistEntry[] {
    return [...this.entries.values()];
  }
}
