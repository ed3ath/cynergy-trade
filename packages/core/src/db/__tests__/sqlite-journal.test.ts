import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLogger,
  generateTradeIntentId,
  type MarketSnapshot,
  type PortfolioSnapshot,
  type Position,
  type TokenDiscoveredEvent,
  type TradeIntent,
} from "@autonomous-trader/shared";
import { PaperExecutionRouter } from "../../../../execution/src/execution-router.js";
import { InMemoryIdempotencyGuard, PgIdempotencyGuard } from "../../../../execution/src/idempotency.js";
import { PositionManager } from "../../../../position/src/position-manager.js";
import { Database } from "../database.js";
import { JournalRepository } from "../journal.js";
import { runMigrations } from "../run-migrations.js";
import { isSqliteUrl, translateSqlite } from "../sqlite-database.js";

/**
 * End-to-end journal against a real file-backed SQLite database: dialect
 * migrations, PG-dialect repository SQL through the translator, FK integrity,
 * big-quantity TEXT round trips, and persistence across a restart.
 * Real timers only — SQLite NOW() is the wall clock, so faking Date would
 * skew the timestamp guards the repositories compare against.
 */
const log = createLogger({ component: "sqlite-journal-test" });
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../../infra/migrations-sqlite", import.meta.url));
const router = () => new PaperExecutionRouter(log, new InMemoryIdempotencyGuard());
const exit = { reason: "offline exit", urgency: "NORMAL" as const, suggestedSellPct: 100 };

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: generateTradeIntentId(), tokenAddress: "token", chain: "base", side: "BUY", mode: "PAPER",
    strategyId: "ai-autonomous", strategyVersion: "1", riskVersion: "1", positionSizeUsd: 3,
    maxSlippageBps: 300, maxPriceImpactBps: 300, reason: "sqlite test", createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000), ...overrides,
  };
}

function sell(position: Position, fraction = 1): TradeIntent {
  return intent({
    side: "SELL", positionId: position.id, positionSizeUsd: position.sizeUsd * fraction,
    paperTokenQuantity: fraction === 1 ? position.sizeTokens : position.sizeTokens / 2n,
  });
}

let dir: string;
let dbUrl: string;
let db: Database;
let journal: JournalRepository;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cynergy-sqlite-"));
  dbUrl = `sqlite:${join(dir, "trader.db")}`;
  db = new Database(dbUrl);
  await db.connect();
  expect(db.dialect).toBe("sqlite");
  expect(await runMigrations(db, MIGRATIONS_DIR)).toBe(11);
  journal = new JournalRepository(db);
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function opened() {
  const manager = new PositionManager(router(), log);
  const buyIntent = intent();
  await journal.recordTradeIntent(buyIntent);
  const buy = await router().execute(buyIntent, 1);
  const position = manager.openPosition(buy, buyIntent, 0.9, 1.03, 1.1, 15);
  position.dataQuality = ["security-unknown-tolerated"];
  await journal.recordConfirmedPaperFill(buy, buyIntent, position, manager.getLastAccounting(position.id)!);
  return { manager, position, buy, buyIntent };
}

async function closedRoundTrip() {
  const { manager, position } = await opened();
  const sellIntent = sell(position);
  await journal.recordTradeIntent(sellIntent);
  const final = await manager.exitPosition(position.id, exit, 1, sellIntent);
  await journal.recordConfirmedPaperFill(final, sellIntent, position, manager.getLastAccounting(position.id)!);
  return { position };
}

