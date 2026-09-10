/**
 * Composite security provider — queries multiple providers, reconciles results.
 * Rule: the MOST SEVERE status wins. Disagreement lowers confidence.
 * Provider failure → that provider's result is UNKNOWN.
 */
import type { Chain, SecurityAssessment, SecurityStatus } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { TokenSecurityProvider } from "../interfaces.js";

const STATUS_SEVERITY: Record<SecurityStatus, number> = {
  SAFE: 0, WARNING: 1, UNKNOWN: 2, REJECT: 3,
};

export class CompositeSecurityProvider extends AbstractProvider implements TokenSecurityProvider {
  readonly name = "composite-security";
  readonly version = "1.0.0";

  constructor(private readonly providers: TokenSecurityProvider[]) {
    super();
    if (providers.length === 0) throw new Error("CompositeSecurityProvider requires at least one provider");
  }

  async analyzeToken(tokenAddress: string, chain: Chain): Promise<SecurityAssessment> {
    const results = await Promise.allSettled(
      this.providers.map((p) => p.analyzeToken(tokenAddress, chain)),
    );

    const assessments: SecurityAssessment[] = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : unknownAssessment(tokenAddress, chain, this.providers[i]!.name, (r.reason as Error)?.message),
    );

    // Worst status wins
    let worst: SecurityAssessment = assessments[0]!;
    for (const a of assessments) {
      if (STATUS_SEVERITY[a.status] > STATUS_SEVERITY[worst.status]) worst = a;
    }

    // Merge reasons (dedupe by code)
    const reasonMap = new Map<string, SecurityAssessment["reasons"][number]>();
    for (const a of assessments) {
      for (const r of a.reasons) reasonMap.set(r.code, r);
    }

    // Confidence: average of providers, reduced by disagreement
    const statuses = new Set(assessments.map((a) => a.status));
    const avgConfidence = assessments.reduce((s, a) => s + a.confidence, 0) / assessments.length;
    const disagreementPenalty = statuses.size > 1 ? 0.15 : 0;

    // Score: min of provider scores (conservative)
    const minScore = Math.min(...assessments.map((a) => a.score));

    const checkedAt = new Date();
    return {
      tokenAddress,
      chain,
      status: worst.status,
      score: minScore,
      reasons: [...reasonMap.values()],
      providerResults: assessments.flatMap((a) => a.providerResults),
      checkedAt,
      dataTimestamp: checkedAt,
      ageMs: 0,
      confidence: Math.max(0, avgConfidence - disagreementPenalty),
    };
  }

  async analyzeTokens(tokenAddresses: string[], chain: Chain): Promise<SecurityAssessment[]> {
    return Promise.all(tokenAddresses.map((a) => this.analyzeToken(a, chain)));
  }
}

function unknownAssessment(
  tokenAddress: string,
  chain: Chain,
  provider: string,
  error: string,
): SecurityAssessment {
  const now = new Date();
  return {
    tokenAddress,
    chain,
    status: "UNKNOWN",
    score: 30,
    reasons: [{ code: "PROVIDER_FAILED", message: `${provider}: ${error}`, severity: "LOW" }],
    providerResults: [{ provider, status: "UNKNOWN", rawData: null, checkedAt: now, latencyMs: 0 }],
    checkedAt: now,
    dataTimestamp: now,
    ageMs: 0,
    confidence: 0.2,
  };
}
