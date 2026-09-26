# Architecture

Roadmap + phase gates: `docs/roadmap.md`.

## Overview

Autonomous crypto trading system targeting newly-launched tokens. `TRADING_CHAIN` selects
the chains traded simultaneously — a comma list of `solana`, `ton`, and the keyless EVM
family `bsc|base|polygon|arbitrum|ethereum|avalanche|optimism|linea|mantle|blast|zksync|scroll`
(e.g. `TRADING_CHAIN=solana,ton,bsc`, default `solana`; all EVM chains are PAPER-only).
TypeScript monorepo, modular packages, deterministic risk firewall around all capital deployment.

Multi-chain model: one runtime per chain (providers, scanner, execution router, positions,
equity book, regime sampler). Shared: journal, emergency controller, idempotency guard,
risk engine, alerter, AI agents, performance trackers. `STARTING_CAPITAL_USD` splits evenly
across active chains (`base_capital_usd:<chain>` system-state keys). Risk limits apply
per-chain book; a daily-loss breach on any chain stops new entries globally (fail-safe).

```
DISCOVERY → SCANNER → STRATEGY ENSEMBLE → RISK ENGINE → EXECUTION → POSITION MGMT → PERFORMANCE
```

## Package layout

| Package | Purpose |
|---|---|
| `@autonomous-trader/shared` | Domain types, config (zod-validated), structured logger, ID generators |
| `@autonomous-trader/providers` | Provider interfaces + mock and live implementations (GoPlus, Jupiter, Birdeye, SolanaRPC, Raydium discovery, TON: TonAPI + GeckoTerminal, EVM: GeckoTerminal + DexScreener + GoPlus), health tracking |
| `@autonomous-trader/core` | State machines, risk engine, emergency controller, performance tracker, regime detector, trade journal (SQLite by default via `node:sqlite`, Postgres when `DATABASE_URL` is `postgresql://…`) |
| `@autonomous-trader/scanner` | Token lifecycle, feature engine, hard-gate filters, scoring |
| `@autonomous-trader/strategy` | Strategy interface, ensemble engine (Fresh Momentum, Micro Scalp) |
| `@autonomous-trader/execution` | Paper/Shadow/Live execution routers, durable idempotency guard, wallet signing |
| `@autonomous-trader/position` | Position manager, exit engine (stop/trailing/TP/time/deterioration) |
| `@autonomous-trader/backtest` | Snapshot dataset loading + decision-loop replay |
| `apps/trader` | Decision loop (10s cycle), HTTP monitor + emergency controls, ShadowTracker, alerter, daily reports |

## Data flow

1. **Discovery** — providers emit `TokenDiscoveredEvent`s (mock stream in dev; Helius streams in prod)
2. **Scanner** — each token enters a state machine: `DISCOVERED → OBSERVING → SCREENING → ELIGIBLE → WATCHLIST → TRADE_CANDIDATE`
3. **Features** — market/liquidity/holder/security snapshots → feature set with timestamps + confidence
4. **Hard gates** — security REJECT, low liquidity, high concentration, draining liquidity → immediate rejection
5. **Scoring** — 7 dimensions 0–100, weighted composite opportunity score
6. **Strategy** — pure functions over `StrategyContext` → `StrategyDecision`
7. **Risk engine** — 14 hard gates + multiplicative position sizing, the only path to execution
8. **Execution** — PAPER (synthetic), SHADOW (real quote, no tx), LIVE (full pipeline with simulation)
9. **Position mgmt** — exit hierarchy: hard stop → security deterioration → liquidity collapse → trailing → TP → time stop
10. **Performance** — outcomes feed strategy multipliers with shrinkage for small samples

## AI agent (`AI_AUTONOMY`)

Optional LLM against any OpenAI-compatible `/chat/completions` endpoint. One shared
daily USD budget (`AI_MAX_COST_PER_DAY_USD`) across both agents (`apps/trader/src/ai-budget.ts`).

- `off` — agent dead
- `veto` (default) — `AiVetoAgent` (`apps/trader/src/ai-agent.ts`): one-shot APPROVE/REJECT second
  opinion on strategy candidates, cached per token, UNKNOWN on any failure (never blocks trading)
