import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, generateTradeIntentId, type TradeIntent, type Position } from "@autonomous-trader/shared";
import { PaperExecutionRouter } from "../../../../execution/src/execution-router.js";
import { InMemoryIdempotencyGuard } from "../../../../execution/src/idempotency.js";
import { PositionManager } from "../../../../position/src/position-manager.js";
import { JournalRepository } from "../journal.js";
import { createNullJournal } from "../null-journal.js";
import type { Database } from "../database.js";

type Row = Record<string, any>;
/** Offline SQL-boundary fake: transactions roll back all tables. It also
 *  models the optimistic order-link guard used by monitoring writes. */
class MemoryJournalDb {
  positions = new Map<string, Row>();
  orders = new Map<string, Row>();
  intents = new Map<string, Row>();
  transactions = 0;
  failPositionWrite = false;
  pauseUpdate: (() => Promise<void>) | undefined;

  query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> => {
    const result = (rows: Row[]) => ({ rows, rowCount: rows.length });
    if (/INSERT INTO (positions|orders|trade_intents)/.test(sql)) {
      const table = sql.match(/INSERT INTO (\w+)/)![1]!;
      if (table === "positions" && this.failPositionWrite) throw new Error("offline write failure");
      const store = table === "positions" ? this.positions : table === "orders" ? this.orders : this.intents;
      const columns = sql.match(/INSERT INTO \w+\s*\(([\s\S]*?)\)\s*VALUES/)![1]!.split(",").map((s) => s.trim());
      const values = sql.split(/VALUES\s*\(/)[1]!.split(",");
      const row: Row = {};
      columns.forEach((column, i) => {
        const expression = values[i]!.trim();
        const param = expression.match(/^\$(\d+)/);
        let value = param ? params[Number(param[1]) - 1] : expression.startsWith("NOW()") ? new Date() : expression.match(/^'([^']+)'/)?.[1];
        if (column === "data_quality") value = JSON.parse(value as string);
        if (value !== null && (column.endsWith("_usd") || column.endsWith("_tokens") || column.startsWith("actual_"))) value = String(value);
        row[column] = value;
      });
      if (store.has(row.id)) return result([]);
      store.set(row.id, row);
      return result([{ id: row.id }]);
    }
    if (sql.includes("UPDATE positions")) {
      await this.pauseUpdate?.();
      if (this.failPositionWrite) throw new Error("offline write failure");
      const row = this.positions.get(String(params[0]));
      if (!row || row.accounting_version !== params[23]) return result([]);
      if (!params[24] && ((row.mode === "PAPER" && row.exit_order_id !== params[19]) || row.updated_at > params[22]!
          || (row.status === "CLOSED" && params[1] !== "CLOSED"))) return result([]);
      const fields = ["status", "current_price", "peak_price", "unrealized_pnl_usd", "unrealized_pnl_pct",
        "drawdown_from_peak_pct", "exit_reason", "stop_loss", "take_profit_1", "take_profit_2", "trailing_stop_pct",
        "size_usd", "size_tokens", "realized_pnl_usd", "realized_gross_pnl_usd", "total_fees_usd",
        "remaining_entry_fee_usd", "entry_order_id", "exit_order_id", "closed_at", "data_quality", "updated_at"];
      fields.forEach((field, i) => {
        if (field === "realized_pnl_usd" && params[i + 1] === null) return;
        row[field] = field === "data_quality" ? JSON.parse(params[i + 1] as string) : params[i + 1];
      });
      return result([row]);
    }
    if (sql.includes("FROM orders WHERE id = $1")) return result([this.orders.get(String(params[0]))].filter(Boolean) as Row[]);
    if (sql.includes("FROM positions WHERE id = $1 FOR UPDATE")) return result([this.positions.get(String(params[0]))].filter(Boolean) as Row[]);
    if (sql.includes("FROM positions p")) {
      return result([...this.positions.values()].filter((p) => p.status !== "CLOSED" && p.mode === params[0] && p.chain === params[1])
        .map((p) => ({ ...p, entry_tx_signature: this.orders.get(p.entry_order_id)?.tx_signature ?? null })));
    }
    if (sql.includes("FROM orders o JOIN trade_intents")) {
      return result([...this.orders.values()].filter((o) => o.status === "CONFIRMED" && o.cash_delta_usd != null
        && o.mode === params[0] && (params[1] === null || o.chain === params[1])
        && (params[2] === null || this.intents.get(o.trade_intent_id)?.strategy_id === params[2])
        && (params[3] === null || o.accounting_version === params[3])
        && (params[4] === null || o.confirmed_at >= params[4]!) && (params[5] === null || o.confirmed_at < params[5]!))
        .map((o) => ({ ...o, strategy_id: this.intents.get(o.trade_intent_id)?.strategy_id })));
    }
    if (sql.includes("AS legacy_positions")) {
      const positions = [...this.positions.values()].filter((p) => p.mode === "PAPER" && p.chain === params[0]);
      const orders = [...this.orders.values()].filter((o) => o.mode === "PAPER" && o.chain === params[0]);
      return result([{ legacy_positions: positions.filter((p) => p.accounting_version !== 2).length,
        legacy_orders: orders.filter((o) => o.accounting_version !== 2).length,
        unresolved_positions: positions.filter((p) => ["OPENING", "CLOSING", "ERROR"].includes(p.status)).length,
        unreconciled_orders: orders.filter((o) => o.cash_delta_usd == null).length }]);
    }
    if (sql.includes("WHERE status = 'CLOSED'")) {
      let rows = [...this.positions.values()].filter((p) => p.status === "CLOSED" && p.mode === params[0] && p.chain === params[1]
        && (params[3] === null || p.closed_at >= params[3]!) && (params[5] === null || p.strategy_id === params[5])
        && (params[4] === null || p.closed_at < params[4]!) && (params[6] === null || p.accounting_version === params[6]));
      if (params[2] !== null) rows = rows.slice(0, Number(params[2]));
      return result(rows.map((p) => ({ ...p, size_usd: p.initial_size_usd ?? p.size_usd })));
    }
    throw new Error(`Unexpected offline query: ${sql}`);
  });

  async transaction<T>(fn: (client: { query: MemoryJournalDb["query"] }) => Promise<T>): Promise<T> {
    this.transactions++;
    const previous = { positions: structuredClone(this.positions), orders: structuredClone(this.orders), intents: structuredClone(this.intents) };
    try {
      return await fn({ query: this.query });
    } catch (error) {
      Object.assign(this, previous);
      throw error;
    }
  }
}

