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

export function createProviderRegistry(config: ProvidersConfig, activeChain: Chain = "solana"): ProviderRegistry {
  if (activeChain === "ton") return createTonRegistry(config);
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
 * TON registry — PAPER mode only. All free, no-key APIs:
 *   discovery: GeckoTerminal new pools · market/liquidity: DexScreener ton pairs
 *   security: tonapi (GoPlus has no TON) · holders: tonapi
 * Quote/execution stay mock — paper router is fully synthetic, TON SHADOW
 * quote providers (STON.fi/DeDust simulate) are deferred until paper shows edge.
 */
function createTonRegistry(config: ProvidersConfig): ProviderRegistry {
  const tonapi = new TonApiClient(
    config.tonapi.baseUrl ?? undefined,
  );
  const dexscreener = new DexScreenerProvider("https://api.dexscreener.com", 5_000, "ton");

  return {
    discovery: config.geckoterminal.enabled
      ? new GeckoTerminalDiscoveryProvider()
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
    quote: new MockSwapQuoteProvider(),
    execution: new MockTradeExecutionProvider(),
    monitoring: new MockTransactionMonitoringProvider(),
  };
}
