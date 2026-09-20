# Autonomous Crypto Trading System

Solana-focused autonomous trading platform. Discovers tokens, screens security/liquidity/holders, ranks opportunities, executes with deterministic risk limits, manages positions to exit — 24/7, no manual approvals in the normal loop.

**Current state: V1 paper trading. Default mode is PAPER. Never set LIVE without reviewing [docs/architecture.md](docs/architecture.md) and the risk config.**

## Quick start

```bash
npm install

# Optional: postgres/redis/grafana stack (journaling, kill-switch persistence)
docker compose -f infra/docker/docker-compose.yml up -d
npm run db:migrate

# Run in paper mode (mock data when no API keys set)
npx tsx apps/trader/src/index.ts
```

Set API keys in `.env` (copy `.env.example`) for real market data:

| Key | Provider | Used for |
|---|---|---|
| `HELIUS_API_KEY` | Helius | Solana RPC, tx monitoring |
| `BIRDEYE_API_KEY` | Birdeye | market data, liquidity |
| `GOPLUS_API_KEY` | — (public) | token security (no key needed) |
| `MONITOR_TOKEN` | — | auth for emergency HTTP endpoints |
| `AI_ENABLED` | any OpenAI-compatible | `true` → LLM veto agent reviews ENTER signals (veto-only; failures never block trading) |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | " | endpoint, key, model — e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, local Ollama |
| `AI_COST_PER_1K_TOKENS_USD` | " | USD per 1k tokens — enables the `AI_MAX_COST_PER_DAY_USD` (default 5) cap |

Without keys the system runs on deterministic-ish mock providers — full pipeline, zero real data.

## Monitoring & emergency control

```bash
curl localhost:3000/health                          # liveness
curl localhost:3000/status | jq                     # portfolio, positions, watchlist
curl localhost:3000/metrics                         # Prometheus format

# Emergency (requires MONITOR_TOKEN):
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" localhost:3000/emergency/kill
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" localhost:3000/emergency/stop-entries
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" "localhost:3000/emergency/resume?confirm=yes"
```

Kill switch state persists across restarts when postgres is up.

## Tests

```bash
npx vitest run packages             # unit tests (offline)
npx vitest run tests/integration    # live provider tests (network required)
```

## Architecture

See [docs/architecture.md](docs/architecture.md). Key invariant: **the risk engine is the only path to execution** — strategies and AI suggest, the deterministic risk firewall decides. 14 hard gates + risk-fraction position sizing with shrinkage-based performance multipliers.

## Safety rules baked in

- Default PAPER mode; LIVE requires explicit `TRADING_MODE=LIVE`
- Security UNKNOWN + low confidence → no trade
- Missing data → no trade
- UNKNOWN transaction status → never resubmit, investigate
- Idempotent trade intents (no duplicate buys)
- Daily/weekly loss limits auto-stop entries; drawdown emergency shuts down
