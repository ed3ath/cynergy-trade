/**
 * Config chain selection — TRADING_CHAIN env wiring (single or comma list).
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

afterEach(() => {
  delete process.env["TRADING_CHAIN"];
  delete process.env["TRADER_SEED_TOKENS"];
});

describe("trading.chains config", () => {
  it("defaults to solana", () => {
    expect(loadConfig().trading.chains).toEqual(["solana"]);
  });

  it("TRADING_CHAIN=ton selects ton", () => {
    process.env["TRADING_CHAIN"] = "ton";
    expect(loadConfig().trading.chains).toEqual(["ton"]);
  });

  it("TRADING_CHAIN accepts a comma list, trims, dedupes, lowercases", () => {
    process.env["TRADING_CHAIN"] = " Solana,ton , BSC,bsc";
    expect(loadConfig().trading.chains).toEqual(["solana", "ton", "bsc"]);
  });

  it("empty entries are dropped but at least one chain is required", () => {
    process.env["TRADING_CHAIN"] = ",";
    expect(() => loadConfig()).toThrow();
  });

  it("unknown chain is rejected by zod (fail fast at boot)", () => {
    process.env["TRADING_CHAIN"] = "dogecoin";
    expect(() => loadConfig()).toThrow();
  });

  it("unknown chain in a list is rejected too", () => {
    process.env["TRADING_CHAIN"] = "solana,dogecoin";
    expect(() => loadConfig()).toThrow();
  });

  it("ton provider blocks default enabled", () => {
    process.env["TRADING_CHAIN"] = "ton";
    const cfg = loadConfig();
    expect(cfg.providers.tonapi.enabled).toBe(true);
    expect(cfg.providers.geckoterminal.enabled).toBe(true);
  });

  it("TRADER_SEED_TOKENS parses comma-separated addresses", () => {
    process.env["TRADER_SEED_TOKENS"] = " EQa , EQb ,,EQc ";
    expect(loadConfig().trading.seedTokens).toEqual(["EQa", "EQb", "EQc"]);
  });

  it("no TRADER_SEED_TOKENS → empty array", () => {
    expect(loadConfig().trading.seedTokens).toEqual([]);
  });
});
