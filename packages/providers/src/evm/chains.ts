/**
 * EVM chain metadata — one adapter family, parameterized per network.
 *
 * GT network slugs and DexScreener chainIds coincide for these chains except
 * avalanche (GT "avax"); GoPlus uses numeric EVM chain ids. Wrapped-native/
 * stable addresses are the discovery skip list and the regime price source
 * (they track the chain's gas coin 1:1). All addresses below live-verified
 * 2026-09-24 against GeckoTerminal pools + DexScreener token endpoints.
 *
 * ponytail: add a chain = one entry here + one chain_type value (migration) +
 * one Chain union member. ethereum included despite gas cost — EVM is
 * PAPER-only (boot-guarded), so no gas is ever paid; revisit before any
 * EVM LIVE path exists.
 */
import type { Chain } from "@autonomous-trader/shared";

export type EvmChain =
  | "bsc" | "base" | "polygon" | "arbitrum"
  | "ethereum" | "avalanche" | "optimism" | "linea" | "mantle" | "blast" | "zksync" | "scroll";

export interface EvmChainMeta {
  /** GeckoTerminal network slug + DexScreener chainId. */
  network: string;
  /** GoPlus EVM path-param chain id (verified: /api/v1/token_security/{id}). */
  goPlusChainId: number;
  /** Wrapped native ERC20 — tracks the gas coin, never a trade target. */
  wrappedNative: string;
  /** Major stables on this chain — dominate volume, nothing to trade. */
  stables: string[];
}

export const EVM_CHAINS: Record<EvmChain, EvmChainMeta> = {
  bsc: {
    network: "bsc",
    goPlusChainId: 56,
    wrappedNative: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
    stables: [
      "0x55d398326f99059ff775485246999027b3197955", // BSC-USD
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    ],
  },
  base: {
    network: "base",
    goPlusChainId: 8453,
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH
    stables: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], // native USDC
  },
  polygon: {
    network: "polygon",
    goPlusChainId: 137,
    wrappedNative: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WPOL
    stables: [
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // native USDC
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC.e
    ],
  },
  arbitrum: {
    network: "arbitrum",
    goPlusChainId: 42161,
    wrappedNative: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
    stables: [
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // native USDC
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
    ],
  },
  ethereum: {
    network: "eth", // GT slug; DexScreener chainId is "ethereum"
    goPlusChainId: 1,
    wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    stables: [
      "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    ],
  },
  avalanche: {
    network: "avax", // GT slug
    goPlusChainId: 43114,
    wrappedNative: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
    stables: ["0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"], // native USDC
  },
  optimism: {
    network: "optimism",
    goPlusChainId: 10,
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH
    stables: [
      "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // native USDC
      "0x7f5c764cbc14f9669b83743f54254264a5b1c327", // USDC.e
    ],
  },
  linea: {
    network: "linea",
    goPlusChainId: 59144,
    wrappedNative: "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", // WETH
    stables: ["0x176211869ca2b568f2a7d4ee941e073a821ee1ff"], // USDC
  },
  mantle: {
    network: "mantle",
    goPlusChainId: 4581,
    wrappedNative: "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8", // WMNT
    stables: [
      "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT0
      "0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111", // WETH (ETH wrapper, 2nd by volume)
    ],
  },
  blast: {
    network: "blast",
    goPlusChainId: 81457,
    wrappedNative: "0x4300000000000000000000000000000000000004", // WETH
    stables: ["0x4300000000000000000000000000000000000003"], // USDB
  },
  zksync: {
    network: "zksync",
    goPlusChainId: 324,
    wrappedNative: "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91", // WETH
    stables: ["0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4"], // USDC.e
  },
  scroll: {
    network: "scroll",
    goPlusChainId: 534352,
    wrappedNative: "0x5300000000000000000000000000000000000004", // WETH
    stables: ["0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4"], // USDC
  },
};

export function isEvmChain(chain: Chain): chain is EvmChain {
  return chain in EVM_CHAINS;
}

/** GT base-token ids ("<network>_<addr>") to never emit as discoveries.
 *  GT lowercases addresses in token ids — match that exactly. */
export function evmSkipBaseIds(meta: EvmChainMeta): string[] {
  return [meta.wrappedNative, ...meta.stables]
    .map((addr) => `${meta.network}_${addr.toLowerCase()}`);
}
