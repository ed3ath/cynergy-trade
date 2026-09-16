# Trading Techniques Reference

Expert reference for every strategy family, signal, sizing scheme, exit technique,
execution tactic, and risk control applicable to this system — with notes on where
each one plugs into the codebase. Read the section you need; don't read end-to-end.

Code seams (see `docs/architecture.md`):

| Concern | Lives in |
|---|---|
| Signals / strategies | `packages/strategy/src/strategies/` — pure fn `StrategyContext → StrategyDecision` |
| Token screening | `packages/scanner` — hard gates, feature engine, 7-dimension scoring |
| Position sizing + hard gates | `packages/core/src/risk/risk-engine.ts` — 14 gates, multiplicative sizing |
| Exits | `packages/position` — stop/trailing/TP/time/deterioration hierarchy |
| Order placement | `packages/execution` — PAPER/SHADOW/LIVE routers |
| Regime context | `packages/core` regime detector → `MarketRegime` in every `StrategyContext` |
| Validation | ShadowTracker (15-min horizon), paper journal, 🔜 backtester |

Invariants that apply to **every** technique below:

1. Strategies are pure and deterministic — no I/O, no clocks, no randomness. All data arrives in `StrategyContext`.
2. Missing/provider-failed data maps to UNKNOWN, never SAFE. No data ⇒ no trade.
3. Risk engine is the only path to execution. No strategy can bypass it.
4. Risk-engine changes require deterministic unit tests (`packages/core/src/risk/`).
5. New strategies enter as PAPER → SHADOW → LIVE. `TRADING_MODE=LIVE` stays off until CLAUDE.md's gate is satisfied.

---

## 1. Strategy families

### 1.1 Trend following / momentum
Ride persistence: assets that moved keep moving (hours→days horizon).

- **Breakout (Donchian)**: enter when price > N-period high (20 typical), exit on M-period low (10). Works on high-vol tokens in TREND regime; whipsaws in RANGE.
- **MA cross**: fast EMA crossing slow EMA (e.g. 9/21). Laggy but simple; use as regime filter, not standalone signal.
- **MACD**: `EMA12 − EMA26` + signal line (EMA9 of it). Signal-line cross with histogram slope confirmation reduces false fires.
- **RSI momentum** (not reversal): RSI > 60 sustained = strength; buy pullbacks to RSI 40–50 in an uptrend. The classic "RSI 70 = sell" reading is a range tool, wrong for memecoins in momentum phase.
- **Time-series momentum**: sign of K-day return predicts next-period return. Simplest robust edge; decays fast on new listings where everyone is front-running the same signal.

Failure mode: chop. Gate by regime detector — only run in TREND/HighVol regimes.

### 1.2 Mean reversion
Price overshoots and snaps back. Requires a stable anchor (VWAP, recent mean) and bounded volatility.

- **Z-score**: `z = (price − μ_N) / σ_N`; enter short-term deviation |z| > 2, exit z → 0. 
- **Bollinger bands**: 20-SMA ± 2σ; band touch + RSI divergence = reversion entry.
- **VWAP reversion**: intraday; price > 2σ above session VWAP with fading volume → fade it.

Nearly always wrong on fresh launches (there is no anchor — the "mean" is 20 minutes old and the token is repricing). Only apply to tokens with days of history and real liquidity, in RANGE regime.

### 1.3 Fresh-listing momentum (current: `fresh-momentum.ts`)
The system's core edge: enter newly launched Solana/TON tokens immediately after they survive screening, ride the attention curve, exit on momentum decay. Key sub-techniques:

- **Early-entry scoring**: weight liquidity growth rate and holder-velocity over absolute levels — a token going 50→300 holders in 10 min beats one sitting at 5k.
- **Attention decay model**: momentum on new listings decays in minutes-to-hours; TP ladders and time stops matter more than indicator exits.
- **Re-entry after cooldown** (already shipped: revive of never-entered REJECTED tokens) — a rejected token that later accumulates liquidity/holders is a new candidate, not a stale one.
- **Migration plays**: Raydium LaunchLab (bonding curve) → Raydium V4/AMM graduation. Graduation is a liquidity and attention event; pre-graduation holders get a volatility window. Trade only post-migration once the AMM pool exists and LP state is verified.

