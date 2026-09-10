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
| `@autonomous-trader/providers` | Provider interfaces + mock implementations + health tracking |
| `@autonomous-trader/core` | State machines, risk engine, emergency controller, performance tracker |
| `@autonomous-trader/scanner` | Token lifecycle, feature engine, hard-gate filters, scoring |
| `@autonomous-trader/strategy` | Strategy interface, ensemble engine, Fresh Momentum strategy |
| `@autonomous-trader/execution` | Paper/Shadow/Live execution routers, idempotency guard |
| `@autonomous-trader/position` | Position manager, exit engine (stop/trailing/TP/time/deterioration) |
| `apps/trader` | Main autonomous decision loop entry point |

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

## Current state (2026-09-10)

- ✅ Phase 0: monorepo, types, config, logging, tests, Docker, migrations
- ✅ Phase 2 (partial): scanner pipeline, features, filters, scoring
- ✅ Phase 3 (partial): paper trading loop end-to-end verified
- 🔜 Phase 1: real Helius/Birdeye/GoPlus/Jupiter adapters, DB persistence
- 🔜 Backtesting, shadow mode validation, dashboard

## Migrations

`infra/migrations/*.sql` applied in order by `infra/scripts/migrate.ts` (`npm run db:migrate`).

## Local development

```bash
docker compose -f infra/docker/docker-compose.yml up -d   # postgres, redis, grafana, prometheus
npm run db:migrate
npx tsx apps/trader/src/index.ts                          # paper mode
npm test
```
