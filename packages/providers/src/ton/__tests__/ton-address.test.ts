import { describe, it, expect } from "vitest";
import { rawToUserFriendly, userFriendlyToRaw, normalizeTonAddress } from "../ton-address.js";

// Live-verified pair (tonapi JettonSwap payload 2026-09-21 vs TRADER_SEED_TOKENS)
const DOGS_EQ = "EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS";
const DOGS_RAW = "0:afc49cb8786f21c87045b19ede78fc6b46c51048513f8e9a6d44060199c1bf0c";

describe("TON address conversion", () => {
  it("raw → user-friendly matches the known DOGS master", () => {
    expect(rawToUserFriendly(DOGS_RAW)).toBe(DOGS_EQ);
  });

  it("user-friendly → raw round-trips", () => {
    expect(userFriendlyToRaw(DOGS_EQ)).toBe(DOGS_RAW);
  });

  it("normalize accepts both forms and yields raw", () => {
    expect(normalizeTonAddress(DOGS_EQ)).toBe(DOGS_RAW);
    expect(normalizeTonAddress(DOGS_RAW)).toBe(DOGS_RAW);
  });

  it("throws on garbage instead of inventing an address", () => {
    expect(() => rawToUserFriendly("0:zz")).toThrow();
    expect(() => userFriendlyToRaw("not-an-address")).toThrow();
  });
});
