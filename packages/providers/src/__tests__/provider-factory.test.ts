/**
 * Factory chain selection — TON registry slots vs default Solana registry.
 */
import { describe, expect, it } from "vitest";
import { ProvidersConfigSchema } from "@autonomous-trader/shared";
import { createProviderRegistry } from "../provider-factory.js";
import { JupiterQuoteProvider } from "../solana/jupiter-provider.js";
import { CompositeSecurityProvider } from "../solana/composite-security.js";

const cfg = ProvidersConfigSchema.parse({});

describe("createProviderRegistry chain selection", () => {
  it("chain=ton → free no-key TON providers, STON quotes, mock execution", () => {
    const r = createProviderRegistry(cfg, "ton");

    expect(r.discovery.name).toBe("geckoterminal-discovery");
    expect(r.marketData.name).toBe("dexscreener");
    expect(r.liquidity.name).toBe("dexscreener");
    expect(r.security.name).toBe("tonapi-security");
    expect(r.holders.name).toBe("tonapi-holders");
    expect(r.quote.name).toBe("stonfi-quote");
    expect(r.execution.name).toMatch(/^mock/);
    expect(r.monitoring.name).toMatch(/^mock/);
  });

  it("chain=ton with tonapi disabled → mock security/holders/quote (UNKNOWN-safe)", () => {
    const r = createProviderRegistry(ProvidersConfigSchema.parse({ tonapi: { enabled: false } }), "ton");
    expect(r.security.name).toMatch(/^mock/);
    expect(r.holders.name).toMatch(/^mock/);
    expect(r.quote.name).toMatch(/^mock/); // STON quotes need tonapi decimals
  });

  it("default chain=solana → registry unchanged", () => {
    const r = createProviderRegistry(cfg);

    expect(r.discovery.name).toBe("mock-discovery"); // no Helius key, no public discovery
    expect(r.security).toBeInstanceOf(CompositeSecurityProvider); // goplus default enabled
    expect(r.quote).toBeInstanceOf(JupiterQuoteProvider);
    expect(r.holders.name).toMatch(/^mock/); // no birdeye key
  });
});
