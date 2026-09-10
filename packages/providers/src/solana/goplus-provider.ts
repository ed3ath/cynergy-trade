/**
 * GoPlus Solana token security provider.
 * Endpoint verified against live API 2026-09-10:
 *   GET https://api.gopluslabs.io/api/v1/solana/token_security?chain=Solana&contract_addresses=<addr>
 *
 * Response fields (verified live):
 *   mintable/freezable/closable/metadata_mutable/balance_mutable_authority/
 *   transfer_fee_upgradable/transfer_hook_upgradable → { authority: string[], status: "0"|"1" }
 *   transfer_fee → { ... } | {}
 *   non_transferable, default_account_state, trusted_token → "0"|"1"
 *   holder_count, total_supply → string
 *   holders → [{ account, balance, is_locked, ... }]
 *   dex → [{ dex_name, tvl, burn_percent, ... }]
 */
import type { Chain, SecurityAssessment, SecurityReason, SecurityStatus } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { TokenSecurityProvider } from "../interfaces.js";

/** status "1" = capability exists (danger), "0" = not present */
interface AuthorityFlag {
  authority: string[];
  status: string;
}

interface GoPlusSolanaResult {
  mintable?: AuthorityFlag;
  freezable?: AuthorityFlag;
  closable?: AuthorityFlag;
  metadata_mutable?: AuthorityFlag & { metadata_upgrade_authority?: unknown };
  balance_mutable_authority?: AuthorityFlag;
  transfer_fee_upgradable?: AuthorityFlag;
  transfer_hook_upgradable?: AuthorityFlag;
  transfer_hook?: unknown[];
  transfer_fee?: Record<string, unknown>;
  non_transferable?: string;
  default_account_state?: string;
  trusted_token?: number;
  holder_count?: string;
  total_supply?: string;
  holders?: Array<{ account?: string; balance?: string; is_locked?: boolean }>;
  lp_holders?: Array<{ account?: string; is_locked?: boolean; percent?: number }>;
  dex?: Array<{ dex_name?: string; tvl?: string; burn_percent?: number | null }>;
  creators?: Array<Record<string, unknown>>;
}

export class GoPlusSecurityProvider extends AbstractProvider implements TokenSecurityProvider {
  readonly name = "goplus";
  readonly version = "1.1.0";

  private readonly baseUrl = "https://api.gopluslabs.io";

