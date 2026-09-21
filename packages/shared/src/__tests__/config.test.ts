/**
 * Config chain selection — TRADING_CHAIN env wiring (single or comma list) —
 * and AI autonomy env wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

afterEach(() => {
  delete process.env["TRADING_CHAIN"];
  delete process.env["TRADER_SEED_TOKENS"];
  delete process.env["AI_AUTONOMY"];
  delete process.env["AI_CYCLE_SEC"];
  delete process.env["AI_MAX_ACTIONS_PER_CYCLE"];
  delete process.env["AI_MAX_OPEN_POSITIONS"];
  delete process.env["AI_TOKEN_COOLDOWN_SEC"];
  delete process.env["AI_LIVE_ENABLED"];
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

describe("AI autonomy config", () => {
  it("defaults to veto autonomy with sane caps", () => {
    const cfg = loadConfig();
    expect(cfg.ai.autonomy).toBe("veto");
    expect(cfg.ai.cycleSec).toBe(60);
    expect(cfg.ai.maxActionsPerCycle).toBe(3);
    expect(cfg.ai.maxOpenPositions).toBe(3);
    expect(cfg.ai.tokenCooldownSec).toBe(600);
    expect(cfg.ai.liveEnabled).toBe(true);
  });

  it("parses the autonomy env overrides", () => {
    process.env["AI_AUTONOMY"] = "auto";
    process.env["AI_CYCLE_SEC"] = "120";
    process.env["AI_MAX_ACTIONS_PER_CYCLE"] = "5";
    process.env["AI_MAX_OPEN_POSITIONS"] = "10";
    process.env["AI_TOKEN_COOLDOWN_SEC"] = "60";
    process.env["AI_LIVE_ENABLED"] = "false";
    const cfg = loadConfig();
    expect(cfg.ai.autonomy).toBe("auto");
    expect(cfg.ai.cycleSec).toBe(120);
    expect(cfg.ai.maxActionsPerCycle).toBe(5);
    expect(cfg.ai.maxOpenPositions).toBe(10);
    expect(cfg.ai.tokenCooldownSec).toBe(60);
    expect(cfg.ai.liveEnabled).toBe(false);
  });

  it("rejects an invalid autonomy value (fail loud, not silent fallback)", () => {
    process.env["AI_AUTONOMY"] = "yolo";
    expect(() => loadConfig()).toThrow();
  });
});
