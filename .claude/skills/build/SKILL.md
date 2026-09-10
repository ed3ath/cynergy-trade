---
name: build
description: Build all packages and run tests for the cynergy-trade monorepo. Use whenever compiling, typechecking, or testing any package — build order matters.
---

# Build & Test

Packages have a strict dependency chain. Building out of order fails with
`Cannot find module '@autonomous-trader/...'`. Always build in this order:

```bash
for pkg in shared providers core scanner strategy execution position; do
  npx tsc -p packages/$pkg/tsconfig.json
done
npx tsc -p apps/trader/tsconfig.json
```

If `packages/shared/src/types.ts` (or config) changed, ALL downstream packages must rebuild — their `dist/` is what imports resolve to.

## Tests

```bash
npx vitest run packages             # unit tests, offline, deterministic
npx vitest run tests/integration    # LIVE APIs (GoPlus/Jupiter/Solana RPC) — network required
npx vitest run packages/core       # single package
```

## Common failures

- `TS2375 exactOptionalPropertyTypes` — optional field assigned `undefined` directly. Assign conditionally: `if (v !== undefined) obj.field = v;`
- `TS1309 top-level await` — package needs `"type": "module"` in its package.json
- `ERR_PACKAGE_PATH_NOT_EXPORTED` — stale `dist/`; rebuild the dependency, not the importer
- npm workspaces: use `"*"` NOT `"workspace:*"` for inter-package deps