const log = createLogger({ component: "journal-accounting-test" });
const router = () => new PaperExecutionRouter(log, new InMemoryIdempotencyGuard());
function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return { id: generateTradeIntentId(), tokenAddress: "token", chain: "base", side: "BUY", mode: "PAPER",
    strategyId: "ai-autonomous", strategyVersion: "1", riskVersion: "1", positionSizeUsd: 3,
    maxSlippageBps: 300, maxPriceImpactBps: 300, reason: "offline test", createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000), ...overrides };
}
function sell(position: Position, fraction = 1): TradeIntent {
  return intent({ side: "SELL", positionId: position.id, positionSizeUsd: position.sizeUsd * fraction,
    paperTokenQuantity: fraction === 1 ? position.sizeTokens : position.sizeTokens / 2n });
}
const exit = { reason: "offline exit", urgency: "NORMAL" as const, suggestedSellPct: 100 };
async function opened() {
  const db = new MemoryJournalDb();
  const journal = new JournalRepository(db as unknown as Database);
  const manager = new PositionManager(router(), log);
  const buyIntent = intent();
  await journal.recordTradeIntent(buyIntent);
  const buy = await router().execute(buyIntent, 1);
  const position = manager.openPosition(buy, buyIntent, 0.9, 1.03, 1.1, 15);
  position.dataQuality = ["security-unknown-tolerated"];
  await journal.recordConfirmedPaperFill(buy, buyIntent, position, manager.getLastAccounting(position.id)!);
  return { db, journal, manager, position, buy, buyIntent };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-24T12:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("confirmed PAPER journal", () => {
  it("persists the flat round trip without cents rounding and exposes matching cash/PnL facts", async () => {
    const { db, journal, manager, position } = await opened();
    const sellIntent = sell(position);
    await journal.recordTradeIntent(sellIntent);
    const result = await manager.exitPosition(position.id, exit, 1, sellIntent);
    expect(await journal.recordConfirmedPaperFill(result, sellIntent, position, manager.getLastAccounting(position.id)!)).toBe(true);
    const facts = await journal.getAccountingFills({ mode: "PAPER", chain: "base", accountingVersion: 2 });
    expect(facts).toHaveLength(2);
    expect(facts.reduce((sum, f) => sum + f.cashDeltaUsd, 0)).toBeCloseTo(-0.090325, 12);
    expect(facts[1]).toMatchObject({ positionId: position.id, inputAmount: 2_955_000_000n, outputAmount: 2_910_675n,
      dataQuality: ["security-unknown-tolerated"], soldCostBasisUsd: 3, allocatedEntryFeeUsd: 0.0005 });
    const closed = await journal.getClosedTrades("PAPER", "base", null);
    expect(closed[0]?.pnlUsd).toBeCloseTo(-0.090325, 12);
    expect(closed[0]?.sizeUsd).toBe(3);
    expect(closed[0]?.totalFeesUsd).toBe(0.001);
    expect(db.positions.get(position.id)?.size_usd).toBe(0);
    expect(db.positions.get(position.id)?.closed_at).toEqual(result.confirmedAt);
    expect((await journal.getPaperAccountingState("base")).complete).toBe(true);
  });

  it("restores exact partial quantities, entry fees, realized totals, links, and spent TP1", async () => {
    const { journal, manager, position } = await opened();
    const stale = structuredClone(position);
    const partialIntent = sell(position, 0.5);
    await journal.recordTradeIntent(partialIntent);
    const partial = await manager.reducePosition(position.id, 0.5, 1.2, partialIntent);
    await journal.recordConfirmedPaperFill(partial.result, partialIntent, position, partial.accounting!);
    await journal.updatePosition(stale);
    const restored = (await journal.getOpenPositions("PAPER", "base"))[0]!;
    expect(restored).toMatchObject({ sizeTokens: 1_477_500_000n, sizeUsd: 1.5, remainingEntryFeeUsd: 0.00025,
      status: "PARTIAL_EXIT", entryOrderId: position.entryOrderId, exitOrderId: partial.result.orderId });
    expect(restored.takeProfit1).toBeUndefined();
    expect(restored.realizedPnlUsd).toBeCloseTo(0.245655, 12);
    const resumed = new PositionManager(router(), log);
    resumed.restorePosition(restored);
    const finalIntent = sell(restored);
    await journal.recordTradeIntent(finalIntent);
    const final = await resumed.exitPosition(restored.id, exit, 0.8, finalIntent);
    await journal.recordConfirmedPaperFill(final, finalIntent, restored, resumed.getLastAccounting(restored.id)!);
    expect((await journal.getClosedTrades("PAPER", "base", null))[0]?.pnlUsd).toBeCloseTo(-0.090825, 12);
    expect(await journal.getOpenPositions("PAPER", "base")).toEqual([]);
  });

  it("is atomic and idempotent across a failed position write and retry of the SAME fill", async () => {
    const { db, journal, manager, position, buy, buyIntent } = await opened();
    expect(await journal.recordConfirmedPaperFill(buy, buyIntent, position, manager.getLastAccounting(position.id)!)).toBe(false);
    const sellIntent = sell(position, 0.5);
    await journal.recordTradeIntent(sellIntent);
    const partial = await manager.reducePosition(position.id, 0.5, 1.2, sellIntent);
    db.failPositionWrite = true;
    await expect(journal.recordConfirmedPaperFill(partial.result, sellIntent, position, partial.accounting!)).rejects.toThrow(/write failure/);
    expect(db.orders.has(partial.result.orderId)).toBe(false);
    expect((await journal.getOpenPositions("PAPER", "base"))[0]?.sizeTokens).toBe(2_955_000_000n);
    db.failPositionWrite = false;
    expect(await journal.recordConfirmedPaperFill(partial.result, sellIntent, position, partial.accounting!)).toBe(true);
    expect(await journal.recordConfirmedPaperFill(partial.result, sellIntent, position, partial.accounting!)).toBe(false);
    expect(await journal.getAccountingFills({ mode: "PAPER", chain: "base" })).toHaveLength(2);
  });

  it("rejects unconfirmed, conflicting, and non-finite facts without a partial ledger commit", async () => {
    const { db, journal, manager, position, buy, buyIntent } = await opened();
    const entryAccounting = manager.getLastAccounting(position.id)!;
    await expect(journal.recordConfirmedPaperFill({ ...buy, status: "UNKNOWN" }, buyIntent, position, entryAccounting)).rejects.toThrow(/Invalid/);
    await expect(journal.recordConfirmedPaperFill(buy, buyIntent, position, { ...entryAccounting, cashDeltaUsd: NaN })).rejects.toThrow(/Invalid/);
    const sellIntent = sell(position, 0.5);
    await journal.recordTradeIntent(sellIntent);
    const partial = await manager.reducePosition(position.id, 0.5, 1, sellIntent);
    await expect(journal.recordConfirmedPaperFill(partial.result, sellIntent, { ...position, sizeTokens: 1n }, partial.accounting!)).rejects.toThrow(/quantity/);
    expect(db.orders.size).toBe(1);
  });

  it("orders monitoring writes before confirmed fills and rejects later stale snapshots", async () => {
    const { db, journal, manager, position } = await opened();
    const old = structuredClone(position);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    db.pauseUpdate = () => paused;
    const monitor = journal.updatePosition(old);
    const sellIntent = sell(position);
    await journal.recordTradeIntent(sellIntent);
    const final = await manager.exitPosition(position.id, exit, 1, sellIntent);
    const close = journal.recordConfirmedPaperFill(final, sellIntent, position, manager.getLastAccounting(position.id)!);
    await Promise.resolve();
    expect(db.transactions).toBe(1);
    release();
    await Promise.all([monitor, close]);
    old.updatedAt = new Date(Date.now() + 5000);
    await journal.updatePosition(old);
    expect(db.positions.get(position.id)?.status).toBe("CLOSED");
    expect(db.positions.get(position.id)?.size_tokens).toBe("0");
  });

  it("uses UTC half-open date bounds without last-50 truncation or chain mixing", async () => {
    const { journal, manager, position } = await opened();
    vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
    const sellIntent = sell(position);
    await journal.recordTradeIntent(sellIntent);
    const final = await manager.exitPosition(position.id, exit, 1, sellIntent);
    await journal.recordConfirmedPaperFill(final, sellIntent, position, manager.getLastAccounting(position.id)!);
    const from = new Date("2026-09-24T00:00:00Z");
    const to = new Date("2026-09-25T00:00:00Z");
    expect(await journal.getAccountingFills({ mode: "PAPER", chain: "base", from, to })).toHaveLength(1);
    expect(await journal.getAccountingFills({ mode: "PAPER", chain: "ton", from, to })).toHaveLength(0);
    expect(await journal.getClosedTrades("PAPER", "base", null, { from, to })).toHaveLength(0);
    expect(await journal.getClosedTrades("PAPER", "base", null, { from: to })).toHaveLength(1);
  });

  it("retains legacy losses and explicitly reports ambiguous history rather than upgrading it", async () => {
    const { db, journal, position } = await opened();
    const row = db.positions.get(position.id)!;
    Object.assign(row, { accounting_version: 1, status: "CLOSED", realized_pnl_usd: "-0.27", closed_at: new Date(),
      initial_size_usd: null, initial_size_tokens: null, entry_fee_usd: null, remaining_entry_fee_usd: null,
      realized_gross_pnl_usd: null, total_fees_usd: null, data_quality: [] });
    const closed = (await journal.getClosedTrades("PAPER", "base", null))[0]!;
    expect(closed.pnlUsd).toBe(-0.27);
    expect(closed.accountingVersion).toBe(1);
    expect(closed.dataQuality).toContain("legacy-unreconciled");
    expect((await journal.getPaperAccountingState("base"))).toMatchObject({ complete: false, legacyPositions: 1 });
    row.data_quality = ["legacy-realized-pnl-unknown"];
    expect((await journal.getClosedTrades("PAPER", "base", null))[0]?.pnlUsd).toBeNull();
    expect(row.realized_pnl_usd).toBe("-0.27");
  });

  it("persists a known legacy exit as cash-only with unknown net, without changing its recorded loss", async () => {
    const { db, journal, position } = await opened();
    const row = db.positions.get(position.id)!;
    Object.assign(row, { accounting_version: 1, realized_pnl_usd: "-0.27", initial_size_usd: null,
      initial_size_tokens: null, entry_fee_usd: null, remaining_entry_fee_usd: null,
      realized_gross_pnl_usd: null, total_fees_usd: null, entry_order_id: null });
    const legacy = (await journal.getOpenPositions("PAPER", "base"))[0]!;
    const manager = new PositionManager(router(), log);
    manager.restorePosition(legacy);
    const sellIntent = sell(legacy);
    await journal.recordTradeIntent(sellIntent);
    const result = await manager.exitPosition(legacy.id, exit, 1, sellIntent);
    await journal.recordConfirmedPaperFill(result, sellIntent, legacy, manager.getLastAccounting(legacy.id)!);
    const facts = await journal.getAccountingFills({ mode: "PAPER", chain: "base", accountingVersion: 1 });
    expect(facts[0]).toMatchObject({ realizedPnlDeltaUsd: null, realizedGrossPnlDeltaUsd: null,
      soldCostBasisUsd: null, allocatedEntryFeeUsd: null });
    expect(facts[0]?.cashDeltaUsd).toBeCloseTo(2.910175, 12);
    expect(db.positions.get(legacy.id)?.realized_pnl_usd).toBe(-0.27);
    expect((await journal.getClosedTrades("PAPER", "base", null))[0]?.pnlUsd).toBeNull();
  });

  it("raw order inserts are idempotent and NullJournal declares session-only incompleteness", async () => {
    const { db, journal, buy, buyIntent } = await opened();
    await journal.recordExecutionResult(buy, buyIntent);
    await journal.recordExecutionResult(buy, buyIntent);
    expect(db.orders.size).toBe(1);
    const nullJournal = createNullJournal();
    expect(nullJournal.durable).toBe(false);
    expect(await nullJournal.getAccountingFills({ mode: "PAPER" })).toEqual([]);
    expect(await nullJournal.getPaperAccountingState("base")).toMatchObject({ source: "session-only", complete: false });
  });

  it("scopes market history by optional chain without changing existing callers", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const journal = new JournalRepository({ query } as unknown as Database);
    await journal.getMarketSnapshotHistory("same-address", 30, "base");
    expect(query.mock.calls[0]?.[0]).toContain("chain = $3");
    expect(query.mock.calls[0]?.[1]).toEqual(["same-address", 30, "base"]);
    await journal.getMarketSnapshotHistory("same-address");
    expect(query.mock.calls[1]?.[1]).toEqual(["same-address", 240, null]);
  });

  it("migration is additive, defaults legacy to version 1, and never rewrites trading history", () => {
    const migration = readFileSync(new URL("../../../../../infra/migrations/011_paper_accounting.sql", import.meta.url), "utf8");
    expect(migration).toContain("DEFAULT 1");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("ALTER COLUMN realized_pnl_usd TYPE NUMERIC(30,12)");
    expect(migration).not.toMatch(/\b(?:DELETE|TRUNCATE|UPDATE)\s+(?:positions|orders|portfolio_snapshots)\b/i);
  });
});
