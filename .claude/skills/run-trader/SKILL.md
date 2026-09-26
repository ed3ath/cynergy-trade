---
name: run-trader
description: Boot the autonomous trader, verify the decision loop is working, and operate emergency controls. Use when running, smoke-testing, or stopping the system.
---

# Run Trader

## Boot

```bash
pnpm exec tsx apps/trader/src/index.ts              # paper mode, mock providers
```

Env (from root `.env` — the only env file; the daemon loads it too): `TRADING_MODE`
(PAPER|SHADOW|LIVE, default PAPER), `TRADING_CHAIN` (comma list of solana|ton|bsc|base|
polygon|arbitrum — chains trade simultaneously, capital splits evenly; EVM chains are
PAPER-only), `HELIUS_API_KEY`,
`BIRDEYE_API_KEY` (real data when set), `AI_ENABLED` (LLM veto agent, optional),
`MONITOR_TOKEN` (required for emergency POSTs), `SERVER_PORT` (default 3000 — must
match the watchdog's `MONITOR_PORT`).

No database configured → journal falls back to NullJournal with a warning. Expected, not a failure.
(SQLite by default: `data/trader.db`, self-migrated at boot; `DATABASE_URL=postgresql://…`
switches dialect — `infra/migrations` vs `infra/migrations-sqlite`.)

## Production boot (24/7, this machine)

Scheduled task `CynergyTraderWatchdog` launches `node scripts/trader-daemon.mjs`
(via `scripts/run-hidden.vbs` — node cannot hide its own console window) at
logon and every 2 min as a backstop. The daemon loads `.env`, starts the trader
when port 3000 is down, restarts it on exit; logs append to `logs/trader.log`.

```powershell
Start-ScheduledTask CynergyTraderWatchdog    # boot now
Get-ScheduledTaskInfo CynergyTraderWatchdog  # check last result
```

Kill the trader by port, not by name (other node processes may be unrelated):
`Get-NetTCPConnection -LocalPort 3000 -State Listen | % { Stop-Process $_.OwningProcess -Force }`.

**After editing any `packages/*` source:** rebuild (see the `build` skill) before
restarting — the daemon runs `node dist/index.js` and loads packages from their
`dist/`, so unrebuilt edits silently do nothing. Restart = kill by port, daemon
respawns within 15s with fresh dist.

## Verify healthy boot

```bash
curl -s localhost:3000/health       # {"status":"ok",...}
curl -s localhost:3000/status | python3 -m json.tool
curl -s localhost:3000/metrics
```

Dashboard UI: `http://localhost:3000/` (portfolio, equity chart, positions,
activity feed via SSE).

Decision cycle runs every 10s. Within ~40s (mock discovery emits every 30s) expect log lines:
`Candidate watchlisted` → `Trade entered` (paper, risk-reduced size ~0.3-0.5% of portfolio).

## Emergency controls

```bash
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" localhost:3000/emergency/kill         # halt everything
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" localhost:3000/emergency/stop-entries # keep managing exits
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" "localhost:3000/emergency/resume?confirm=yes"
```

Without `MONITOR_TOKEN` set, POSTs are refused (fail-safe). Kill switch persists
across restarts when the database is up (SQLite default, postgres when DATABASE_URL says so).

## NEVER

- Do not set `TRADING_MODE=LIVE` casually — follow the LIVE checklist in `docs/deployment.md` first.
- Do not resubmit a transaction with UNKNOWN status — investigate the signature first.
