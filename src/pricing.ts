/**
 * Cost model, transcribed from the user's spec so downstream code stays honest:
 *
 *   inputRate  = pricing.prompt        * (1 - d)
 *   outputRate = pricing.completion    * (1 - d)
 *   readRate   = (parsed input_cache_read ?? prompt) * (1 - d)
 *   writeRate  = (parsed input_cache_write ?? 0)    * (1 - d)
 *
 * A cache-read price that is absent or unparseable means "no cache": those tokens are
 * billed at the prompt rate. A cache-write price that is present but unparseable is
 * unknown pricing (hasKnownPricing returns false) and rankProviders blacklists it.
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

type ParsedPrice =
  | { kind: "absent" }
  | { kind: "known"; value: number }
  | { kind: "invalid" }

/**
 * Parse a price without guessing. "absent" means the field was omitted; "invalid" means
 * it was present but is not a finite non-negative number ("", "N/A", "free", -1, ...).
 * The distinction matters for cache fields: an absent cache price means "not offered",
 * while an invalid one is unknown pricing that must not be silently treated as $0.
 */
function parsePrice(value: string | number | null | undefined): ParsedPrice {
  if (value === null || value === undefined) return { kind: "absent" }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? { kind: "known", value } : { kind: "invalid" }
  }
  if (typeof value !== "string") return { kind: "invalid" }
  const trimmed = value.trim()
  if (trimmed === "") return { kind: "invalid" }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? { kind: "known", value: parsed } : { kind: "invalid" }
}

/** Required price: absent or invalid is unknown (null). */
function parseRequiredPrice(value: string | number | null | undefined): number | null {
  const parsed = parsePrice(value)
  return parsed.kind === "known" ? parsed.value : null
}

/** Optional discount: absent or invalid is treated as no discount. */
function parseDiscount(value: string | number | null | undefined): number {
  const parsed = parsePrice(value)
  return parsed.kind === "known" ? parsed.value : 0
}

/**
 * True when prompt and completion parse to real, non-negative prices and any
 * cache-write price is either absent or parseable. An unparseable cache-write price is
 * unknown pricing: rankProviders blacklists the endpoint instead of billing the cache
 * write as $0. An unparseable cache-read price is allowed: the cost model treats it as
 * "no cache" and bills those tokens at the input price.
 */
export function hasKnownPricing(pricing: EndpointPricing): boolean {
  return (
    parsePrice(pricing.prompt).kind === "known" &&
    parsePrice(pricing.completion).kind === "known" &&
    parsePrice(pricing.input_cache_write).kind !== "invalid"
  )
}

/**
 * Strictly free endpoint: zero base price on input and output, and no positive cache
 * read/write price. An absent or unparseable cache-read price falls back to the input
 * price (so it is free only when the input price is also zero). An unparseable
 * cache-write price is unknown pricing and is never classified as free.
 */
export function isFreePricing(pricing: EndpointPricing): boolean {
  const prompt = parsePrice(pricing.prompt)
  const completion = parsePrice(pricing.completion)
  if (prompt.kind !== "known" || completion.kind !== "known") return false
  if (prompt.value !== 0 || completion.value !== 0) return false
  const read = parsePrice(pricing.input_cache_read)
  const readRate = read.kind === "known" ? read.value : prompt.value
  if (readRate !== 0) return false
  const write = parsePrice(pricing.input_cache_write)
  if (write.kind === "invalid") return false
  if (write.kind === "known" && write.value !== 0) return false
  return true
}

export function effectiveRates(pricing: EndpointPricing): Rates {
  const rawDiscount = parseDiscount(pricing.discount)
  // Discounts theoretically live in [0, 1]; anything outside is treated as no discount.
  const discount = rawDiscount > 0 && rawDiscount <= 1 ? rawDiscount : 0
  const scale = 1 - discount
  const inputRate = (parseRequiredPrice(pricing.prompt) ?? 0) * scale
  const read = parsePrice(pricing.input_cache_read)
  // No cache read price means "no cache": cached input is billed at the input rate.
  const readRate = (read.kind === "known" ? read.value : (parseRequiredPrice(pricing.prompt) ?? 0)) * scale
  const write = parsePrice(pricing.input_cache_write)
  // An absent cache-write price is 0. Invalid values are unknown pricing and are
  // filtered by rankProviders via hasKnownPricing before a ranking is computed.
  const writeRate = (write.kind === "known" ? write.value : 0) * scale
  return {
    inputRate,
    outputRate: (parseRequiredPrice(pricing.completion) ?? 0) * scale,
    readRate,
    writeRate,
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
  // Loud guard: rankProviders filters with hasKnownPricing first, so reaching this with
  // unknown pricing means a caller bypassed the blacklist. Failing here is safer than
  // silently pricing an unknown cache write as $0.
  if (!hasKnownPricing(pricing)) {
    throw new Error("requestCost called with unknown or unparseable pricing")
  }
  const rates = effectiveRates(pricing)
  return { perRequest: perRequestCost(rates, profile), rates }
}
