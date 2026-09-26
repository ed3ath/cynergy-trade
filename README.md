# cynergy-trade

Autonomous Solana/TON trading system. Discovers tokens, screens security/liquidity/holders, ranks opportunities, executes with deterministic risk limits, manages positions to exit — 24/7, no manual approvals in the normal loop.

**Current state: paper trading (phases 0–3). Default mode is PAPER. Never set `TRADING_MODE=LIVE` without the checklist in [docs/deployment.md](docs/deployment.md) — live trading is additionally gated on Redis-backed idempotency + real wallet signing.**

## Requirements

- Node ≥ 22
- pnpm (`corepack enable`)
- Docker (optional — postgres/redis/grafana stack)

## Setup

```bash
corepack enable
pnpm install

cp .env.example .env          # then edit keys (see table below)

# Optional infra: postgres, redis, grafana, prometheus
docker compose -f infra/docker/docker-compose.yml up -d
pnpm db:migrate
```

Journal defaults to SQLite (`data/trader.db`, auto-created and self-migrated — no
postgres needed). `DATABASE_URL=postgresql://…` switches to Postgres; an unreachable
database → NullJournal fallback with a warning. Expected, not a failure.

## Run

```bash
# Paper mode, one process, foreground (mock providers when no API keys set)
pnpm exec tsx apps/trader/src/index.ts

# Dev watch — port 3001, stays off port 3000 which the watchdog daemon owns
pnpm --filter @autonomous-trader/trader dev
```

Decision loop ticks every 10s. Within ~40s of boot expect log lines `Candidate watchlisted` → `Trade entered` (paper).

**24/7 on Windows (this machine):** scheduled task `CynergyTraderWatchdog` launches `scripts/trader-daemon.mjs` at logon + every 2 min; the daemon loads `.env`, starts the trader when port 3000 is down, restarts it on crash. Logs append to `logs/trader.log`.

```powershell
Start-ScheduledTask CynergyTraderWatchdog     # boot now
Get-ScheduledTaskInfo CynergyTraderWatchdog   # check last result

# stop the trader by port (other node processes may be unrelated):
Get-NetTCPConnection -LocalPort 3000 -State Listen | % { Stop-Process $_.OwningProcess -Force }
```

**Linux VPS:** see [docs/deployment.md](docs/deployment.md) — one `docker compose -f infra/docker/docker-compose.prod.yml up -d --build`, self-migrating, self-restarting.

## Configuration (`.env`)

| Key | Purpose |
|---|---|
| `TRADING_MODE` | `PAPER` (default) \| `SHADOW` (real quotes, no tx) \| `LIVE` |
| `TRADING_CHAIN` | comma list: `solana` (default), `ton`, `bsc`, `base`, `polygon`, `arbitrum` — e.g. `solana,ton,bsc` trades all three simultaneously (capital splits evenly; EVM chains are PAPER-only) |
| `HELIUS_API_KEY` | Solana RPC, tx monitoring, stream discovery |
| `BIRDEYE_API_KEY` | Market data, liquidity (TON chain: TonAPI + GeckoTerminal, keyless) |
| `GOPLUS_API_KEY` | Token security (works keyless) |
| `AI_ENABLED` | `true` → LLM veto agent reviews ENTER signals (veto-only; agent failures never block trading) |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Any OpenAI-compatible endpoint — e.g. `https://api.openai.com/v1`, OpenRouter, local Ollama |
| `AI_TOOLS` | `false` disables the agent's read-only data tools (for endpoints without function-calling) |
| `AI_COST_PER_1K_TOKENS_USD` | USD per 1k tokens — enables the `AI_MAX_COST_PER_DAY_USD` cap (default 5) |
| `WALLET_PUBLIC_KEY` / `WALLET_PRIVATE_KEY` | Wallet (LIVE only) |
| `MONITOR_TOKEN` | Bearer auth for emergency POSTs — without it they're refused (fail-safe) |
| `SERVER_PORT` | Monitor port, default 3000 |
| `MAX_DAILY_LOSS_USD`, `MAX_DRAWDOWN_PCT`, `MAX_POSITION_VALUE_USD`, `MAX_CONCURRENT_POSITIONS`, `MAX_TOTAL_EXPOSURE_USD`, `MIN_LIQUIDITY_USD` | Risk limits |
| `TRADER_SEED_TOKENS` | Comma-separated tokens injected into the scanner (pipeline testing) |

Full list: `.env.example` / `.env.production.example`. All env lives in the root `.env` (loaded by both the trader and the watchdog daemon); there are no per-app env files. `SERVER_PORT` must match the daemon's `MONITOR_PORT` (default 3000) — stop the watchdog before running a dev instance on another port.

Without API keys the system runs on mock providers — full pipeline, zero real data.

## Monitor & emergency control

Dashboard at `http://localhost:3000/`. JSON endpoints: `/health`, `/status` (portfolio, positions, watchlist), `/metrics` (Prometheus), `/market`, `/history`, `/trades`, `/report`, `/events`.

```bash
# Emergency (requires MONITOR_TOKEN):
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" localhost:3000/emergency/kill          # halt everything
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" localhost:3000/emergency/stop-entries  # keep managing exits
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" "localhost:3000/emergency/resume?confirm=yes"
```

Kill-switch state persists across restarts when the database is up (SQLite by default).

## Tests

```bash
pnpm test                          # unit tests per package (offline)
npx vitest run tests/integration   # live provider tests (network + keys required)
```

## Layout

| Path | Purpose |
|---|---|
| `apps/trader` | Decision loop, HTTP monitor + dashboard, emergency controls, alerter, daily reports |
| `packages/*` | shared, providers, core (incl. risk engine), scanner, strategy (Fresh Momentum, Micro Scalp), execution, position, backtest |
| `infra/` | Docker compose, migrations, ops scripts |
| `scripts/` | `trader-daemon.mjs` watchdog, `run-hidden.vbs` launcher |
| `docs/` | [architecture](docs/architecture.md) · [roadmap](docs/roadmap.md) · [deployment](docs/deployment.md) · [trading techniques](docs/trading-techniques.md) |

## Safety rules baked in

- Default PAPER mode; LIVE requires explicit `TRADING_MODE=LIVE`
- Security UNKNOWN + low confidence → no trade; missing data → no trade
- UNKNOWN transaction status → never resubmit, investigate the signature
- Idempotent trade intents (no duplicate buys)
- Daily/weekly loss limits auto-stop entries; drawdown emergency shuts down
- The risk engine (`packages/core/src/risk/`) is the only path to execution — strategies suggest, the deterministic firewall decides