  async analyzeToken(tokenAddress: string, chain: Chain): Promise<SecurityAssessment> {
    const checkedAt = new Date();

    try {
      const result = await this.withRetry(async () => {
        const url = `${this.baseUrl}/api/v1/solana/token_security?chain=Solana&contract_addresses=${tokenAddress}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

        if (res.status === 429) throw new Error("GoPlus rate limited");
        if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`);

        const body = (await res.json()) as { code?: number; result?: Record<string, GoPlusSolanaResult> };
        if (body.code !== 1) throw new Error(`GoPlus code ${body.code}`);
        return body.result?.[tokenAddress] ?? null;
      }, { maxRetries: 2 });

      if (!result) {
        // No data ≠ safe
        return this.assessment(tokenAddress, chain, "UNKNOWN", 30, [
          { code: "NO_DATA", message: "GoPlus returned no data for token", severity: "LOW" },
        ], checkedAt, 0.3);
      }

      const reasons: SecurityReason[] = [];
      let score = 100;

      const flag = (
        condition: boolean,
        code: string,
        message: string,
        severity: SecurityReason["severity"],
        penalty: number,
      ) => {
        if (condition) {
          reasons.push({ code, message, severity });
          score -= penalty;
        }
      };

      const on = (f?: AuthorityFlag) => f?.status === "1";

      // ── Critical capabilities ───────────────────────────────────────────────
      flag(on(result.mintable), "MINTABLE", "Token authority can mint more supply", "CRITICAL", 60);
      flag(on(result.freezable), "FREEZABLE", "Token authority can freeze accounts", "CRITICAL", 60);
      flag(on(result.closable), "CLOSABLE", "Token authority can close accounts", "CRITICAL", 60);
      flag(on(result.balance_mutable_authority), "BALANCE_MUTABLE", "Authority can change token balances", "CRITICAL", 100);
      flag(result.non_transferable === "1", "NON_TRANSFERABLE", "Token cannot be transferred", "CRITICAL", 100);
      flag(result.default_account_state === "0", "ACCOUNTS_FROZEN_BY_DEFAULT", "Token accounts are frozen by default (mint authority must unfreeze)", "CRITICAL", 100);
      flag(on(result.transfer_hook_upgradable), "TRANSFER_HOOK_UPGRADABLE", "Transfer hook can be added later — tax/trap risk", "HIGH", 40);
      flag((result.transfer_hook?.length ?? 0) > 0, "TRANSFER_HOOK", "Token uses a transfer hook — custom transfer logic", "HIGH", 35);
      flag(on(result.transfer_fee_upgradable), "TRANSFER_FEE_UPGRADABLE", "Transfer fee can be raised after launch", "HIGH", 40);
      flag(on(result.metadata_mutable), "METADATA_MUTABLE", "Token metadata can be changed (rug-renom risk)", "MEDIUM", 15);

      // ── Holder concentration (if holder data present) ────────────────────────
      const totalSupply = parseFloat(result.total_supply ?? "0");
      const holders = result.holders ?? [];
      if (totalSupply > 0 && holders.length >= 10) {
        const top10Pct = holders.slice(0, 10).reduce((s, h) => s + parseFloat(h.balance ?? "0"), 0) / totalSupply * 100;
        const top10UnlockedPct = holders.slice(0, 10)
          .filter((h) => !h.is_locked)
          .reduce((s, h) => s + parseFloat(h.balance ?? "0"), 0) / totalSupply * 100;

        flag(top10Pct > 80, "TOP10_CONCENTRATED", `Top 10 holders hold ${top10Pct.toFixed(1)}% of supply`, "HIGH", 30);
        flag(top10UnlockedPct > 60, "TOP10_UNLOCKED_CONCENTRATED", `Top 10 unlocked hold ${top10UnlockedPct.toFixed(1)}% — can dump`, "HIGH", 35);
      }

      // ── Positive signals ────────────────────────────────────────────────────
      if (result.trusted_token === 1) score = Math.min(100, score + 10);
      if ((result.holder_count ?? "0") !== "0") {
        const hc = parseInt(result.holder_count ?? "0", 10);
        if (hc > 10_000) score = Math.min(100, score + 5);
      }

      const hasCritical = reasons.some((r) => r.severity === "CRITICAL");
      const hasHigh = reasons.some((r) => r.severity === "HIGH");

      const status: SecurityStatus = hasCritical ? "REJECT" : hasHigh ? "WARNING" : "SAFE";

      return this.assessment(tokenAddress, chain, status, Math.max(0, Math.min(100, score)), reasons, checkedAt, 0.9);
    } catch (err) {
      // Provider failure → UNKNOWN, never SAFE
      return this.assessment(tokenAddress, chain, "UNKNOWN", 30, [
        { code: "PROVIDER_ERROR", message: (err as Error).message, severity: "LOW" },
      ], checkedAt, 0.2);
    }
  }

  async analyzeTokens(tokenAddresses: string[], chain: Chain): Promise<SecurityAssessment[]> {
    return Promise.all(tokenAddresses.map((a) => this.analyzeToken(a, chain)));
  }

  private assessment(
    tokenAddress: string,
    chain: Chain,
    status: SecurityStatus,
    score: number,
    reasons: SecurityReason[],
    checkedAt: Date,
    confidence: number,
  ): SecurityAssessment {
    return {
      tokenAddress,
      chain,
      status,
      score,
      reasons,
      providerResults: [{ provider: this.name, status, rawData: {}, checkedAt, latencyMs: 0 }],
      checkedAt,
      dataTimestamp: checkedAt,
      ageMs: 0,
      confidence,
    };
  }
}
