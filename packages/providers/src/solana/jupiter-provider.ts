/**
 * Jupiter swap quote provider.
 * Endpoint verified 2026-09: GET https://lite-api.jup.ag/swap/v1/quote
 * Free tier = lite-api (rate-limited); paid = api.jup.ag with x-api-key.
 */
import type { QuoteResult } from "@autonomous-trader/shared";
import { ProviderError } from "@autonomous-trader/shared";
import { AbstractProvider } from "../abstract-provider.js";
import type { SwapQuoteProvider, SwapQuoteRequest } from "../interfaces.js";

export class JupiterQuoteProvider extends AbstractProvider implements SwapQuoteProvider {
  readonly name = "jupiter";
  readonly version = "1.0.0";

  constructor(
    private readonly apiKey?: string,
    private readonly baseUrl = "https://lite-api.jup.ag",
  ) {
    super();
  }

  private url(path: string): string {
    const base = this.apiKey ? "https://api.jup.ag" : this.baseUrl;
    return `${base}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  async getQuote(request: SwapQuoteRequest): Promise<QuoteResult> {
    const params = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount.toString(),
      slippageBps: String(request.slippageBps),
      restrictIntermediateTokens: "true",
    });

    return this.withRetry(async () => {
      const res = await fetch(this.url(`/swap/v1/quote?${params}`), {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 429) throw new ProviderError("Jupiter rate limited", this.name);
      if (!res.ok) {
        throw new ProviderError(`Jupiter quote HTTP ${res.status}: ${await res.text()}`, this.name);
      }

      const raw = (await res.json()) as JupiterQuoteResponse;

      if (!raw.inAmount || !raw.outAmount) {
        throw new ProviderError("Jupiter quote missing amounts", this.name);
      }

      const inAmt = BigInt(raw.inAmount);
      const outAmt = BigInt(raw.outAmount);
      // Price of output token in input token units (raw)
      const expectedPrice = inAmt > 0n ? Number(outAmt) / Number(inAmt) : 0;
      const priceImpactBps = raw.priceImpactPct ? parseFloat(raw.priceImpactPct) * 10_000 : 0;

      return {
        provider: this.name,
        inputToken: request.inputMint,
        outputToken: request.outputMint,
        inputAmount: inAmt,
        outputAmount: outAmt,
        expectedPrice,
        priceImpactBps,
        slippageBps: request.slippageBps,
        routeSteps: raw.routePlan?.map((s) => s.swapInfo?.label ?? s.swapInfo?.ammKey ?? "unknown") ?? [],
        validUntil: new Date(Date.now() + 15_000), // quotes are short-lived
        estimatedFeeLamports: 5_000n,
        rawQuote: raw,
      };
    }, { maxRetries: 2, timeoutMs: 10_000 });
  }
}

interface JupiterQuoteResponse {
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string;
  routePlan?: Array<{ swapInfo?: { label?: string; ammKey?: string } }>;
  [key: string]: unknown;
}
