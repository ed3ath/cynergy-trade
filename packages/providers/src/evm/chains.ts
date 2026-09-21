/**
 * EVM chain metadata — one adapter family, parameterized per network.
 *
 * GT network slugs and DexScreener chainIds happen to coincide for these
 * chains ("bsc", "base", "polygon", "arbitrum"); GoPlus uses numeric EVM
 * chain ids. Wrapped-native/stable addresses are the discovery skip list and
 * the regime price source (they track the chain's gas coin 1:1).
 *
 * ponytail: add a chain = one entry here + one chain_type value (migration) +
 * one Chain union member. eth excluded on purpose — gas is not cheap.
 */
import type { Chain } from "@autonomous-trader/shared";

export type EvmChain = "bsc" | "base" | "polygon" | "arbitrum";

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
