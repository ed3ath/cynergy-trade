---
name: trading-techniques
description: Crypto trading technique reference — strategy families, signals, screening gates, position sizing, exits, execution, validation. Use when implementing or changing anything in packages/strategy, packages/scanner filters, packages/position exits, or risk/sizing parameters.
---

# Trading Techniques

`docs/trading-techniques.md` is the catalog — strategy families, indicator
formulas, screening checklist, sizing schemes, exit hierarchy, execution
tactics, validation metrics, adversarial memecoin patterns. Read the relevant
section before designing; this file only holds the rules the catalog can't.

## Hard rules when implementing a technique

1. **Strategy = pure function.** `evaluate(ctx: StrategyContext): StrategyDecision`, no I/O, deterministic for same inputs. Fetch data upstream, not inside.
2. **New strategy file** goes in `packages/strategy/src/strategies/`, export from the package index, register in the ensemble. It competes with existing strategies via performance multipliers — it doesn't replace them.
3. **Every entry signal needs volume or holder-velocity confirmation.** Price-only signals on fresh tokens are bait (§2 of the doc).
4. **Missing data ⇒ UNKNOWN ⇒ no trade.** A provider failure is not a filter pass.
5. **Risk engine changes** (`packages/core/src/risk/`) require deterministic unit tests — that package is the firewall around money. Run `pnpm exec vitest run packages/core`.
6. **New screening gate**: cheapest checks first (save API quota), reject-fast, UNKNOWN never passes.
7. **New exit type**: slot it into the existing priority hierarchy in `packages/position`; journal its reason so PnL attribution per exit type works.
8. **Validate before trust**: new techniques run in PAPER, then must clear SHADOW (ShadowTracker 15-min expectancy > 0) before any LIVE discussion. LIVE stays off — CLAUDE.md gate.
9. Check regime fit first (`MarketRegime` in ctx): momentum families need TREND/HighVol, reversion families need RANGE + an anchor (days of history). A technique outside its regime is not a bug to fix, it's a filter to add.

## Skipped on purpose

Block-zero sniping, leverage/perps, socials-driven strategies — see §11 of the doc for why. Don't add them without rewriting that section first.
