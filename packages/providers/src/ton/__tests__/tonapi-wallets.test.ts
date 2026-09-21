import { describe, it, expect } from "vitest";
import { getWalletSwaps } from "../tonapi-wallets.js";
import type { TonAccountEvent, TonApiClient } from "../tonapi-client.js";

// Payload shapes captured live from tonapi /v2/accounts/<addr>/events 2026-09-21.
const WALLET_RAW = "0:451d93a9b728a0470b4cdef5b6994f7888353807387f7ef325d657744ccaa519";
const UTYA_RAW = "0:5a0a05303a873a80708d967fe82736f4995b3bf581bbc18a1abe1fa8d48b5a9d";
const PTON_RAW = "0:8cdc1d7640ad5ee326527fc1ad0514f468b30dc84b0173f0e155f451b4e11f7c";

const events: TonAccountEvent[] = [
  {
    event_id: "f6f2a7f323fe8e5de2a9",
    timestamp: 1789995624,
    lt: 104944701000046,
    is_scam: false,
    in_progress: false,
    actions: [
      {
        type: "JettonSwap",
        JettonSwap: {
          dex: "stonfi",
          amount_in: "",
          amount_out: 2_970_360_409_711,
          ton_in: 56_167_363_901,
          user_wallet: { address: WALLET_RAW, is_scam: false },
          jetton_master_out: {
            address: UTYA_RAW, name: "Utya", symbol: "UTYA", decimals: 9,
            verification: "whitelist",
          },
        },
      },
    ],
  },
  {
    event_id: "64a1db9f366ebd2e32ac",
    timestamp: 1789995696,
    lt: 104944880000025,
    is_scam: false,
    in_progress: false,
    actions: [
      {
        type: "JettonSwap",
        JettonSwap: {
          dex: "stonfi",
          amount_in: 45_785_600_000_000,
          amount_out: 1_584_207_640,
          user_wallet: { address: WALLET_RAW, is_scam: false },
          jetton_master_in: {
            address: "0:afc49cb8786f21c87045b19ede78fc6b46c51048513f8e9a6d44060199c1bf0c",
            name: "Dogs", symbol: "DOGS", decimals: 9,
          },
          jetton_master_out: { address: PTON_RAW, name: "Proxy TON", symbol: "pTON", decimals: 9 },
        },
      },
    ],
  },
  {
    // someone else's swap riding the same query — must be filtered out
    event_id: "otherwallet000000000",
    timestamp: 1789995700,
    lt: 104944890000001,
    actions: [
      {
        type: "JettonSwap",
        JettonSwap: {
          dex: "stonfi",
          ton_in: 1_000_000_000,
          amount_out: 1_000_000_000,
          user_wallet: { address: "0:deadbeef" },
          jetton_master_out: { address: UTYA_RAW, symbol: "UTYA", decimals: 9 },
        },
      },
    ],
  },
  { event_id: "scam000000000000000", timestamp: 1789995710, lt: 104944895000002, is_scam: true, actions: [] },
];

const client = {
  getAccountEvents: async () => ({ events }),
} as unknown as TonApiClient;

describe("getWalletSwaps", () => {
  it("classifies native-TON buys and jetton→pTON sells, EQ-normalized", async () => {
    const swaps = await getWalletSwaps(client, WALLET_RAW);
    expect(swaps).toHaveLength(2);

    const buy = swaps.find((s) => s.side === "BUY")!;
    expect(buy.jettonMaster.startsWith("EQ")).toBe(true);
    expect(buy.symbol).toBe("UTYA");
    expect(buy.jettonAmount).toBeCloseTo(2_970.36, 2);
    expect(buy.tonAmount).toBeCloseTo(56.17, 2);
    expect(buy.verification).toBe("whitelist");
    expect(buy.eventId).toBe("f6f2a7f323fe8e5de2a9");

    const sell = swaps.find((s) => s.side === "SELL")!;
    expect(sell.symbol).toBe("DOGS");
    expect(sell.jettonAmount).toBeCloseTo(45_785.6, 1);
  });

  it("ignores other wallets' swaps, scam and empty events", async () => {
    const swaps = await getWalletSwaps(client, WALLET_RAW);
    expect(swaps.every((s) => s.eventId !== "otherwallet000000000")).toBe(true);
    expect(swaps.every((s) => s.eventId !== "scam000000000000000")).toBe(true);
  });
});
