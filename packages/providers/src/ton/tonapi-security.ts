/**
 * TON security provider — tonapi.io jetton metadata.
 * Endpoint live-verified 2026-09-16 (see verify-provider-api skill).
 * GoPlus has no TON support — this is the only security source; its failures
 * map to UNKNOWN (never SAFE), so filters reject safely.
 *
 * Mapping notes (from live data):
 *   mintable=true is NORMAL for legitimate issuers (USDT-TON is mintable) —
 *   WARNING, never REJECT.
 *   verification: "whitelist" | "blacklist" | "none"
 */
import type { Chain, SecurityAssessment, SecurityReason } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { TokenSecurityProvider } from "../interfaces.js";
import { TonApiClient } from "./tonapi-client.js";

export class TonApiSecurityProvider extends AbstractProvider implements TokenSecurityProvider {
  readonly name = "tonapi-security";
  readonly version = "1.0.0";

  constructor(private readonly client: TonApiClient = new TonApiClient()) {
    super();
  }

  async analyzeToken(tokenAddress: string, chain: Chain): Promise<SecurityAssessment> {
    const checkedAt = new Date();

    try {
      const jetton = await this.client.getJetton(tokenAddress);

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

      flag(
        jetton.admin?.is_scam === true,
        "ADMIN_SCAM", "Jetton admin address is flagged as scam by tonapi", "CRITICAL", 100,
      );
      flag(
        jetton.verification === "blacklist",
        "VERIFICATION_BLACKLIST", "Jetton is on tonapi's blacklist", "CRITICAL", 100,
      );
      flag(
        jetton.mintable === true,
        "MINTABLE", "Admin can mint more supply (normal for issuers like USDT, but supply risk)", "MEDIUM", 20,
      );
      flag(
        !jetton.metadata?.name || !jetton.metadata?.symbol,
        "METADATA_MISSING", "Jetton has no name/symbol metadata", "LOW", 10,
      );

      // Positive signal: whitelisted issuers are audited projects
      if (jetton.verification === "whitelist") score = Math.min(100, score + 5);

      const hasCritical = reasons.some((r) => r.severity === "CRITICAL");
      const status = hasCritical ? "REJECT" : reasons.length > 0 ? "WARNING" : "SAFE";

      // Whitelisted+clean is the only high-confidence SAFE; unverified tokens
      // barely clear the scanner's 0.5 confidence floor by design.
      const confidence = jetton.verification === "whitelist" ? 0.85 : 0.55;

      return this.assessment(tokenAddress, chain, status, Math.max(0, Math.min(100, score)), reasons, checkedAt, confidence);
    } catch (err) {
      // Provider failure → UNKNOWN, never SAFE
      return this.assessment(tokenAddress, chain, "UNKNOWN", 30, [
        { code: "PROVIDER_ERROR", message: (err as Error).message, severity: "LOW" },
      ], checkedAt, 0.2);
    }
  }

  async analyzeTokens(tokenAddresses: string[], chain: Chain): Promise<SecurityAssessment[]> {
    // serial on purpose — the shared client enforces 1 rps
    const out: SecurityAssessment[] = [];
    for (const a of tokenAddresses) out.push(await this.analyzeToken(a, chain));
    return out;
  }

  private assessment(
    tokenAddress: string,
    chain: Chain,
    status: SecurityAssessment["status"],
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
