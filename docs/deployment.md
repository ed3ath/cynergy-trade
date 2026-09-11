# Deployment

Target: a Linux VPS (2 vCPU / 4 GB is plenty), Docker + compose plugin installed.

## One-time setup

```bash
git clone <repo> && cd cynergy-trade
cp .env.production.example .env
# edit .env: set TRADING_MODE, HELIUS_API_KEY, MONITOR_TOKEN, POSTGRES_PASSWORD
docker compose -f infra/docker/docker-compose.prod.yml up -d --build
docker logs -f trader
```

That's it. The trader:
- waits for postgres/redis health, self-migrates the schema at boot
- starts in PAPER (or SHADOW) mode, 24/7 decision loop every 10s
- restarts itself on crash (`restart: unless-stopped`) — kill switch and
  emergency state persist in postgres across restarts
- restores open positions from the journal on boot

## Monitoring

```bash
curl localhost:3000/health                                   # liveness
curl localhost:3000/status | jq '.portfolio, .regime'         # state
curl localhost:3000/report | jq                               # daily report
```

Alerts arrive via Telegram when `ALERT_TELEGRAM_*` is set (kill switch, loss
limits, emergency exits, monitor failures — never routine trades).

Prometheus/Grafana: `docker compose -f infra/docker/docker-compose.prod.yml --profile obs up -d`

## Emergency

```bash
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" localhost:3000/emergency/kill
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" "localhost:3000/emergency/resume?confirm=yes"
```

Full stop: `docker compose -f infra/docker/docker-compose.prod.yml stop trader`.

## Going LIVE (Phase 6) — checklist, in order

1. Paper/shadow ran ≥ 2 weeks with real keys, no unexplained behavior
2. Telegram alerts verified working (kill-switch test in paper)
3. `WALLET_PRIVATE_KEY` set — a NEW limited wallet funded with micro-capital only
4. `TRADING_MODE=LIVE` + redeploy
5. Watch first entries closely; `docker logs -f trader` + /status

Never promote to LIVE because backtests look good alone (spec §45).
