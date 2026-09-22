/**
 * Wallet swap feed for TON copy-trade — parses JettonSwap actions from
 * TonAPI account events into BUY/SELL signals against followed wallets.
 *
 * Schema live-verified 2026-09-21 (verify-provider-api):
 *   GET /v2/accounts/<addr>/events → {events[{event_id,timestamp,lt,is_scam,
 *   in_progress,actions[{type:"JettonSwap",JettonSwap{dex,amount_in,
 *   amount_out,ton_in,ton_out,user_wallet{address},jetton_master_in,
 *   jetton_master_out}}]}]}
 *   - addresses inside payloads are RAW `0:hex`; converted to EQ… here
 *   - amount_in is "" when the in-leg is native TON (ton_in carries it)
 *   - garbage address → HTTP 400 → thrown → caller maps to no-signal
 *
 * ponytail: jetton↔jetton swaps with no TON leg are ignored (direction is
 * ambiguous without pool context); add pair resolution if a followed trader
 * routes through stable pairs.
 */
import { normalizeTonAddress, rawToUserFriendly } from "./ton-address.js";
import type { TonAccountEvent, TonApiClient, TonJettonRef } from "./tonapi-client.js";

export interface WalletSwap {
  eventId: string;
  lt: number;
  timestampSec: number;
  side: "BUY" | "SELL";
  /** Jetton master, user-friendly EQ… form (matches the rest of the system). */
  jettonMaster: string;
  symbol: string;
  decimals: number;
  verification?: string;
  /** Human units of the traded jetton. */
  jettonAmount: number;
  /** TON leg, human units, when the swap touched native/wrapped TON. */
  tonAmount?: number;
  dex: string;
}

const TON_PROXY_SYMBOLS = new Set(["pton", "wton", "ton", "proxy ton", "tshton"]);
const isTonProxy = (ref: TonJettonRef | undefined): boolean =>
  !!ref?.symbol && TON_PROXY_SYMBOLS.has(ref.symbol.toLowerCase());

const num = (v: number | string | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const human = (raw: number, decimals: number | undefined): number =>
  raw / 10 ** (decimals ?? 9);

/** One wallet's swaps, newest first. Only the wallet's own actions count —
 *  events queried from a router address carry other users' swaps. */
export async function getWalletSwaps(
  client: TonApiClient,
  wallet: string,
): Promise<WalletSwap[]> {
  const walletRaw = normalizeTonAddress(wallet);
  const body = await client.getAccountEvents(wallet);
  const swaps: WalletSwap[] = [];

  for (const ev of body.events ?? []) {
    if (ev.is_scam || ev.in_progress) continue;
    for (const action of ev.actions ?? []) {
      const p = action.JettonSwap;
      if (action.type !== "JettonSwap" || !p) continue;
      if (!p.user_wallet?.address) continue; // malformed action — skip, don't kill the wallet's poll
      if (normalizeTonAddress(p.user_wallet.address) !== walletRaw) continue;

      const inIsTon = num(p.ton_in) > 0 || isTonProxy(p.jetton_master_in);
      const outIsTon = num(p.ton_out) > 0 || isTonProxy(p.jetton_master_out);

      let side: "BUY" | "SELL";
      let jetton: TonJettonRef;
      let jettonRaw: number;
      if (inIsTon && p.jetton_master_out && !outIsTon) {
        side = "BUY";
        jetton = p.jetton_master_out;
        jettonRaw = num(p.amount_out);
      } else if (outIsTon && p.jetton_master_in && !inIsTon) {
        side = "SELL";
        jetton = p.jetton_master_in;
        jettonRaw = num(p.amount_in);
      } else {
        continue; // jetton↔jetton or malformed — see ponytail
      }
      if (jettonRaw <= 0) continue;

      const swap: WalletSwap = {
        eventId: ev.event_id,
        lt: ev.lt,
        timestampSec: ev.timestamp,
        side,
        jettonMaster: rawToUserFriendly(jetton.address),
        symbol: jetton.symbol ?? "",
        decimals: jetton.decimals ?? 9,
        jettonAmount: human(jettonRaw, jetton.decimals),
        dex: p.dex ?? "",
      };
      const ton = side === "BUY" ? num(p.ton_in) : num(p.ton_out);
      if (ton > 0) swap.tonAmount = ton / 1e9;
      if (jetton.verification !== undefined) swap.verification = jetton.verification;
      swaps.push(swap);
    }
  }
  return swaps;
}
