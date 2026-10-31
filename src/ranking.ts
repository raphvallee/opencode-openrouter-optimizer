/** Endpoint filtering, provider ranking and routing-body composition (all pure). */

import type { OptimizerOptions } from "./config"
import type { EndpointPricing, RequestProfile } from "./pricing"
import { isFreePricing, requestCost, totalCost } from "./pricing"

/** Subset of GET /api/v1/models/{author}/{slug}/endpoints we care about. */
export interface OpenRouterEndpoint {
  name: string
  model_id: string
  context_length: number | null
  max_completion_tokens: number | null
  max_prompt_tokens: number | null
  pricing: EndpointPricing
  provider_name: string
  tag: string
  supported_parameters: string[]
  status: number
  uptime_last_30m: number | null
  uptime_last_1d: number | null
  quantization?: string | null
}

/** Provider slug is the tag prefix, e.g. "deepinfra" for "deepinfra/turbo". */
export function providerSlug(endpoint: OpenRouterEndpoint): string {
  const fromTag = endpoint.tag?.split("/", 1)[0]
  if (fromTag) return fromTag
  return (endpoint.provider_name ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export interface Filtered {
  endpoint: OpenRouterEndpoint
  slug: string
  reason?: string
}

/** Drop endpoints that would break OpenCode sessions or be cursed for quality. */
export function filterEndpoint(endpoint: OpenRouterEndpoint, options: OptimizerOptions): string | undefined {
  if (endpoint.status !== 0 && endpoint.status !== null && endpoint.status !== undefined) return "status"
  const uptime = endpoint.uptime_last_30m ?? endpoint.uptime_last_1d ?? 100
  if (uptime < options.minUptimePercent) return "uptime"
  if (endpoint.context_length !== null && endpoint.context_length < options.minContextLength) return "context"
  if (
    endpoint.max_completion_tokens !== null &&
    endpoint.max_completion_tokens < options.minMaxCompletionTokens
  )
    return "completion"
  if (options.requireToolSupport) {
    const params = endpoint.supported_parameters ?? []
    if (!params.includes("tools") || !params.includes("tool_choice")) return "tools"
  }
  return undefined
}

export interface ProviderRank {
  slug: string
  /** Best surviving endpoint for this provider. */
  endpoint: OpenRouterEndpoint
  slugUptime: number
  perRequest: number
  total: number
  rank: number
}

export type RankingMode = "free" | "cheapest"

export interface Ranking {
  mode: RankingMode
  rankings: ProviderRank[]
  survivors: string[]
  blacklist: string[]
  profile: RequestProfile
  computedAt: number
}

/**
 * Filter endpoints, group by provider slug (best endpoint wins), rank ascending by
 * perRequest cost. Two modes:
 *
 * - "free": at least one surviving provider serves the model at $0 (a canonical
 *   non-":free" slug that still has free providers). Every free provider stays
 *   routable (topN is ignored: free providers must not be capped), and the blacklist
 *   consists exactly of the paid providers.
 * - "cheapest": usual behavior, topN survivors by per-request cost.
 *
 * Filtered-out endpoints are known provider slugs (they came from the endpoints API),
 * so they are blacklisted too: leaving them routable while injecting `sort: "price"`
 * would steer OpenRouter straight to the cheap-but-broken providers the filters
 * excluded. Enforcement requires at least one known-good route: when no endpoint
 * survives, only the user's extraIgnore is applied and the request passes through.
 */
export function rankProviders(
  endpoints: OpenRouterEndpoint[],
  profile: RequestProfile,
  options: OptimizerOptions,
): Ranking {
  const now = Date.now()

  // 1) Endpoint filters: only surviving endpoints can claim "free" or be ranked.
  //    Filtered slugs are remembered: they are known providers and enforceable.
  const eligible: Array<{ endpoint: OpenRouterEndpoint; slug: string }> = []
  const filteredSlugs = new Set<string>()
  for (const endpoint of endpoints) {
    const slug = providerSlug(endpoint)
    if (!slug) continue
    if (filterEndpoint(endpoint, options) !== undefined) {
      filteredSlugs.add(slug)
      continue
    }
    eligible.push({ endpoint, slug })
  }

  // 2) Free detection (slug level: one free alias is enough for the provider).
  const freeSlugs = new Set<string>()
  if (options.preferFreeProviders) {
    for (const { endpoint, slug } of eligible) {
      if (isFreePricing(endpoint.pricing)) freeSlugs.add(slug)
    }
  }
  const freeMode = freeSlugs.size > 0

  // 3) Best surviving endpoint per slug (paid slugs are skipped in free mode).
  const bySlug = new Map<string, ProviderRank>()
  for (const { endpoint, slug } of eligible) {
    if (freeMode && !freeSlugs.has(slug)) continue
    const { perRequest } = requestCost(endpoint.pricing, profile)
    const total = totalCost(perRequest, profile.numRequests)
    const uptime = endpoint.uptime_last_30m ?? endpoint.uptime_last_1d ?? 100

    const existing = bySlug.get(slug)
    if (!existing || perRequest < existing.perRequest) {
      bySlug.set(slug, { slug, endpoint, slugUptime: uptime, perRequest, total, rank: 0 })
    }
  }

  // Tie-break deterministically on slug so equal prices keep stable rank order.
  const ordered = [...bySlug.values()].sort(
    (a, b) => a.perRequest - b.perRequest || (a.slug < b.slug ? -1 : 1),
  )
  ordered.forEach((entry, index) => (entry.rank = index + 1))

  const survivors = freeMode
    ? ordered.map((entry) => entry.slug)
    : ordered.slice(0, options.topN).map((entry) => entry.slug)

  // In free mode the paid eligible slugs all go into the blacklist; in cheapest mode
  // it holds every ranked-but-not-surviving slug. Filtered-out slugs are enforceable
  // (known providers) but only when at least one survivor keeps the route open.
  // extraIgnore always applies: it is the user's explicit instruction.
  const survivorSet = new Set(survivors)
  const blacklist = survivors.length === 0
    ? [...new Set(options.extraIgnore)]
    : [
        ...new Set([
          ...eligible.map((entry) => entry.slug),
          ...filteredSlugs,
          ...options.extraIgnore,
        ].filter((slug) => !survivorSet.has(slug))),
      ]

  return {
    mode: freeMode ? "free" : "cheapest",
    rankings: ordered,
    survivors,
    blacklist,
    profile,
    computedAt: now,
  }
}

/**
 * Compose the OpenRouter `provider` routing block. Existing user-provided routing keys
 * survive; ignore + sort are this plugin's authority when a blacklist is available.
 * An array-form `provider` is treated as a provider-order preference and folded into
 * `order` instead of being silently dropped when the block is rewritten.
 */
export function composeRouting(existing: unknown, blacklist: string[] | undefined, options: OptimizerOptions) {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : Array.isArray(existing)
        ? { order: [...existing] }
        : {}
  const routing = { ...base }
  if (options.injectSort && routing.sort === undefined) routing.sort = "price"
  if (blacklist && blacklist.length > 0) routing.ignore = [...blacklist]
  return routing
}