describe("sqlite journal (node:sqlite)", () => {
  it("round-trips a closed trade with exact accounting and complete coverage", async () => {
    const { position } = await closedRoundTrip();

    const facts = await journal.getAccountingFills({ mode: "PAPER", chain: "base", accountingVersion: 2 });
    expect(facts).toHaveLength(2);
    expect(facts.reduce((sum, f) => sum + f.cashDeltaUsd, 0)).toBeCloseTo(-0.090325, 12);
    expect(facts[1]).toMatchObject({
      positionId: position.id, inputAmount: 2_955_000_000n, outputAmount: 2_910_675n,
      dataQuality: ["security-unknown-tolerated"], soldCostBasisUsd: 3, allocatedEntryFeeUsd: 0.0005,
    });

    const closed = await journal.getClosedTrades("PAPER", "base", null);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.sizeUsd).toBe(3);
    expect(closed[0]!.totalFeesUsd).toBe(0.001);
    expect(closed[0]!.pnlUsd).toBeCloseTo(-0.090325, 12);
    expect(closed[0]!.dataQuality).toEqual(["security-unknown-tolerated"]);
    expect((await journal.getPaperAccountingState("base")).complete).toBe(true);
  });

  it("keeps trades across a restart and re-applies zero migrations", async () => {
    await closedRoundTrip();

    await db.close();
    db = new Database(dbUrl);
    await db.connect();
    expect(await runMigrations(db, MIGRATIONS_DIR)).toBe(0);

    const reopened = new JournalRepository(db);
    const closed = await reopened.getClosedTrades("PAPER", "base", 50);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.pnlUsd).toBeCloseTo(-0.090325, 12);
    expect((await reopened.getPaperAccountingState("base")).complete).toBe(true);
  });

  it("restores exact partial quantities and rejects stale monitoring writes", async () => {
    const { manager, position } = await opened();
    const stale = structuredClone(position);
    const partialIntent = sell(position, 0.5);
    await journal.recordTradeIntent(partialIntent);
    const partial = await manager.reducePosition(position.id, 0.5, 1.2, partialIntent);
    await journal.recordConfirmedPaperFill(partial.result, partialIntent, position, partial.accounting!);
    // Guarded UPDATE (IS NOT DISTINCT FROM + updated_at): must not resurrect the stale snapshot.
    await journal.updatePosition(stale);

    const restored = (await journal.getOpenPositions("PAPER", "base"))[0]!;
    expect(restored).toMatchObject({
      sizeTokens: 1_477_500_000n, sizeUsd: 1.5, remainingEntryFeeUsd: 0.00025,
      status: "PARTIAL_EXIT", entryOrderId: position.entryOrderId, exitOrderId: partial.result.orderId,
      dataQuality: ["security-unknown-tolerated"],
    });
    expect(restored.takeProfit1).toBeUndefined();
    expect(restored.realizedPnlUsd).toBeCloseTo(0.245655, 12);
    expect(await journal.getOpenPositions("PAPER", "ton")).toEqual([]);
  });

  it("dedupes execution intents and persists kill-switch state and system events", async () => {
    const guard = new PgIdempotencyGuard(db);
    expect(await guard.claim("intent-once")).toBe(true);
    expect(await guard.claim("intent-once")).toBe(false);

    await journal.setSystemState("kill_switch", "true");
    expect(await journal.getSystemState("kill_switch")).toBe("true");
    await journal.setSystemState("kill_switch", "false"); // ON CONFLICT DO UPDATE
    expect(await journal.getSystemState("kill_switch")).toBe("false");

    await journal.recordSystemEvent("STARTUP", "sqlite boot", { ok: true });
    const { rows, rowCount } = await db.query<{ id: string }>(
      "SELECT id FROM system_events WHERE event_type = $1", ["STARTUP"],
    );
    expect(rowCount).toBe(1);
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{32}$/); // gen_random_uuid() replacement
  });

  it("evaluates due shadow decisions through the translated interval and chain scope", async () => {
    await journal.insertShadowDecision({
      tokenAddress: "tok", chain: "base", strategyId: "s", decisionPrice: 1.5, confidence: 0.7,
      horizonMinutes: 15, decidedAt: new Date(Date.now() - 60 * 60_000),
    });
    const due = await journal.getDueShadowDecisions(30, 10, "base");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ tokenAddress: "tok", decisionPrice: 1.5 });
    expect(await journal.getDueShadowDecisions(30, 10, "solana")).toHaveLength(0);

    await journal.updateShadowOutcome(due[0]!.id, 1.8, 20);
    expect(await journal.getDueShadowDecisions(30, 10, "base")).toHaveLength(0);
    expect(await journal.getShadowStats("base")).toMatchObject({ total: 1, evaluated: 1, avgReturnPct: 20, winRate: 1 });
  });

  it("upserts tokens, snapshots equity + price history, and stores regime reason arrays", async () => {
    const event: TokenDiscoveredEvent = { tokenAddress: "tok", chain: "base", firstSeenAt: new Date(), source: "test" };
    await journal.upsertToken(event, "OBSERVING");
    await journal.upsertToken(event, "ELIGIBLE"); // ON CONFLICT DO UPDATE + NOW()
    await journal.updateTokenStatus("tok", "base", "ENTERED");

    const snapshotAt = new Date();
    const portfolio: PortfolioSnapshot = {
      totalValueUsd: 1000, availableCapitalUsd: 700, allocatedUsd: 300, openPositions: 1,
      dailyPnlUsd: -1.5, weeklyPnlUsd: 2.5, monthlyPnlUsd: 10, allTimePnlUsd: 25,
      currentDrawdownPct: 1.25, peakValueUsd: 1100, snapshotAt,
    };
    await journal.recordPortfolioSnapshot(portfolio, "PAPER", "base");
    const latest = await journal.getLatestPortfolioSnapshot("PAPER", "base");
    expect(latest).toMatchObject({ totalValueUsd: 1000, availableCapitalUsd: 700, openPositions: 1 });
    expect(latest!.snapshotAt.getTime()).toBe(snapshotAt.getTime());
    expect(await journal.getPortfolioHistory("PAPER", 500, "base")).toHaveLength(1);

    const market: MarketSnapshot = {
      tokenAddress: "tok", chain: "base", price: 1.5, priceUsd: 1.5,
      volumeUsd1m: 10, volumeUsd5m: 50, volumeUsd15m: 150, volumeUsd1h: 600, volumeUsd24h: 14_400,
      priceChange1m: 1, priceChange5m: 2, priceChange15m: -1, priceChange1h: 3, priceChange24h: 5,
      buyCount1m: 4, sellCount1m: 2, buyCount5m: 20, sellCount5m: 10, buyCount1h: 80, sellCount1h: 40,
      buyVolumeUsd1m: 6, sellVolumeUsd1m: 4, uniqueBuyers1m: 3, uniqueSellers1m: 2,
      tradeCount24h: 900, uniqueTraders24h: 120, observedAt: snapshotAt, provider: "test", confidence: 1,
    };
    await journal.recordMarketSnapshot(market);
    const history = await journal.getMarketSnapshotHistory("tok", 30, "base");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ priceUsd: 1.5, volumeUsd1h: 600 });
    expect(await journal.getMarketSnapshotHistory("tok", 30, "ton")).toHaveLength(0);

    // regime_history.reasons: string[] param → JSON text (TEXT[] equivalent)
    await db.query(
      `INSERT INTO regime_history (chain, regime, trend_pct_1h, volatility_pct, confidence, reasons)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["base", "BULL", 1.5, 2.3, 0.8, ["trend-up", "vol-low"]],
    );
    const { rows } = await db.query<{ reasons: string }>(
      "SELECT reasons FROM regime_history WHERE chain = $1", ["base"],
    );
    expect(JSON.parse(String(rows[0]?.reasons))).toEqual(["trend-up", "vol-low"]);
  });

  it("applies half-open UTC date bounds and chain scoping", async () => {
    await closedRoundTrip();
    const from = new Date(0);
    const future = new Date(Date.now() + 60_000);
    expect(await journal.getClosedTrades("PAPER", "base", null, { from, to: future })).toHaveLength(1);
    expect(await journal.getClosedTrades("PAPER", "ton", null, { from, to: future })).toHaveLength(0);
    expect(await journal.getClosedTrades("PAPER", "base", null, { from: future })).toHaveLength(0);
    expect(await journal.getClosedTrades("PAPER", "base", null, { from, to: new Date(0) })).toHaveLength(0);
    expect(await journal.getAccountingFills({ mode: "PAPER", chain: "base", from, to: future })).toHaveLength(2);
    expect(await journal.getAccountingFills({ mode: "PAPER", chain: "base", from: future, to: future })).toHaveLength(0);
  });
});

describe("translateSqlite", () => {
  it("rewrites PG-only constructs to SQLite", () => {
    expect(translateSqlite("SELECT NOW() AS t")).toBe("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t");
    expect(translateSqlite("SELECT * FROM positions WHERE id = $1 FOR UPDATE"))
      .toBe("SELECT * FROM positions WHERE id = $1");
    expect(translateSqlite("AND ($4::timestamptz IS NULL OR closed_at >= $4) LIMIT $3"))
      .toBe("AND ($4 IS NULL OR closed_at >= $4) LIMIT COALESCE($3, 9223372036854775807)");
    expect(translateSqlite("decided_at < NOW() - ($1 || ' minutes')::interval"))
      .toBe("decided_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || $1 || ' minutes')");
    expect(translateSqlite("SELECT DISTINCT ON (token_address) token_address FROM holder_snapshots WHERE chain = $1"))
      .toBe("SELECT DISTINCT token_address FROM holder_snapshots WHERE chain = $1");
    expect(translateSqlite("UPDATE positions SET s = $2::position_status WHERE ($25 OR x)")).not.toContain("::");
    expect(translateSqlite("to_char(MIN(observed_at),'YYYY-MM-DD') || ' → '"))
      .toBe("strftime('%Y-%m-%d', MIN(observed_at)) || ' → '");
  });

  it("detects the dialect from DATABASE_URL", () => {
    expect(isSqliteUrl("sqlite:data/trader.db")).toBe(true);
    expect(isSqliteUrl("sqlite::memory:")).toBe(true);
    expect(isSqliteUrl("file:/tmp/x.db")).toBe(true);
    expect(isSqliteUrl("/var/lib/trader.db")).toBe(true);
    expect(isSqliteUrl("postgresql://trader:trader@localhost:5432/trader")).toBe(false);
    expect(isSqliteUrl("postgres://localhost:5432/trader")).toBe(false);
  });
});
