import { describe, it, expect } from "vitest";
import {
  loadWalletFromEnv,
  parseSecretKey,
  createTestWallet,
  verifyEd25519,
  WalletConfigError,
} from "../wallet.js";
import {
  Keypair,
  TransactionMessage,
  SystemProgram,
  VersionedTransaction,
  PublicKey,
  Connection,
} from "@solana/web3.js";

describe("parseSecretKey", () => {
  it("accepts JSON byte array format", () => {
    const kp = Keypair.generate();
    const json = JSON.stringify(Array.from(kp.secretKey));
    expect(Array.from(parseSecretKey(json))).toEqual(Array.from(kp.secretKey));
  });

  it("accepts base58 format", () => {
    const kp = Keypair.generate();
    const b58 = bs58Encode(kp.secretKey);
    expect(Array.from(parseSecretKey(b58))).toEqual(Array.from(kp.secretKey));
  });

  it("rejects garbage", () => {
    expect(() => parseSecretKey("not-a-key!!")).toThrow();
    expect(() => parseSecretKey("[1,2,3]")).toThrow(WalletConfigError);
  });
});

describe("loadWalletFromEnv", () => {
  it("returns null when unset", () => {
    expect(loadWalletFromEnv({})).toBeNull();
  });

  it("loads wallet, public key matches secret", () => {
    const kp = Keypair.generate();
    const wallet = loadWalletFromEnv({ WALLET_PRIVATE_KEY: bs58Encode(kp.secretKey) });
    expect(wallet).not.toBeNull();
    expect(wallet!.publicKey).toBe(kp.publicKey.toBase58());
  });
});

describe("signTransaction", () => {
  it("signs a real versioned transaction with a valid ed25519 signature", async () => {
    const wallet = createTestWallet();
    const payer = new PublicKey(wallet.publicKey);
    const recipient = Keypair.generate().publicKey;

    // real tx: transfer 1 lamport
    const ix = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: 1,
    });
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: Keypair.generate().publicKey.toBase58(), // any valid-looking hash
      instructions: [ix],
    }).compileToV0Message();

    const unsigned = new VersionedTransaction(message);
    const serialized = unsigned.serialize();

    const signedBytes = await wallet.signTransaction(serialized);
    const signed = VersionedTransaction.deserialize(signedBytes);

    // signature slot now filled and cryptographically valid over the message
    const sig = signed.signatures[0];
    expect(sig).not.toBeNull();
    expect(
      verifyEd25519(wallet.publicKey, signed.message.serialize(), sig! as Uint8Array),
    ).toBe(true);
  });
});

// minimal bs58 encode for fixtures (avoid extra dev-dep)
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n = n / 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

// keep Connection import referenced (shared error paths) without connecting
void Connection;
