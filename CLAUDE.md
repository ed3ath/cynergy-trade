# cynergy-trade

Autonomous Solana/TON trading system (`TRADING_CHAIN=solana|ton`). TS pnpm-workspaces monorepo.

- Architecture + current state: `docs/architecture.md` · roadmap: `docs/roadmap.md` · ops: `docs/deployment.md`
- Build order + test commands: use the `build` skill
- Run/operate the trader: `run-trader` skill
- Before touching any provider adapter: `verify-provider-api` skill
- Changing strategies/scanner filters/exits/sizing: `trading-techniques` skill
- Risk engine (`packages/core/src/risk/`) is the firewall around money — changes there require deterministic unit tests (`pnpm exec vitest run packages/core`)
- Provider failures/missing data must map to UNKNOWN, never SAFE
- `TRADING_MODE=LIVE` only after the Phase-6 checklist in `docs/deployment.md`. Enforced in code: Solana LIVE refuses to boot without a healthy Redis idempotency guard; TON LIVE is refused outright (no signing path)
- All env lives in the root `.env` — no per-app env files. `SERVER_PORT` must match the watchdog's `MONITOR_PORT` (default 3000)

## Coding standards

- Strict TS with `exactOptionalPropertyTypes` — never assign `undefined` to an optional field; assign conditionally
- ESM: packages/apps need `"type": "module"` (top-level await is used)
- Inter-package deps must be `"workspace:*"` — bare `*` hits the registry and fails
- Deliberate simplifications get a `ponytail:` comment naming the ceiling and the upgrade path
- Strategies are pure functions over `StrategyContext` — fetch data upstream, no I/O inside
- AI agent (`apps/trader/src/ai-agent.ts`) is veto-only and optional — its failures/cost caps must never block or gate trading decisions
