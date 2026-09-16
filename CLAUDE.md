# cynergy-trade

Autonomous Solana/TON trading system. TS pnpm-workspaces monorepo.

- Architecture + current state: `docs/architecture.md`
- Build order + test commands: use the `build` skill (`/.claude/skills/build/`)
- Run/operate the trader: `run-trader` skill
- Before touching any provider adapter: `verify-provider-api` skill
- Risk engine (`packages/core/src/risk/`) is the firewall around money — changes there require deterministic unit tests
- Provider failures/missing data must map to UNKNOWN, never SAFE
- `TRADING_MODE=LIVE` is forbidden until Redis-backed idempotency + real wallet signing exist (see `ponytail:` comments)
