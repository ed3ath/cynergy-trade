# Architecture

## Overview

Autonomous crypto trading system targeting newly-launched Solana tokens.
TypeScript monorepo, modular packages, deterministic risk firewall around all capital deployment.

```
DISCOVERY → SCANNER → STRATEGY ENSEMBLE → RISK ENGINE → EXECUTION → POSITION MGMT → PERFORMANCE
```

## Package layout

| Package | Purpose |
|---|---|
| `@autonomous-trader/shared` | Domain types, config (zod-validated), structured logger, ID generators |
| `@autonomous-trader/providers` | Provider interfaces + mock and live implementations (GoPlus, Jupiter, Birdeye, SolanaRPC, Raydium discovery), health tracking |
| `@autonomous-trader/core` | State machines, risk engine, emergency controller, performance tracker, regime detector, Postgres journal |
| `@autonomous-trader/scanner` | Token lifecycle, feature engine, hard-gate filters, scoring |
| `@autonomous-trader/strategy` | Strategy interface, ensemble engine, Fresh Momentum strategy |
| `@autonomous-trader/execution` | Paper/Shadow/Live execution routers, durable idempotency guard, wallet signing |
| `@autonomous-trader/position` | Position manager, exit engine (stop/trailing/TP/time/deterioration) |
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
- ✅ Ops: HTTP monitor (`/health /status /metrics /report`, bearer-auth emergency controls), `docker-compose.prod.yml` (self-migrating boot), ShadowTracker (ENTER decisions evaluated at 15min horizon → `shadow_decisions`)
- ✅ Durable idempotency (Postgres `executed_intents` + fallback), wallet signing (`WALLET_PRIVATE_KEY` → VersionedTransaction)
- 🔜 Phase 4: backtester (blocked on accumulated snapshot data — run paper mode 24/7 first)
- 🔜 Shadow-mode validation at volume, dashboard UI (currently JSON endpoints), token re-entry after exit, Helius webhook discovery

## Migrations

`infra/migrations/*.sql` applied in order by `infra/scripts/migrate.ts` (`npm run db:migrate`).

> pnpm is the package manager (`packageManager` field + `pnpm-workspace.yaml`). Inter-package deps use `"workspace:*"`.

## Local development

```bash
docker compose -f infra/docker/docker-compose.yml up -d   # postgres, redis, grafana, prometheus
npm run db:migrate
pnpm exec tsx apps/trader/src/index.ts                   # paper mode
pnpm test
```
