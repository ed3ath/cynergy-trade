/**
 * Provider factory — builds the production provider registry from config.
 * Real providers when API keys present; mocks otherwise.
 *
 * Discovery source: Helius webhooks in production (Phase 1+); mock stream in dev.
 * ponytail: implement Helius webhook receiver when deploying to a host
 */
import type { Chain, ProvidersConfig } from "@autonomous-trader/shared";
import type { ProviderRegistry } from "./interfaces.js";
import {
  MockDiscoveryProvider,
  MockSecurityProvider,
  MockHolderAnalyticsProvider,
  MockSwapQuoteProvider,
  MockTradeExecutionProvider,
  MockTransactionMonitoringProvider,
  MockChainDataProvider,
} from "./mock-providers.js";
import { JupiterQuoteProvider } from "./solana/jupiter-provider.js";
import { JupiterExecutionProvider } from "./solana/jupiter-execution.js";
import { GoPlusSecurityProvider } from "./solana/goplus-provider.js";
import { BirdeyeMarketProvider } from "./solana/birdeye-provider.js";
import { CompositeSecurityProvider } from "./solana/composite-security.js";
import { SolanaRpcProvider } from "./solana/solana-rpc-provider.js";
import { RaydiumDiscoveryProvider } from "./solana/raydium-discovery.js";
import { BirdeyeHolderProvider } from "./solana/birdeye-holder.js";
import { DexScreenerProvider } from "./solana/dexscreener-provider.js";
import { TonApiClient } from "./ton/tonapi-client.js";
import { TonApiSecurityProvider } from "./ton/tonapi-security.js";
import { TonApiHoldersProvider } from "./ton/tonapi-holders.js";
import { GeckoTerminalDiscoveryProvider } from "./ton/geckoterminal-discovery.js";
import { StonQuoteProvider } from "./ton/ston-quote.js";
import { EVM_CHAINS, EvmChain, evmSkipBaseIds, isEvmChain } from "./evm/chains.js";
import { GoPlusEvmHoldersProvider, GoPlusEvmSecurityProvider } from "./evm/goplus-evm.js";

/**
 * GT poll budget: every GT-discovery chain shares one per-IP rate limit. 1/min
 * per chain held with ≤4 chains (2026-09-23 fix) but N chains firing 1/min
 * re-triggers the chronic 429 spiral — scale the interval up as chains are
 * added. 4 chains → today's 60s/240s; 12 → 180s/720s.
 */
function gtPollIntervals(): { pollIntervalMs: number; hotPoolsIntervalMs: number } {
  const chains = (process.env["TRADING_CHAIN"] ?? "solana")
    .split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
  const gtChains = chains.filter((c) => c === "ton" || isEvmChain(c as Chain)).length;
  const pollIntervalMs = Math.max(60_000, gtChains * 15_000);
  return { pollIntervalMs, hotPoolsIntervalMs: pollIntervalMs * 4 };
}

