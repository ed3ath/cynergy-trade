/**
 * Provider factory — builds the production provider registry from config.
 * Real providers when API keys present; mocks otherwise.
 *
 * Discovery source: Helius webhooks in production (Phase 1+); mock stream in dev.
 * ponytail: implement Helius webhook receiver when deploying to a host
 */
import type { ProvidersConfig } from "@autonomous-trader/shared";
import type { ProviderRegistry } from "./interfaces.js";
import {
  MockDiscoveryProvider,
  MockMarketDataProvider,
  MockLiquidityProvider,
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

export function createProviderRegistry(config: ProvidersConfig): ProviderRegistry {
  const heliusKey = config.helius.apiKey;
  const birdeyeKey = config.birdeye.apiKey;
  const goplusEnabled = config.goplus.enabled;

  // ── Chain data: real RPC when Helius key present ───────────────────────────
  const chain = heliusKey
    ? new SolanaRpcProvider(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`)
    : new MockChainDataProvider();

  // ── Market + liquidity: Birdeye when key present ───────────────────────────
  const birdeye = birdeyeKey && config.birdeye.enabled ? new BirdeyeMarketProvider(birdeyeKey) : null;

  const market = birdeye ?? new MockMarketDataProvider();
  const liquidity = birdeye ?? new MockLiquidityProvider();

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

  return {
    discovery: new MockDiscoveryProvider(), // ponytail: Helius webhook discovery
    marketData: market,
    liquidity,
    security,
    holders: new MockHolderAnalyticsProvider(), // ponytail: Birdeye holder profiles
    chain,
    quote,
    execution,
    monitoring,
  };
}
