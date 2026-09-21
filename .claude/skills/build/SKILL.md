---
name: build
description: Build all packages and run tests for the cynergy-trade monorepo. Use whenever compiling, typechecking, or testing any package — build order matters.
---

# Build & Test

Packages have a strict dependency chain. Building out of order fails with
`Cannot find module '@autonomous-trader/...'`. Always build in this order:

```bash
for pkg in shared providers core scanner strategy execution position; do
  pnpm exec tsc -p packages/$pkg/tsconfig.json
done
pnpm exec tsc -p apps/trader/tsconfig.json
```

If `packages/shared/src/types.ts` (or config) changed, ALL downstream packages must rebuild — their `dist/` is what imports resolve to. The running daemon executes `apps/trader/dist` — after rebuilding, restart the trader (see `run-trader` skill) or the old code keeps running.

## Tests

```bash
CI=true pnpm exec vitest run packages     # unit tests, offline, deterministic
CI=true pnpm exec vitest run apps         # trader app tests (ai-agent, alerter, pnl-windows)
pnpm exec vitest run tests/integration    # LIVE APIs (GoPlus/Jupiter/Solana RPC/TON) — network required
pnpm exec vitest run packages/core       # single package
```

`CI=true` matters in non-TTY shells — vitest's interactive reporter garbles output otherwise.

## Common failures

- `TS2375 exactOptionalPropertyTypes` — optional field assigned `undefined` directly. Assign conditionally: `if (v !== undefined) obj.field = v;`
- `TS1309 top-level await` — package needs `"type": "module"` in its package.json
- `ERR_PACKAGE_PATH_NOT_EXPORTED` — stale `dist/`; rebuild the dependency, not the importer
- pnpm workspaces: inter-package deps MUST use `"workspace:*"` — bare `"*"` hits the registry and fails (packages are private)
