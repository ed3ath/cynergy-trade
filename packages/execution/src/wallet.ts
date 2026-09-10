/**
 * Trading wallet — loads keypair from env, signs Jupiter swap transactions.
 *
 * Secret handling (spec §34):
 *   - key material comes ONLY from WALLET_PRIVATE_KEY env (base58 secret key,
 *     the standard Phantom export format, or JSON byte array like solana-keygen)
 *   - never logged (logger redacts `privateKey`; toString also masked)
 *   - treasury never exposed — this is the LIMITED trading wallet
 *
 * Signing uses @solana/web3.js v1 VersionedTransaction — the battle-tested
 * wire-format path. @solana/kit (installed) covers new protocol code; kit has
 * no public wire→transaction deserializer for externally-built transactions,
 * which is exactly what Jupiter returns.
 */
import {
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";

export interface TradingWallet {
  publicKey: string; // base58
  signTransaction: (serializedTx: Uint8Array) => Promise<Uint8Array>;
}

export class WalletConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletConfigError";
  }
}

/** Parse WALLET_PRIVATE_KEY: base58 string (Phantom) or JSON byte array (solana-keygen). */
export function parseSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    const bytes = JSON.parse(trimmed) as number[];
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((b) => b < 0 || b > 255)) {
      throw new WalletConfigError("WALLET_PRIVATE_KEY JSON array must be 64 bytes");
    }
    return new Uint8Array(bytes);
  }

  // base58 → bytes; throws on invalid base58 or wrong length inside fromSecretKey
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(bs58.decode(trimmed));
  } catch {
    throw new WalletConfigError("WALLET_PRIVATE_KEY is not valid base58");
  }
  return Keypair.fromSecretKey(bytes).secretKey;
}

/**
 * Build a TradingWallet from env. Returns null when WALLET_PRIVATE_KEY unset
 * (paper/shadow modes need no wallet).
 */
export function loadWalletFromEnv(env: NodeJS.ProcessEnv = process.env): TradingWallet | null {
  const raw = env["WALLET_PRIVATE_KEY"];
  if (!raw) return null;

  const secretKey = parseSecretKey(raw);
  const keypair = Keypair.fromSecretKey(secretKey);

  return {
    publicKey: keypair.publicKey.toBase58(),
    signTransaction: async (serializedTx: Uint8Array): Promise<Uint8Array> => {
      const tx = VersionedTransaction.deserialize(serializedTx);
      tx.sign([keypair]); // throws if tx is malformed or already fully signed by us
      return tx.serialize();
    },
  };
}

/** For tests: generate a burner wallet without touching env. */
export function createTestWallet(): TradingWallet {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    signTransaction: async (serializedTx: Uint8Array): Promise<Uint8Array> => {
      const tx = VersionedTransaction.deserialize(serializedTx);
      tx.sign([keypair]);
      return tx.serialize();
    },
  };
}

/** Ed25519 signature check via node:crypto (no extra dep). Test helper. */
export function verifyEd25519(
  publicKeyBase58: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  // raw 32-byte ed25519 pub → SPKI DER (12-byte prefix + key)
  const spki = new Uint8Array(44);
  spki.set([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00], 0);
  spki.set(bs58.decode(publicKeyBase58), 12);
  const pub = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  return verify(null, Buffer.from(message), pub, Buffer.from(signature));
}

import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
