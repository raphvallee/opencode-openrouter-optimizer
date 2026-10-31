/**
 * Cost model, transcribed from the user's spec so downstream code stays honest:
 *
 *   inputRate  = pricing.prompt        * (1 - d)
 *   outputRate = pricing.completion    * (1 - d)
 *   readRate   = (input_cache_read     ?? prompt) * (1 - d)
 *   writeRate  = (input_cache_write    ?? 0)      * (1 - d)
 *
 *   perRequest = T_in * (h * readRate + (1 - h) * (inputRate + writeRate)) + T_out * outputRate
 *   total      = perRequest * numRequests
 */

/** Prices are strings like "0.0000001", USD per token, base rate before discount. */
export interface EndpointPricing {
  prompt: string | number
  completion: string | number
  input_cache_read?: string | number | null
  input_cache_write?: string | number | null
  discount?: number | string | null
}

export interface Rates {
  inputRate: number
  outputRate: number
  readRate: number
  writeRate: number
  /** The discount factor that was applied (0 when the endpoint has no discount). */
  discount: number
}

/**
 * Strict parse for required price fields (prompt, completion). Returns null when the
 * value is absent, empty, or not a finite non-negative number ("", "N/A", -1, ...):
 * an endpoint with unknown pricing must never be counted as free or priced at 0.
 */
function parseRequiredPrice(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = typeof value === "number" ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Lenient parse for optional fields: missing or unparseable counts as 0. */
function parseOptionalPrice(value: string | number | null | undefined): number {
  return parseRequiredPrice(value) ?? 0
}

/**
 * True when prompt and completion parse to real, non-negative prices. False when
 * either is missing or unparseable: rankProviders blacklists such endpoints instead
 * of guessing their cost, so a corrupted price string can never pass for "free".
 */
export function hasKnownPricing(pricing: EndpointPricing): boolean {
  return parseRequiredPrice(pricing.prompt) !== null && parseRequiredPrice(pricing.completion) !== null
}

/**
 * Strictly free endpoint: zero base price on input and output, and zero cache
 * read/write prices. The cache prices matter because the cost model bills
 * uncached write tokens: an endpoint with a cache-write price would produce a
 * positive perRequestCost even with $0 prompt/completion, contradicting the
 * "free" classification used by the ranker.
 */
export function isFreePricing(pricing: EndpointPricing): boolean {
  return (
    parseRequiredPrice(pricing.prompt) === 0 &&
    parseRequiredPrice(pricing.completion) === 0 &&
    parseOptionalPrice(pricing.input_cache_read ?? pricing.prompt) === 0 &&
    parseOptionalPrice(pricing.input_cache_write) === 0
  )
}

export function effectiveRates(pricing: EndpointPricing): Rates {
  const rawDiscount = parseOptionalPrice(pricing.discount)
  // Discounts theoretically live in [0, 1]; anything outside is treated as no discount.
  const discount = rawDiscount > 0 && rawDiscount <= 1 ? rawDiscount : 0
  const scale = 1 - discount
  return {
    // Unparseable required prices yield 0 here, but such endpoints are blacklisted
    // by rankProviders (hasKnownPricing) before these rates ever reach a ranking.
    inputRate: (parseRequiredPrice(pricing.prompt) ?? 0) * scale,
    outputRate: (parseRequiredPrice(pricing.completion) ?? 0) * scale,
    readRate: parseOptionalPrice(pricing.input_cache_read ?? pricing.prompt) * scale,
    writeRate: parseOptionalPrice(pricing.input_cache_write) * scale,
    discount,
  }
}

export interface RequestProfile {
  /** Average total input tokens per request (cached + uncached). */
  avgInput: number
  /** Average output tokens per request (completion + reasoning). */
  avgOutput: number
  /** Cache hit rate in [0, 1]. */
  cacheHitRate: number
  /** Number of requests the profile was computed over. */
  numRequests: number
}

export function perRequestCost(rates: Rates, profile: RequestProfile): number {
  const h = Math.min(1, Math.max(0, profile.cacheHitRate))
  const input =
    profile.avgInput * (h * rates.readRate + (1 - h) * (rates.inputRate + rates.writeRate))
  const output = profile.avgOutput * rates.outputRate
  return input + output
}

export function totalCost(perRequest: number, numRequests: number): number {
  return perRequest * numRequests
}

export function requestCost(pricing: EndpointPricing, profile: RequestProfile): { perRequest: number; rates: Rates } {
  const rates = effectiveRates(pricing)
  return { perRequest: perRequestCost(rates, profile), rates }
}
