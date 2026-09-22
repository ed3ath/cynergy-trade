import { describe, it, expect } from "vitest";
import { createLogger, type CopyTradeConfig } from "@autonomous-trader/shared";
import type { TonAccountEvent, TonApiClient } from "@autonomous-trader/providers";
import { CopyTradeTracker } from "../copytrade-tracker.js";

const WALLET = "0:451d93a9b728a0470b4cdef5b6994f7888353807387f7ef325d657744ccaa519";
const TOKEN_RAW = "0:5a0a05303a873a80708d967fe82736f4995b3bf581bbc18a1abe1fa8d48b5a9d";

const swapEvent = (eventId: string, lt: number, timestampSec: number): TonAccountEvent => ({
  event_id: eventId,
  timestamp: timestampSec,
  lt,
  is_scam: false,
  in_progress: false,
  actions: [
    {
      type: "JettonSwap",
      JettonSwap: {
        dex: "stonfi",
        amount_in: "",
        amount_out: 1_000_000_000,
        ton_in: 10_000_000_000,
        user_wallet: { address: WALLET },
        jetton_master_out: { address: TOKEN_RAW, symbol: "UTYA", decimals: 9 },
      },
    },
  ],
});

const cfg: CopyTradeConfig = {
  enabled: true,
  wallets: [{ address: WALLET, label: "whale1" }],
  profile: "shortterm",
  pollSec: 30,
  maxSlotsPerToken: 2,
  maxPositions: 3,
  maxSignalAgeSec: 600,
};

const makeClient = (events: TonAccountEvent[]): TonApiClient =>
  ({ getAccountEvents: async () => ({ events }) }) as unknown as TonApiClient;

describe("CopyTradeTracker", () => {
  it("first poll is a baseline — history is not copy-traded", async () => {
    const t = new CopyTradeTracker(makeClient([swapEvent("e1", 100, 1)]), cfg, createLogger({}));
    expect(await t.poll()).toHaveLength(0);
    expect(t.recentActivity()).toHaveLength(0);
  });

  it("emits only fresh BUYs after the baseline, deduped across polls", async () => {
    let now = 1_000_000;
    const t = new CopyTradeTracker(
      makeClient([swapEvent("e1", 100, 1)]),
      cfg,
      createLogger({}),
      () => now,
    );
    await t.poll(); // baseline at lt 100

    const fresh = swapEvent("e2", 200, now / 1000 - 60); // 1 min old
    const client2 = makeClient([fresh, swapEvent("e1", 100, 1)]);
    (t as unknown as { client: TonApiClient }).client = client2;
    const signals = await t.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.swap.jettonMaster.startsWith("EQ")).toBe(true);
    expect(signals[0]!.label).toBe("whale1");
    expect(t.recentActivity()).toHaveLength(1);

    // same events again → no duplicates
    expect(await t.poll()).toHaveLength(0);
    expect(t.recentActivity()).toHaveLength(1);
  });

  it("drops stale buys (older than maxSignalAgeSec) but keeps them as context", async () => {
    let now = 1_000_000;
    const t = new CopyTradeTracker(makeClient([]), cfg, createLogger({}), () => now);
    await t.poll(); // baseline (empty)

    const stale = swapEvent("e3", 300, now / 1000 - 3_600); // 1h old
    (t as unknown as { client: TonApiClient }).client = makeClient([stale]);
    expect(await t.poll()).toHaveLength(0);
    expect(t.recentActivity()).toHaveLength(1); // AI still sees it as context
  });

  it("survives provider errors (empty poll, no throw)", async () => {
    const failing = {
      getAccountEvents: async () => { throw new Error("tonapi rate limited"); },
    } as unknown as TonApiClient;
    const t = new CopyTradeTracker(failing, cfg, createLogger({}));
    await expect(t.poll()).resolves.toHaveLength(0);
  });
});