export function createProviderRegistry(config: ProvidersConfig, activeChain: Chain = "solana"): ProviderRegistry {
  if (activeChain === "ton") return createTonRegistry(config);
  if (isEvmChain(activeChain)) return createEvmRegistry(config, activeChain);
  const heliusKey = config.helius.apiKey;
  const birdeyeKey = config.birdeye.apiKey;
  const goplusEnabled = config.goplus.enabled;
  // Discovery needs real RPC; public RPC polling only when explicitly opted in (rate limits)
  const publicDiscovery = process.env["ENABLE_PUBLIC_DISCOVERY"] === "true";

  // ── Chain data: real RPC when Helius key present ───────────────────────────
  const chain = heliusKey
    ? new SolanaRpcProvider(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`)
    : new MockChainDataProvider();

  // ── Market + liquidity: Birdeye when key present, else DexScreener (free, real) ──
  const birdeye = birdeyeKey && config.birdeye.enabled ? new BirdeyeMarketProvider(birdeyeKey) : null;
  const dexscreener = new DexScreenerProvider();

  const market = birdeye ?? dexscreener;
  const liquidity = birdeye ?? dexscreener;

  // ── Security: composite GoPlus + Birdeye when available ────────────────────
  const securityProviders = [goplusEnabled ? new GoPlusSecurityProvider() : null].filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );
  const security = securityProviders.length > 0
    ? new CompositeSecurityProvider(securityProviders)
    : new MockSecurityProvider();

  // ── Quotes + execution: Jupiter ─────────────────────────────────────────────
  const jupiterKey = config.jupiter.apiKey;
  const jupRpc = chain instanceof SolanaRpcProvider ? chain : new MockChainDataProvider();

  const quote = config.jupiter.enabled
    ? new JupiterQuoteProvider(jupiterKey)
    : new MockSwapQuoteProvider();

  const execution = config.jupiter.enabled && chain instanceof SolanaRpcProvider
    ? new JupiterExecutionProvider(jupRpc as SolanaRpcProvider, jupiterKey)
    : new MockTradeExecutionProvider();

  const monitoring = chain instanceof SolanaRpcProvider ? chain : new MockTransactionMonitoringProvider();

  // ── Discovery: Raydium polling when real RPC available ─────────────────────
  let discoveryRpc: SolanaRpcProvider | null = null;
  if (chain instanceof SolanaRpcProvider) {
    discoveryRpc = chain;
  } else if (publicDiscovery) {
    discoveryRpc = new SolanaRpcProvider("https://api.mainnet-beta.solana.com");
  }

  let discovery;
  if (discoveryRpc instanceof SolanaRpcProvider) {
    discovery = new RaydiumDiscoveryProvider(discoveryRpc, {
      // paid RPC polls faster; public RPC must stay gentle
      pollIntervalMs: heliusKey ? 10_000 : 30_000,
    });
  } else {
    discovery = new MockDiscoveryProvider();
  }

  // ── Holders: Birdeye when key present (unverified shape — gated) ──────────
  const holders = birdeyeKey && config.birdeye.enabled
    ? new BirdeyeHolderProvider(birdeyeKey)
    : new MockHolderAnalyticsProvider();

  return {
    discovery,
    marketData: market,
    liquidity,
    security,
    holders,
    chain,
    quote,
    execution,
    monitoring,
  };
}

/**
 * TON registry — PAPER + SHADOW modes (LIVE boot-guarded: no wallet/signing).
 * All free, no-key APIs:
 *   discovery: GeckoTerminal new pools · market/liquidity: DexScreener ton pairs
 *   security: tonapi (GoPlus has no TON) · holders: tonapi
 *   quotes: STON.fi v1 swap/simulate (SHADOW mode)
 * Execution/monitoring stay mock — no TON tx path exists.
 */
function createTonRegistry(config: ProvidersConfig): ProviderRegistry {
  const tonapi = new TonApiClient(
    config.tonapi.baseUrl ?? undefined,
  );
  const dexscreener = new DexScreenerProvider("https://api.dexscreener.com", 5_000, "ton");

  return {
    discovery: config.geckoterminal.enabled
      ? new GeckoTerminalDiscoveryProvider("https://api.geckoterminal.com", gtPollIntervals())
      : new MockDiscoveryProvider("ton"),
    marketData: dexscreener,
    liquidity: dexscreener,
    security: config.tonapi.enabled
      ? new TonApiSecurityProvider(tonapi)
      : new MockSecurityProvider(),
    holders: config.tonapi.enabled
      ? new TonApiHoldersProvider(tonapi)
      : new MockHolderAnalyticsProvider(),
    chain: new MockChainDataProvider(),
    quote: config.tonapi.enabled
      ? new StonQuoteProvider(tonapi)
      : new MockSwapQuoteProvider(),
    execution: new MockTradeExecutionProvider(),
    monitoring: new MockTransactionMonitoringProvider(),
    tonApiClient: tonapi, // shared queue — copy-trade wallet polling uses this
  };
}

/**
 * EVM registry (bsc/base/polygon/arbitrum) — PAPER only (boot-guarded in the
 * trader: no EVM quote aggregator or signing path exists yet). All free,
 * no-key APIs:
 *   discovery: GeckoTerminal new pools · market/liquidity: DexScreener pairs
 *   security + holders: GoPlus EVM (same endpoint, two views)
 * GT rate budget: every chain adds 1/min + 0.25/min to the shared per-IP limit.
 * ponytail: wire a 0x/1inch quote provider for SHADOW, viem signing for LIVE.
 */
function createEvmRegistry(config: ProvidersConfig, chain: EvmChain): ProviderRegistry {
  const meta = EVM_CHAINS[chain];
  const dexscreener = new DexScreenerProvider("https://api.dexscreener.com", 5_000, chain);
  const goplus = config.goplus.enabled;

  return {
    discovery: config.geckoterminal.enabled
      ? new GeckoTerminalDiscoveryProvider("https://api.geckoterminal.com", {
        network: meta.network,
        chain,
        skipBaseTokenIds: evmSkipBaseIds(meta),
        ...gtPollIntervals(),
      })
      : new MockDiscoveryProvider(chain),
    marketData: dexscreener,
    liquidity: dexscreener,
    security: goplus
      ? new GoPlusEvmSecurityProvider(meta.goPlusChainId)
      : new MockSecurityProvider(),
    holders: goplus
      ? new GoPlusEvmHoldersProvider(meta.goPlusChainId)
      : new MockHolderAnalyticsProvider(),
    chain: new MockChainDataProvider(),
    quote: new MockSwapQuoteProvider(),
    execution: new MockTradeExecutionProvider(),
    monitoring: new MockTransactionMonitoringProvider(),
  };
}
