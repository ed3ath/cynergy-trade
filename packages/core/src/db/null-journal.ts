/**
 * Null journal — used when DB is not configured (dev/paper without postgres).
 * Writes are session-only no-ops. Reads explicitly report missing durability.
 */
import type { JournalRepository } from "./journal.js";

export type Journal = Pick<JournalRepository, keyof JournalRepository>;
export type NullJournal = Journal;

/** Creates a proxy that swallows all calls — useful when DB absent. */
export function createNullJournal(): NullJournal {
  const reads: Partial<Journal> = {
    durable: false,
    getOpenPositions: async () => [],
    getClosedTrades: async () => [],
    getAccountingFills: async () => [],
    getPaperAccountingState: async () => ({
      source: "session-only", complete: false, fills: [], legacyPositions: 0, legacyOrders: 0,
      unresolvedPositions: 0, unreconciledOrders: 0, issues: ["No durable journal; PAPER accounting is session-only and incomplete"],
    }),
    getLatestPortfolioSnapshot: async () => null,
    getPortfolioHistory: async () => [],
    getMarketSnapshotHistory: async () => [],
    getDueShadowDecisions: async () => [],
    getShadowStats: async () => ({ total: 0, evaluated: 0, avgReturnPct: 0, winRate: 0 }),
    getSystemState: async () => null,
    recordConfirmedPaperFill: async () => true,
  };
  return new Proxy(reads, {
    get: (target, key) => Reflect.get(target, key) ?? (key === "then" ? undefined : async () => undefined),
  }) as NullJournal;
}
