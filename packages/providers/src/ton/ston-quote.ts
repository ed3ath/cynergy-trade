/**
 * STON.fi swap-quote provider (TON) — real quotes for SHADOW mode, no tx.
 *
 * Endpoint live-verified 2026-09-20 (see verify-provider-api skill):
 *   POST https://api.ston.fi/v1/swap/simulate?<query params>
 *     params: offer_address, ask_address, units, slippage_tolerance (decimal)
 *   NOTE the paradox: params go in the QUERY STRING on a POST — a JSON body is
 *   rejected with "missing field" errors.
 *   200 → { offer_units, ask_units, min_ask_units, price_impact (decimal str),
 *           swap_rate, pool_address, gas_params{gas_budget,forward_gas,
 *           estimated_gas_consumption}, ... }
 *   400 → text error ("invalid jetton address", missing pool) → ProviderError.
 *
 * Jetton decimals come from tonapi metadata (cached per boot; native TON = 9,
 * USDT = 6 hardcoded). They only feed expectedPrice (USD) and unit conversion.
 *
 * ponytail: STON-only — DeDust pools are invisible to this router; a DeDust
 * quote source doubles coverage when SHADOW validation needs it.
 */
import { ProviderError } from "@autonomous-trader/shared";
import type { QuoteResult } from "@autonomous-trader/shared";
import type { SwapQuoteProvider, SwapQuoteRequest } from "../interfaces.js";
import { AbstractProvider } from "../abstract-provider.js";
import type { TonApiClient } from "./tonapi-client.js";

const TON_NATIVE = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
export const USDT_TON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

interface StonSimulateResponse {
  offer_units?: string;
  ask_units?: string;
  min_ask_units?: string;
  price_impact?: string;
  pool_address?: string;
  gas_params?: { gas_budget?: string };
  [key: string]: unknown;
}

export class StonQuoteProvider extends AbstractProvider implements SwapQuoteProvider {
  readonly name = "stonfi-quote";
  readonly version = "1.0.0";

  private readonly decimalsCache = new Map<string, number>();

  constructor(
    private readonly tonapi: TonApiClient,
    private readonly baseUrl = "https://api.ston.fi",
  ) {
    super();
  }

  async getQuote(request: SwapQuoteRequest): Promise<QuoteResult> {
    const params = new URLSearchParams({
      offer_address: request.inputMint,
      ask_address: request.outputMint,
      units: request.amount.toString(),
      slippage_tolerance: (request.slippageBps / 10_000).toFixed(4),
    });

    const res = await fetch(`${this.baseUrl}/v1/swap/simulate?${params}`, {
      method: "POST",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new ProviderError(`STON simulate HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, this.name);
    }
    const raw = (await res.json()) as StonSimulateResponse;
    if (!raw.offer_units || !raw.ask_units) {
      throw new ProviderError("STON simulate missing amounts", this.name);
    }

    const inputAmount = BigInt(raw.offer_units);
    const outputAmount = BigInt(raw.ask_units);
    const [inD, outD] = await Promise.all([
      this.decimals(request.inputMint),
      this.decimals(request.outputMint),
    ]);

    // expectedPrice = USD price of the non-base side, so it is directly
    // comparable with scanner/position prices (which are USD).
    let expectedPrice: number;
    if (request.inputMint === USDT_TON) {
      expectedPrice = Number(inputAmount) / 1e6 / (Number(outputAmount) / 10 ** outD);
    } else if (request.outputMint === USDT_TON) {
      expectedPrice = Number(outputAmount) / 1e6 / (Number(inputAmount) / 10 ** inD);
    } else {
      expectedPrice = (Number(outputAmount) / 10 ** outD) / (Number(inputAmount) / 10 ** inD); // output per input, human units
    }

    const minAsk = raw.min_ask_units ? Number(raw.min_ask_units) : Number(raw.ask_units);
    return {
      provider: this.name,
      inputToken: request.inputMint,
      outputToken: request.outputMint,
      inputAmount,
      outputAmount,
      expectedPrice,
      priceImpactBps: raw.price_impact ? Math.round(parseFloat(raw.price_impact) * 10_000) : 0,
      slippageBps: Math.round((1 - minAsk / Number(raw.ask_units)) * 10_000),
      routeSteps: raw.pool_address ? [raw.pool_address] : [],
      validUntil: new Date(Date.now() + 15_000),
      // nanoTON gas budget; consumers treating it as lamports of SOL are off
      // by the TON/SOL price ratio — acceptable for SHADOW calibration
      estimatedFeeLamports: BigInt(raw.gas_params?.gas_budget ?? "0"),
      rawQuote: raw,
    };
  }

  /** Smallest-unit exponent of a TON asset — tonapi metadata, cached. */
  async decimals(address: string): Promise<number> {
    const cached = this.decimalsCache.get(address);
    if (cached !== undefined) return cached;
    const d = address === TON_NATIVE ? 9
      : address === USDT_TON ? 6
      : await this.tonapi.getJetton(address)
          .then((j) => parseInt(j.metadata?.decimals ?? "9", 10))
          .catch(() => 9); // unknown → TON convention
    this.decimalsCache.set(address, d);
    return d;
  }
}
