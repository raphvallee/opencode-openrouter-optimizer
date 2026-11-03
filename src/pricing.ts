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
 *
 * Some endpoints price long context differently: pricing.overrides carries conditional
 * entries, and a tiered entry applies when the request's prompt tokens are strictly
 * greater than its min_prompt_tokens threshold. This matters because most recent OpenAI
 * models (GPT-6 Luna and similar) charge a higher rate once the prompt crosses a context
 * threshold, so base rates alone would understate a long-context session's cost.
 * Per OpenRouter's contract, later
 * applicable entries win per price key and keys an entry leaves out inherit the base
 * price. The cost model sees the workload through the profile, so the profile's
 * avgInput plays the role of the request's prompt size: a tier applies when avgInput is
 * strictly above its threshold, and the whole request is billed at that tier (the API
 * does not bill tiers marginally). Time-windowed entries (utc_start/utc_end/utc_days)
 * and entries with condition fields we do not know are skipped: the top-level prices
 * are the documented default, so billing those at the base rate is safe.
 */

/** Prices are strings like "0.0000001", USD per token, base rate before discount. */
export interface EndpointPricing {
  prompt: string | number;
  completion: string | number;
  input_cache_read?: string | number | null;
  input_cache_write?: string | number | null;
  discount?: number | string | null;
  overrides?: PricingOverride[];
}

/**
 * One conditional pricing entry from pricing.overrides. Conditions decide when the
 * entry's prices apply; an entry carrying a condition or price key we do not know is
 * skipped entirely (future grammar additions must not be guessed at).
 */
export interface PricingOverride {
  min_prompt_tokens?: number;
  utc_start?: number;
  utc_end?: number;
  utc_days?: string[];
  prompt?: string | number;
  completion?: string | number;
  input_cache_read?: string | number | null;
  input_cache_write?: string | number | null;
  /** Other price keys (audio, request, image, ...) exist but never enter the model. */
  [key: string]: unknown;
}

export interface Rates {
  inputRate: number;
  outputRate: number;
  readRate: number;
  writeRate: number;
  /** The discount factor that was applied (0 when the endpoint has no discount). */
  discount: number;
}

type ParsedPrice = { kind: "absent" } | { kind: "known"; value: number } | { kind: "invalid" };

/** Prices above this ceiling are treated as unknown pricing, never as real numbers. */
const MAX_REASONABLE_PRICE = 1e9;

/**
 * Parse a price without guessing. "absent" means the field was omitted; "invalid" means
 * it was present but is not a finite non-negative number ("", "N/A", "free", -1, ...).
 * The distinction matters for cache fields: an absent cache price means "not offered",
 * while an invalid one is unknown pricing that must not be silently treated as $0.
 * Absurdly large values (> 1e9 USD per token) are also invalid: they are never a real
 * quote and only serve to break downstream math (Infinity, NaN comparisons).
 */
function parsePrice(value: string | number | null | undefined): ParsedPrice {
  if (value === null || value === undefined) return { kind: "absent" };
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= MAX_REASONABLE_PRICE
      ? { kind: "known", value }
      : { kind: "invalid" };
  }
  if (typeof value !== "string") return { kind: "invalid" };
  const trimmed = value.trim();
  if (trimmed === "") return { kind: "invalid" };
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_REASONABLE_PRICE
    ? { kind: "known", value: parsed }
    : { kind: "invalid" };
}

/** Required price: absent or invalid is unknown (null). */
function parseRequiredPrice(value: string | number | null | undefined): number | null {
  const parsed = parsePrice(value);
  return parsed.kind === "known" ? parsed.value : null;
}

/** Optional discount: absent or invalid is treated as no discount. */
function parseDiscount(value: string | number | null | undefined): number {
  const parsed = parsePrice(value);
  return parsed.kind === "known" ? parsed.value : 0;
}

/** Condition keys that scope when an override entry applies. */
const OVERRIDE_CONDITION_KEYS = new Set(["min_prompt_tokens", "utc_start", "utc_end", "utc_days"]);

/** Price keys OpenRouter may put in an override; only the modeled four change rates. */
const OVERRIDE_PRICE_KEYS = new Set([
  "prompt",
  "completion",
  "input_cache_read",
  "input_cache_write",
  "audio",
  "audio_output",
  "request",
  "image",
  "image_output",
  "image_token",
  "web_search",
  "internal_reasoning",
  "input_cache_write_1h",
  "input_audio_cache",
]);

