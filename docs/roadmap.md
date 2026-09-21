# Roadmap

Where this is going, in dependency order. Dates are triggers ("when X"), not
calendar promises — the bot runs 24/7 and the data decides the pace.
State as of 2026-09-16. See `docs/architecture.md` for how it works.

## Now — running

- TON paper trading 24/7 (PAPER-only by boot guard), hot-pool + new-pool
  discovery, dashboard at `:3000` (live SSE, market table, drill-down, equity)
- Multi-chain runtime (2026-09-21): `TRADING_CHAIN` takes comma lists —
  solana/ton plus keyless EVM chains (bsc/base/polygon/arbitrum, PAPER-only,
  GeckoTerminal+DexScreener+GoPlus). Per-chain equity books, even capital
  split. EVM SHADOW needs a quote aggregator (0x/1inch) — not wired yet.
- Snapshot dataset accumulating in `token_market_snapshots` since 2026-09-12 —
  this is backtester fuel, every hour of runtime pays into Phase B

## Phase A — Prove the edge (passive, costs nothing)

Let the paper run answer: **does FreshMomentum have positive expectancy on
TON at all?**

| # | Item | Done when |
|---|---|---|
| A1 | Let hot-pool-fed watchlist produce trades | ≥30 paper trades closed |
| A2 | ShadowTracker signal quality (win rate, avg return at 15m) | ≥30 shadow signals evaluated, viewable in /metrics |
| A3 | Snapshot coverage audit (tokens tracked, samples/token) | report answers "is the dataset Phase-B-ready?" |

**Gate to B:** A3 says enough data (rough bar: ≥50 tokens with ≥20 samples each,
several days spanning different regimes).

**Kill criterion:** if A1+A2 show clearly negative expectancy after a fair
sample, stop tuning TON and re-evaluate (Solana, different strategy, or both).

## Phase B — Backtester (Phase 4 of the original plan)

Replay recorded snapshots; stop tuning strategy parameters on vibes.

1. ✅ Replay engine — `packages/backtest`
   (`pnpm exec tsx packages/backtest/src/cli.ts --chain ton`); reuses the
   live feature/filter/scoring/strategy/exit code paths. First run on real
   data 2026-09-20: 2 trades / 8 tokens, +9.79%/trade. Holders/security are
   neutral placeholders (ponytail) until those gates need to bite.
2. FreshMomentum parameter sweep on recorded data — **gated on A3 data bar**
   (≥50 tokens × ≥20 samples; ~9 now)
3. Regime conditioning (does the edge exist only in RISK_ON?)
4. Every strategy change after this point ships with a backtest delta

## Phase C — Execution realism (TON)

Close the gap between paper fills and reality before any LIVE thought.

1. ✅ TON SHADOW quotes — STON.fi v1 `swap/simulate` (live-verified
   2026-09-20), `StonQuoteProvider`; SHADOW mode boots on TON
   (`TRADING_MODE=SHADOW`). DeDust quote source = ponytail. Shadow SELL
   amounts fixed chain-agnostically (notional quote → unit quote).
2. Slippage/fee calibration: instrumented 2026-09-20 — every PAPER fill also
   fetches a real STON quote and journals both to `fill_calibration`
   (migration 006); the delta accumulates from normal paper trading
3. TON wallet + signing (LIVE-gated; boot refuses LIVE without it)
4. Solana parity check → decide which chain goes LIVE first

## Phase D — Go-live (hard-gated, smallest capital)

Preconditions (unchanged, per CLAUDE.md and `docs/deployment.md`):

1. ✅ Redis-backed idempotency — `RedisIdempotencyGuard` (SET NX PX, 30d
   TTL, head of the fallback chain: Redis → Pg → memory). Boots when
   `REDIS_URL` is set; **LIVE refuses to start without a healthy Redis**
   (paper/shadow degrade gracefully to Pg)
2. Real wallet signing on the chosen chain (Solana exists; TON = C3)
3. LIVE checklist run through; Telegram alerting verified end-to-end
4. Git remote + off-machine logs — a single dev PC is not an execution venue
5. Start at token-sized capital with daily loss limits already enforced

## Hygiene (pick up opportunistically, cheapest first)

| Item | Why it matters |
|---|---|
| Git remote + push | whole project lives on one machine |
| Dashboard: volume bars in sparkline, auto-refresh open detail panel | polish, data already fetched |
| Helius webhook discovery (Solana) | replaces polling; only matters if Solana is the LIVE chain |
| Birdeye holder shape (needs API key) | better holder data on Solana |

## Decision points ahead (owner's call, not the bot's)

- Which chain goes LIVE first (informed by C4)
- Capital size + max acceptable daily loss for LIVE
- Whether TON SHADOW quote work jumps the queue if paper PnL looks good early