- `auto` — `AiTraderAgent` (`apps/trader/src/ai-trader-agent.ts`): the **sole entry decision
  maker** — strategies advise, the agent decides. The 10s deterministic loop still evaluates the
  ensemble, but only records its per-token view (fires and declines, with reasons) into a
  guidance map and shadow-tracks ENTER signals; nothing enters deterministically and the veto
  agent has nothing to gate. Every `AI_CYCLE_SEC` the host builds a snapshot (portfolio, open
  positions, top scanner candidates carrying the ensemble's `strategyViews`, recent trades);
  the agent replies with STRICT-JSON actions, executed only through host guards:
  - `ENTER` (token of its choice — host fetches fresh market/liquidity/security, any fetch
    failure skips the action) → routed through `executeEntry`, i.e. the **same risk engine +
    journal as strategies** under `strategyId: "ai-autonomous"`. AI never sets absolute size;
    its 0–1 confidence only feeds the sizing multiplier.
  - `EXIT` — any position, full-size sell through the normal exit path (`executeExit`)
  - `TIGHTEN` — `PositionManager.tightenExits`, a one-way ratchet: stop only moves up,
    TP/trailing only move down. The emergency tier (hard stop, security, liquidity collapse)
    is computed from live inputs each tick — structurally unreachable by AI.
  - Guards: per-cycle action cap, per-token cooldown, AI-open-position cap, kill switch /
    `stopNewEntries` (blocks ENTERs only — exits always allowed). Cost cap or timeout →
    empty cycle, never a thrown error, never blocks the 10s deterministic loop. Since the
    agent is the only entry path in auto, a dead gateway or cost cap means no new entries
    until it recovers — open positions keep managing and exiting normally.

### Copy-trade (`COPYTRADE_ENABLED`, TON-only)

Follows curated high-PNL wallets (`COPYTRADE_WALLETS`, TonAPI account events —
live-verified feed in `packages/providers/src/ton/tonapi-wallets.ts`) and can hold
**multiple positions per token**: `copytrade-scalp` (SL 5%, TP 3/6%, 20min) and
`copytrade-shortterm` (SL 10%, TP 5/10%, 2h) slots stack with each other and with
core strategy positions; aggregate per-token exposure stays capped by the risk
engine's `maxTokenExposureUsd` gate. Every entry — copied or AI — goes through
`executeEntry` (full risk engine + journal).

- `AI_AUTONOMY=veto` → deterministic copy: each fresh tracked BUY (≤10min old)
  is veto-agent reviewed, then entered under the profile exit envelope.
- `AI_AUTONOMY=auto` → tracked swaps (BUYs and SELLs) feed the AI trader
  snapshot: the agent verifies leads with its read-only tools, ENTERs with a
  chosen profile, and uses trader SELLs as take-profit hints (TIGHTEN/EXIT).
- Tracker cursors are in-memory; restart re-baselines (no stale copy, no re-copy).
  ponytail: wallet list is operator-curated — no PNL leaderboard API exists for
  TON; solana/EVM feeds need their own wallet adapters.

## Safety model

- **Risk engine is the final authority** — no component can bypass it
- **Kill switch** persists across restarts (DB `system_state` table)
- **Idempotency**: each `trade_intent_id` executes at most once
- **UNKNOWN tx status → never resubmit**, operator investigates
- **Default mode is PAPER**; promotion to LIVE requires explicit config change
- **Missing data = no trade** (UNKNOWN security with low confidence is a hard reject)

## Modes

| Mode | Quote | Transaction | Use |
|---|---|---|---|
| PAPER | synthetic | none | development, CI |
| SHADOW | real | none | validation of fills vs decisions |
| LIVE | real | real | production |

## Current state (2026-09-12)

- ✅ Phase 0: monorepo, types, config, logging, tests, Docker, migrations
- ✅ Phase 1: real adapters — GoPlus/Jupiter/Birdeye/SolanaRPC (verified live), Raydium LaunchLab+V4 discovery via public RPC (`ENABLE_PUBLIC_DISCOVERY=true`) or Helius key; Birdeye holder shape unverified (key-gated); Postgres journal with NullJournal fallback
- ✅ Phase 2: scanner pipeline, features, filters, scoring, snapshot persistence (backtester dataset, 60s/token throttle)
- ✅ Phase 3: decision loop (10s cycle), paper trading end-to-end, market regime detector, restart recovery (positions restored from journal), Telegram alerting (critical events), daily reports, PnL windows (UTC day/week) + mark-to-market drawdown
- ✅ Ops: HTTP monitor (`/health /status /events /metrics /market /history /trades /report`, dashboard at `/`, bearer-auth emergency controls), `docker-compose.prod.yml` (self-migrating boot), ShadowTracker (ENTER decisions evaluated at 15min horizon → `shadow_decisions`)
- ✅ Durable idempotency (Postgres `executed_intents` + fallback), wallet signing (`WALLET_PRIVATE_KEY` → VersionedTransaction)
- ✅ TON chain (`TRADING_CHAIN=ton`, TonAPI/GeckoTerminal providers, coarse-path strategy), multi-opportunity trading (remaining balance, per-tick equity), dashboard UI at `/`
- ✅ Multi-chain simultaneous trading: `TRADING_CHAIN` accepts comma lists; EVM family (bsc/base/polygon/arbitrum) on GeckoTerminal discovery + DexScreener market/liquidity + GoPlus EVM security/holders — all keyless, PAPER-only (SHADOW/LIVE boot-refused until a quote aggregator + signing path exist)
- 🔜 Phase 4: backtester at volume (needs accumulated snapshot data — run paper mode 24/7 first)
- 🔜 Shadow-mode validation at volume, token re-entry after exit, Helius webhook discovery

## Migrations

`infra/migrations/*.sql` applied in order by `infra/scripts/migrate.ts` (`npm run db:migrate`).

> pnpm is the package manager (`packageManager` field + `pnpm-workspace.yaml`). Inter-package deps use `"workspace:*"`.

## Local development

```bash
docker compose -f infra/docker/docker-compose.yml up -d   # postgres, redis, grafana, prometheus
pnpm db:migrate
pnpm exec tsx apps/trader/src/index.ts                   # paper mode
pnpm test
```