/** The raw prices (base values, possibly replaced by applicable overrides). */
interface TierPrices {
  prompt: string | number | null | undefined;
  completion: string | number | null | undefined;
  input_cache_read: string | number | null | undefined;
  input_cache_write: string | number | null | undefined;
}

/**
 * Whether an override entry can apply at this context size. Entries with an unknown
 * key or a time condition are never applicable (they are skipped, and the base prices
 * remain the documented default). A tiered entry applies strictly above its threshold.
 */
function applicableOverride(entry: PricingOverride, contextSize: number): boolean {
  if (!understoodEntry(entry)) return false;
  if (entry.min_prompt_tokens === undefined) return true;
  const threshold = entry.min_prompt_tokens;
  return (
    typeof threshold === "number" &&
    Number.isFinite(threshold) &&
    threshold >= 0 &&
    contextSize > threshold
  );
}

/**
 * True when the entry only carries condition and price keys we know and has no time
 * window: such an entry's prices are billable at some context size, so its price keys
 * must parse wherever the base price rules would demand it.
 */
function understoodEntry(entry: PricingOverride): boolean {
  for (const key of Object.keys(entry)) {
    if (!OVERRIDE_CONDITION_KEYS.has(key) && !OVERRIDE_PRICE_KEYS.has(key)) return false;
  }
  if (entry.utc_start !== undefined || entry.utc_end !== undefined || entry.utc_days !== undefined)
    return false;
  return true;
}

/**
 * Resolve which raw prices back each modeled rate. Without a context size this is the
 * base pricing. With one, context-tiered overrides that apply at that size replace the
 * base prices, later applicable entries winning per key; keys an entry omits stay
 * inherited from whatever was resolved before it.
 */
function resolveTierPrices(pricing: EndpointPricing, contextSize: number | undefined): TierPrices {
  const tier: TierPrices = {
    prompt: pricing.prompt,
    completion: pricing.completion,
    input_cache_read: pricing.input_cache_read,
    input_cache_write: pricing.input_cache_write,
  };
  if (
    contextSize === undefined ||
    !Number.isFinite(contextSize) ||
    !Array.isArray(pricing.overrides)
  )
    return tier;
  for (const entry of pricing.overrides) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!applicableOverride(entry, contextSize)) continue;
    if ("prompt" in entry) tier.prompt = entry.prompt;
    if ("completion" in entry) tier.completion = entry.completion;
    if ("input_cache_read" in entry) tier.input_cache_read = entry.input_cache_read;
    if ("input_cache_write" in entry) tier.input_cache_write = entry.input_cache_write;
  }
  return tier;
}

/**
 * True when prompt and completion parse to real, non-negative prices and any
 * cache-write price is either absent or parseable. An unparseable cache-write price is
 * unknown pricing: rankProviders blacklists the endpoint instead of billing the cache
 * write as $0. An unparseable cache-read price is allowed: the cost model treats it as
 * "no cache" and bills those tokens at the input price.
 *
 * Overrides follow the same rules, applied to the entries that can actually be billed:
 * with a context size only entries applicable at that size are checked, without one
 * every understood entry is (conservative, since the filter step has no profile). An
 * applicable entry with an unparseable prompt, completion, or cache-write price makes
 * the endpoint unknown pricing; an unparseable cache-read price falls back to the input
 * price, as on the base level.
 */
export function hasKnownPricing(pricing: EndpointPricing, contextSize?: number): boolean {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return false;
  // A discount of 100% or more is not a sale, it is a broken price document.
  if (parseDiscount(pricing.discount) >= 1) return false;
  if (
    parsePrice(pricing.prompt).kind !== "known" ||
    parsePrice(pricing.completion).kind !== "known" ||
    parsePrice(pricing.input_cache_write).kind === "invalid"
  ) {
    return false;
  }
  if (Array.isArray(pricing.overrides)) {
    for (const entry of pricing.overrides) {
      if (typeof entry !== "object" || entry === null) continue;
      // Conservative mode (no context size) checks every billable entry; tier-aware
      // mode checks only the entries applicable at that size.
      if (contextSize !== undefined && !applicableOverride(entry, contextSize)) continue;
      if (!understoodEntry(entry)) continue;
      if (parsePrice(entry.prompt).kind === "invalid") return false;
      if (parsePrice(entry.completion).kind === "invalid") return false;
      if (parsePrice(entry.input_cache_write).kind === "invalid") return false;
    }
  }
  return true;
}

