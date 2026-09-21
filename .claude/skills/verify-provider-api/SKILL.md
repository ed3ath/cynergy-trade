---
name: verify-provider-api
description: Verify an external API's real schema against the live endpoint before writing an adapter. Use before implementing or modifying any provider in packages/providers.
---

# Verify Provider API

Never implement an adapter from memory, tutorials, or search-result summaries.
Provider APIs drift. Two stale fields cost an hour of debugging; one wrong
security flag costs money.

## Procedure

1. **Probe the live endpoint** with a known-good asset before writing any TS:

```bash
cat > /tmp/probe.mts << 'EOF'
const res = await fetch("https://<endpoint>?<params>", { headers: {...} });
console.log("status:", res.status);
const body = await res.json();
// Print top-level keys, then each nested object's keys — not the whole body
EOF
pnpm exec tsx /tmp/probe.mts
```

Use a major established token (BONK `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`,
USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) as a known-good case, and a
garbage address (`1111...`) as a known-bad case.

2. **Map the real schema** — write the adapter's interface against the dumped
   keys, not what docs claim. Web-searched schema summaries have been wrong
   for both GoPlus and Birdeye in this project.

3. **Decide failure semantics** — provider error or empty result must map to
   `UNKNOWN` status with low confidence, never `SAFE`. No data ≠ safe.

4. **Add a live integration test** in `tests/integration/` (see
   `providers.live.test.ts` for the `describe.skipIf(networkAvailable)` pattern).

## Verified 2026-09-10

- GoPlus Solana: `GET api.gopluslabs.io/api/v1/solana/token_security?chain=Solana&contract_addresses=<addr>` — public, no key. Flags are `{authority[], status:"0"|"1"}` objects.
- Jupiter: `GET lite-api.jup.ag/swap/v1/quote` (+`POST /swap/v1/swap`), free tier no key.
- Birdeye: `public-api.birdeye.so/defi/*`, `X-API-KEY` + `X-CHAIN: solana` headers.
- Solana RPC: standard JSON-RPC, any endpoint.

## TON (`TRADING_CHAIN=ton`)

Verified endpoints (TonAPI holders/security, STON.fi quotes, GeckoTerminal hot
pools/discovery): see `tests/integration/ton.live.test.ts` + `ston-quote.live.test.ts`
for known-good addresses and params, and `packages/providers/src/ton/` for the
verified shapes. TON addresses are NOT draggable from Solana intuition — always
probe with the jetton masters used in those tests.
