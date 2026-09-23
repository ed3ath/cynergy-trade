# cynergy-trade

Autonomous multi-chain trading system (`TRADING_CHAIN` = comma list of `solana|ton|bsc|base|polygon|arbitrum` — chains trade simultaneously, one scanner/equity book each). TS pnpm-workspaces monorepo.

- Architecture + current state: `docs/architecture.md` · roadmap: `docs/roadmap.md` · ops: `docs/deployment.md`
- Build order + test commands: use the `build` skill
- Run/operate the trader: `run-trader` skill
- Before touching any provider adapter: `verify-provider-api` skill
- Changing strategies/scanner filters/exits/sizing: `trading-techniques` skill
- Risk engine (`packages/core/src/risk/`) is the firewall around money — changes there require deterministic unit tests (`pnpm exec vitest run packages/core`)
- Provider failures/missing data must map to UNKNOWN, never SAFE
- `TRADING_MODE=LIVE` only after the Phase-6 checklist in `docs/deployment.md`. Enforced in code: Solana LIVE refuses to boot without a healthy Redis idempotency guard; TON LIVE is refused outright (no signing path); EVM chains (bsc/base/polygon/arbitrum) are PAPER-only — no quote aggregator or signing path yet
- Risk limits are per-chain books (capital splits evenly across `TRADING_CHAIN`); cross-chain aggregate exposure is not gated — see the ponytail in `apps/trader/src/index.ts`
- All env lives in the root `.env` — no per-app env files. `SERVER_PORT` must match the watchdog's `MONITOR_PORT` (default 3000)

## Coding standards

- Strict TS with `exactOptionalPropertyTypes` — never assign `undefined` to an optional field; assign conditionally
- ESM: packages/apps need `"type": "module"` (top-level await is used)
- Inter-package deps must be `"workspace:*"` — bare `*` hits the registry and fails
- Deliberate simplifications get a `ponytail:` comment naming the ceiling and the upgrade path
- Strategies are pure functions over `StrategyContext` — fetch data upstream, no I/O inside
- AI agent is optional — `AI_AUTONOMY` = `off` | `veto` (default, second opinion on strategy candidates) | `auto` (autonomous trader: `apps/trader/src/ai-trader-agent.ts` issues ENTER/EXIT/TIGHTEN actions). In `auto` the AI trader is the **sole entry decision maker**: the strategy ensemble only advises (its per-token views ride along on snapshot candidates as `strategyViews`; its signals still shadow-track), nothing enters deterministically and the veto agent has nothing to gate — so a dead gateway in `auto` means no new entries until it recovers (exits keep running). Every entry still goes through the same risk engine + journal as strategies (AI never sets absolute size — its confidence only feeds the sizing multiplier), and AI can only tighten exits, never widen them (`PositionManager.tightenExits` one-way ratchet; hard-stop/security/liquidity emergency tier is computed from live inputs and is never AI-touchable). Its failures/timeouts/cost caps must never block or gate the deterministic loop. Both agents share one daily `AI_MAX_COST_PER_DAY_USD` budget (`apps/trader/src/ai-budget.ts`)
- Copy-trade (`COPYTRADE_ENABLED`, TON-only, needs AI on): tracked-wallet BUYs (`COPYTRADE_WALLETS`, TonAPI feed) are veto-agent reviewed (`veto`) or AI-traded (`auto`) under `copytrade-scalp`/`copytrade-shortterm` profiles — multiple positions per token allowed (`Position` slots key by strategyId; aggregate per-token exposure still capped by the risk engine). Wallet feed runs in **observe mode** whenever `COPYTRADE_WALLETS` is set (no `COPYTRADE_ENABLED`/AI needed): every tracked-wallet swap is recorded to `logs/copytrade-trades.jsonl`, the Activity feed, and the dashboard Traders tab (`GET /copytrade`) — records without trading