/**
 * Strictly free endpoint: zero base price on input and output, and no positive cache
 * read/write price. An absent or unparseable cache-read price falls back to the input
 * price (so it is free only when the input price is also zero). An unparseable
 * cache-write price is unknown pricing and is never classified as free.
 *
 * With a context size the check runs against the tier that would actually be billed at
 * that size: an endpoint free below a threshold is paid above it, and vice versa.
 */
export function isFreePricing(pricing: EndpointPricing, contextSize?: number): boolean {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return false;
  const tier = resolveTierPrices(pricing, contextSize);
  const prompt = parsePrice(tier.prompt);
  const completion = parsePrice(tier.completion);
  if (prompt.kind !== "known" || completion.kind !== "known") return false;
  if (prompt.value !== 0 || completion.value !== 0) return false;
  const read = parsePrice(tier.input_cache_read);
  const readRate = read.kind === "known" ? read.value : prompt.value;
  if (readRate !== 0) return false;
  const write = parsePrice(tier.input_cache_write);
  if (write.kind === "invalid") return false;
  if (write.kind === "known" && write.value !== 0) return false;
  return true;
}

export function effectiveRates(pricing: EndpointPricing, contextSize?: number): Rates {
  // Exported for the cost model; never produce a silent $0 from unknown pricing,
  // not even for direct callers that skip requestCost/hasKnownPricing.
  if (!hasKnownPricing(pricing, contextSize)) {
    throw new Error("effectiveRates called with unknown or unparseable pricing");
  }
  const tier = resolveTierPrices(pricing, contextSize);
  const rawDiscount = parseDiscount(pricing.discount);
  // Discounts live in [0, 1]; anything outside is treated as no discount. Cap the
  // honoured discount at 50%: anything deeper is a broken price document, not a
  // sale, and must never zero out every rate and win the price sort.
  const discount = rawDiscount > 0 && rawDiscount <= 0.5 ? rawDiscount : 0;
  const scale = 1 - discount;
  const inputRate = (parseRequiredPrice(tier.prompt) ?? 0) * scale;
  const read = parsePrice(tier.input_cache_read);
  // No cache read price means "no cache": cached input is billed at the input rate.
  const readRate =
    (read.kind === "known" ? read.value : (parseRequiredPrice(tier.prompt) ?? 0)) * scale;
  const write = parsePrice(tier.input_cache_write);
  // An absent cache-write price is 0. Invalid values are unknown pricing and are
  // filtered by rankProviders via hasKnownPricing before a ranking is computed.
  const writeRate = (write.kind === "known" ? write.value : 0) * scale;
  return {
    inputRate,
    outputRate: (parseRequiredPrice(tier.completion) ?? 0) * scale,
    readRate,
    writeRate,
    discount,
  };
}

export interface RequestProfile {
  /** Average total input tokens per request (cached + uncached). */
  avgInput: number;
  /** Average output tokens per request (completion + reasoning). */
  avgOutput: number;
  /** Cache hit rate in [0, 1]. */
  cacheHitRate: number;
  /** Number of requests the profile was computed over. */
  numRequests: number;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function perRequestCost(rates: Rates, profile: RequestProfile): number {
  const h = clamp01(profile.cacheHitRate);
  const input =
    profile.avgInput * (h * rates.readRate + (1 - h) * (rates.inputRate + rates.writeRate));
  const output = profile.avgOutput * rates.outputRate;
  return input + output;
}

export function totalCost(perRequest: number, numRequests: number): number {
  return perRequest * numRequests;
}

export function requestCost(
  pricing: EndpointPricing,
  profile: RequestProfile,
): { perRequest: number; rates: Rates } {
  // Loud guard: rankProviders filters with hasKnownPricing first, so reaching this with
  // unknown pricing means a caller bypassed the blacklist. Failing here is safer than
  // silently pricing an unknown cache write as $0.
  if (!hasKnownPricing(pricing, profile.avgInput)) {
    throw new Error("requestCost called with unknown or unparseable pricing");
  }
  // The profile's average input tokens stand in for the request's prompt size, which
  // is what context-tiered overrides key on.
  const rates = effectiveRates(pricing, profile.avgInput);
  return { perRequest: perRequestCost(rates, profile), rates };
}