### 1.4 Arbitrage
- **Cross-DEX**: same token on two AMMs; buy cheap pool, sell expensive. On Solana this is mostly competed away by bots with Jito bundles — your realistic edge is on *fresh* pools before arbitrageurs index them, or long-tail tokens.
- **Triangular**: A→B→C→A around one DEX's pools; pure computation over quoted routes; profit only exists after fees+slippage, which Jupiter's router already captures (you're competing with the router itself).
- **CEX-DEX**: price gap between a CEX listing and on-chain pools. Requires CEX market data (not wired) and fast transfer rails — out of scope until providers exist.
- **Funding-rate carry (perps)**: long spot / short perp when funding is positive; harvest funding, delta-neutral. Needs perp venues (not wired). Highest-Sharpe technique in crypto when available; noted for Phase 5+.

### 1.5 Market making
Quote both sides, earn spread, manage inventory. Avellaneda-Stoikov: reservation price `r = S − q·γ·σ²(T−t)`, spread `δ = γσ²(T−t) + (2/γ)ln(1+γ/k)`. On-chain this means concentrated-liquidity positions (Orca/Raydium CLMM), not limit orders. High operational complexity (IL, fee-tier choice, rebalancing) — treat as Phase 5+, not compatible with the current "surgical entries on new tokens" loop.

### 1.6 Statistical arbitrage / pairs
Cointegrated pair (or token vs SOL basket), trade the spread's z-score. Needs a mean to revert to — on week-old memecoins, cointegration is a curve-fit. Viable on SOL vs JUP vs BONK-class established tokens with weeks of data; blocked on backtester + history anyway.

### 1.7 Event-driven
- **Token unlocks / vesting cliffs**: known supply shocks; short bias into unlock, buy capitulation after.
- **CEX listing announcements**: pre-listing drift up; needs news feed (not wired).
- **Airdrop snapshots**: farm-and-dump dynamics distort price post-snapshot.
- All need external data feeds — nothing to wire into `StrategyContext` yet. Park.

### 1.8 Yield / carry (out of scope)
Staking, lending, LP rewards. Not trading; different risk engine (smart-contract risk dominates). Listed here so "all possible" is honest — deliberately not built.

---

## 2. Signal indicators (implementation cheat-sheet)

All computable from candle/trade series in a feature engine. N = lookback.

| Indicator | Formula | Signal use | Gotchas |
|---|---|---|---|
| EMA/SMA | `EMA_t = α·p + (1−α)·EMA_{t−1}`, α=2/(N+1) | trend filter, cross systems | lag ∝ N |
| RSI | `100 − 100/(1+RS)`, RS = avg gain / avg loss over N (14) | >60 strength, <40 pullback-in-uptrend; <30/<70 only for reversion on anchored assets | Wilder smoothing (not simple avg) |
| MACD | EMA12−EMA26, signal EMA9 | cross + histogram slope | laggy; useless on <1h-old tokens |
| Bollinger | SMA20 ± k·σ (k=2) | band touch = stretch | σ on tiny samples is noise |
| ATR | Wilder avg of true range (14) | stop distance, vol-scaled sizing | use for sizing, not direction |
| VWAP | Σ(p·v)/Σ(v) session | reversion anchor, fair value | resets per session; define session for 24/7 markets |
| Volume z-score | (v − μ)/σ of rolling volume | confirm every entry; entry without volume = trap | memecoins: wash volume inflates it — cross-check unique wallets if available |
| Holder velocity | Δholders/Δt | fresh-listing strength (core feature) | sybil wallets; require liquidity growth too |
| Liquidity depth | ask-side depth within 2% of mid | exit feasibility — can you actually get out? | screen on exit-side depth, not headline TVL |
| OBV / volume delta | signed cumulative volume | divergence = exhaustion | noisy on new tokens |
| ADX | from +DI/−DI (14) | >25 = trend worth following | confirm, don't trigger |

Rule of thumb for this system: **entry signals need volume or holder confirmation**; price-only signals on 1-hour-old tokens are bait.

---

## 3. Screening / hard gates (new-token survival filter)

Already implemented in `packages/scanner` (GoPlus + on-chain). The complete checklist a token must survive — ordered cheapest-first so rejects burn no API quota:

1. **Security (GoPlus, chain-adapted)**: mint authority revoked, freeze authority revoked, LP tokens burned or locked. Any alive authority = rug vector = REJECT.
2. **Liquidity**: minimum $ (config floor), and *exit-side* depth ≥ position size ÷ max acceptable slippage. A pool with $80k TVL but one-sided depth can't absorb your exit.
3. **Holder concentration**: top-10 holders < threshold (typ. 15–25%). Bundled/sniper-held supply = instant dump over your exit.
4. **Volume character**: volume/mcap sane (>0.1 for attention), and volume isn't 1-wallet wash (repeat-txn heuristic if data allows).
5. **Age window**: old enough to have post-launch data, young enough for the momentum edge (config band).
6. **Contract sanity** (token-2022 pitfalls): transfer fees, transfer hooks, non-standard decimals — these break exit math silently. Treat unverified token-2022 extensions as REJECT, not UNKNOWN-pass.
7. **Creator history**: deployer of 20 dead tokens = serial rug pattern (needs indexer; heuristic only today).

Data-missing on any gate → UNKNOWN → no trade. Never default-pass.

---

## 4. Position sizing

The risk engine multiplies a base size by gate factors. The families, in case the multiplicative model needs tuning:

| Scheme | Size | Notes |
|---|---|---|
| Fixed fractional | `f · equity` per trade (f = 1–2%) | baseline; current model is this × gate factors |
| Volatility-scaled | `targetRisk$ ÷ (ATR% · entry)` | equalizes risk per trade; right answer when per-token vol varies 10× as it does here |
| Half-Kelly | `f* = p − (1−p)/b`, use f*/2 | optimal-growth upper bound; halves the variance of estimation error. Never full Kelly — edge estimates on memecoins are guesses |
| Fixed-unit | constant $ regardless of equity | fine in PAPER for clean measurement |

Hard caps that override any formula: max concurrent positions, per-token % of portfolio, max portfolio heat (Σ risk of open positions), daily loss limit → halt.

---

## 5. Entry techniques

- **Market entry via Jupiter** (current): swap with slippage cap; fast, pays the spread. Correct for momentum where delay costs more than spread.
- **Limit entries**: only when waiting for a pullback level; on fresh tokens the level usually never comes and the opportunity expires. Use time-limited limits.
- **Scaling in / ladders**: split size across triggers (e.g. 50% on signal, 50% on continuation) — reduces timing luck, doubles execution surface on thin books. Only worth it when depth allows.
- **Priority fees / landing**: on Solana, a fast-failing transaction is better than a slow-landing one in a moving market; fee must scale with urgency (execution router concern).
- **Sniping (block-zero buys)**: deliberately excluded. It's a latency war against dedicated bots, on unverified contracts, with zero screening. Incompatible with the risk firewall.

---

## 6. Exit techniques

The exit hierarchy in `packages/position` (priority order) — each level exists for a distinct failure mode:

1. **Hard stop** (% from entry, or ATR-multiple: `entry − k·ATR`, k≈2): caps single-trade loss. % stops on memecoins: 15–30% typical; tighter = noise-stopped.
2. **Security deterioration**: mint authority re-enabled, LP unlocked, top-holder ballooning → exit *now*, price hasn't moved yet. This is the edge that matters most on new tokens.
3. **Liquidity collapse**: exit-side depth falls below exit-feasibility threshold → exit while the door is open, ahead of the crowd that hasn't checked depth.
4. **Trailing stop**: ratchet (e.g. trail by 20% from high-water mark) — converts rare 10× moves into kept profits; the main PnL source of momentum systems.
5. **Take-profit ladders**: sell fractions (25/25/50%) at R-multiples or % targets — trades off expectancy for variance reduction and psychological irrelevance (bot has no psyche; use it only if it measurably beats a pure trail in backtest).
6. **Time stop**: momentum thesis has a half-life; if X minutes pass without follow-through, the entry signal is stale — exit, don't "wait and see".
7. **Momentum-decay exit**: volume/holder-velocity rollover before price breaks — smart money leaves quietly. Exit into remaining bid depth.

Only one exit reason fires; highest priority wins. Every exit reason is journaled so per-exit-type PnL attribution can be measured.

---

## 7. Portfolio-level risk

- **Correlation**: all memecoins are one beta-to-SOL trade in a drawdown. Cap aggregate exposure to the sector, not just per-token.
- **Regime gating**: regime detector output throttles *total* sizing (RISK-OFF ⇒ no new entries, not just smaller ones).
- **Drawdown circuit breakers**: mark-to-market DD from peak (already tracked) crossing thresholds ⇒ reduce size fractionally, then halt. Ladder the response (−10% ⇒ half size, −20% ⇒ flat + human).
- **Daily loss limit**: hard stop on the day; restarts fresh next UTC day (PnL windows already exist).
- **Kill switch**: instant flat + no-new-entries, persisted (already exists).
- **Operational risk**: provider outage = no new data = no new trades. An UNKNOWN market is not a tradeable market.

---

## 8. Execution tactics

- **Slippage budget**: `expected_slippage = f(size, depth)` — pre-trade, compute max acceptable price impact from the quote (Jupiter returns it); reject if quote impact > budget rather than sending and praying.
- **Failed-transaction policy**: landed-but-unknown status is never retried (idempotency guard owns this); confirmed-fail is re-quotable only as a *new* intent.
- **Partial fills / split swaps**: route large exits through Jupiter split routes; prefer two smaller exits over one book-clearing exit.
- **Exit urgency ladder**: routine TP → market with slippage cap; deterioration/collapse → immediate market, accept impact; the hierarchy in §6 encodes this.
- **TON specifics**: Dedust/STONfi quoting, no MEV-bundle culture like Solana but higher finality latency (~5s round-trip) — momentum entries must account for decision-to-landing drift.

---

## 9. Validation: proving a technique before capital

The promotion ladder (modes are already built):

1. **PAPER** — synthetic quotes, full pipeline. Catches logic errors, not market impact.
2. **SHADOW** — real quotes, no tx; ShadowTracker scores ENTER decisions at 15-min horizon. This is the cheap truth-teller: if shadow expectancy ≤ 0, do not promote.
3. **Backtest** (🔜 Phase 4) — snapshot data accumulating now. When it lands: walk-forward validation (fit on window N, test on N+1), include fees + realized slippage from journal, and demand out-of-sample expectancy > 0 with the *worst* parameter set in a ±20% neighborhood (parameter cliffs = overfit).
4. **LIVE at minimal size**, compare live fills vs shadow quotes to measure true impact.

Metrics to demand (per strategy, per exit type):

| Metric | Formula | Healthy |
|---|---|---|
| Expectancy | `win%·avgWin − loss%·avgLoss` | > 0 after fees, per strategy |
| Profit factor | Σwins / Σlosses | > 1.3, ideally > 1.5 |
| Max drawdown | peak-to-trough equity | < daily-loss-limit × ~3 |
| Sharpe | mean/σ of returns (annualized) | context; memecoin momentum is high-variance by design |
| Win rate | — | meaningless alone — a 20% win-rate trailing-stop system outperforms a 70% win-rate scalper |
| Exposure | % time in market | low exposure + positive expectancy = efficient capital use |

Sample-size honesty: strategy multipliers in the performance tracker already shrink toward neutral on small samples — keep that. A strategy needs O(100) shadow decisions before anyone should believe it.

---

## 10. Memecoin-specific adversarial patterns

The market is actively adversarial; screening exists because of these:

- **Rug pull**: LP withdrawn or minted-away supply. → LP-lock/mint-authority gates, deterioration exits.
- **Honeypot**: buys work, sells revert. → GoPlus sell-tax/honeypot flags; small live probe in SHADOW later.
- **Wash trading**: self-traded volume to fake attention. → volume must correlate with holder growth + unique-wallet data when available.
- **Sniper bundles**: deployer's allied wallets buy block-zero, dump on retail FOMO. → top-holder concentration + age gates.
- **Pump groups / coordinated FOMO**: orchestrated pumps; indistinguishable from organic at entry — that's what hard stops are for. Never widen a stop on a "strong community" thesis.
- **Fake liquidity**: LP added then partially removed post-listing. → liquidity *trend* (falling depth = exit), not level.

---

## 11. What this system deliberately does NOT do

- No leverage, no perps, no shorts (spot-only until perp providers exist).
- No block-zero sniping (unscreened, latency-war).
- No strategies fed by socials/sentiment (no provider; highest spoof-signal density in crypto anyway).
- No `TRADING_MODE=LIVE` until the CLAUDE.md gate (Redis-backed idempotency + real wallet signing) is satisfied and validated in SHADOW.
