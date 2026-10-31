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

function parsePrice(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0
  const parsed = typeof value === "number" ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * Strictly free endpoint: zero base price on both input and output.
 * Cache/read/write prices do not matter when both required fields are free.
 */
export function isFreePricing(pricing: EndpointPricing): boolean {
  return parsePrice(pricing.prompt) === 0 && parsePrice(pricing.completion) === 0
}

export function effectiveRates(pricing: EndpointPricing): Rates {
  const rawDiscount = parsePrice(pricing.discount ?? 0)
  // Discounts theoretically live in [0, 1]; anything weird is treated as no discount.
  const discount = rawDiscount > 0 && rawDiscount < 1 ? rawDiscount : 0
  const scale = 1 - discount
  return {
    inputRate: parsePrice(pricing.prompt) * scale,
    outputRate: parsePrice(pricing.completion) * scale,
    readRate: parsePrice(pricing.input_cache_read ?? pricing.prompt) * scale,
    writeRate: parsePrice(pricing.input_cache_write ?? 0) * scale,
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
