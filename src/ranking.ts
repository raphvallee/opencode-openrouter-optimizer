/** Endpoint filtering, provider ranking and routing-body composition (all pure). */

import type { OptimizerOptions } from "./config.js";
import type { EndpointPricing, RequestProfile } from "./pricing.js";
import { hasKnownPricing, isFreePricing, requestCost, totalCost } from "./pricing.js";

/** Subset of GET /api/v1/models/{author}/{slug}/endpoints we care about. */
export interface OpenRouterEndpoint {
  name: string;
  model_id: string;
  context_length: number | null;
  max_completion_tokens: number | null;
  max_prompt_tokens: number | null;
  pricing: EndpointPricing;
  provider_name: string;
  tag: string;
  supported_parameters: string[];
  status: number;
  uptime_last_30m: number | null;
  uptime_last_1d: number | null;
  quantization?: string | null;
  /**
   * Provider-level Tool Call Error Rate (percent, 0-100), attached by the refresh
   * task from OpenRouter's Performance-tab stats. Undefined when OpenRouter has no
   * tool-call data for the provider: no evidence, no filtering.
   */
  toolCallErrorRate?: number;
}

/** Provider slug is the tag prefix, e.g. "deepinfra" for "deepinfra/turbo". */
export function providerSlug(endpoint: OpenRouterEndpoint): string {
  const fromTag = endpoint.tag?.split("/", 1)[0];
  if (fromTag) return fromTag;
  return (endpoint.provider_name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface Filtered {
  endpoint: OpenRouterEndpoint;
  slug: string;
  reason?: string;
}

/**
 * Relative weight of every filter failure that reaches the rescue ordering: how
 * badly it breaks a session.
 *
 * The numbers only have to order the rescue candidates, so they encode "how much
 * does a session suffer from this", not a cost model. Each failed check adds its
 * weight scaled by how far past the threshold it is (see failureMagnitude), so a
 * provider that misses a threshold by a hair always beats one that misses it
 * badly.
 *
 * - context: the session dies once the conversation outgrows the window.
 * - tool-errors: invalid tool calls break the agent loop.
 * - uptime: the provider drops requests outright.
 * - completion: answers get cut short, but the request still succeeds.
 *
 * The unrescuable failures (status, tools, pricing) carry no weight here on
 * purpose: a provider that fails one of them is skipped as a rescue candidate
 * before any ordering happens (see UNRESCUABLE_REASONS), so their magnitudes
 * never compare. The `?? 20` default in filterSeverity keeps them ranked
 * sensibly should that set ever change.
 */
const FAILURE_WEIGHTS: Record<string, number> = {
  context: 40,
  "tool-errors": 30,
  uptime: 20,
  completion: 10,
};

/**
 * How far past its threshold a failure is, as a 0..1 ratio: the share of the
 * requirement that is missing. A provider at 89.9% uptime (min 90) misses 0.1%
 * of what was asked for, one at 40% misses 55%.
 */
function failureMagnitude(
  endpoint: OpenRouterEndpoint,
  reason: string,
  options: OptimizerOptions,
): number {
  const ratio = (missing: number, span: number): number =>
    Math.min(1, Math.max(0, missing / Math.max(span, 1)));
  switch (reason) {
    case "uptime": {
      const uptime = endpoint.uptime_last_30m ?? endpoint.uptime_last_1d ?? 100;
      return ratio(options.minUptimePercent - uptime, options.minUptimePercent);
    }
    case "tool-errors": {
      // The cap is a maximum, so the miss is measured against the headroom that
      // was left above it: twice the cap eats half of the remaining band.
      const rate = endpoint.toolCallErrorRate ?? 0;
      return ratio(rate - options.maxToolCallErrorRate, 100 - options.maxToolCallErrorRate);
    }
    case "context": {
      const length = endpoint.context_length ?? 0;
      return ratio(options.minContextLength - length, options.minContextLength);
    }
    case "completion": {
      const max = endpoint.max_completion_tokens ?? 0;
      return ratio(options.minMaxCompletionTokens - max, options.minMaxCompletionTokens);
    }
    default:
      return 1;
  }
}

/**
 * How badly an endpoint failed the filters: lower is better ("fails least
 * hard"). Every failed check contributes its weight scaled by how far past the
 * threshold it is, so a provider at 89.9% uptime (min 90) is a far better
 * rescue candidate than one at 40%.
 */
export function filterSeverity(
  endpoint: OpenRouterEndpoint,
  reasons: string[],
  options: OptimizerOptions,
): number {
  let severity = 0;
  for (const reason of reasons) {
    const weight = FAILURE_WEIGHTS[reason] ?? 20;
    severity += weight * failureMagnitude(endpoint, reason, options);
  }
  return severity;
}

/**
 * Drop endpoints that would break OpenCode sessions, be cursed for quality, or have unknown
 * pricing. Returns every failed check (not just the first) so the debug print can show the
 * full diagnosis; an empty array means the endpoint passed all filters.
 */
export function filterEndpoint(endpoint: OpenRouterEndpoint, options: OptimizerOptions): string[] {
  const reasons: string[] = [];
  if (endpoint.status !== 0 && endpoint.status !== null && endpoint.status !== undefined)
    reasons.push("status");
  if (!hasKnownPricing(endpoint.pricing)) reasons.push("pricing");
  const uptime = endpoint.uptime_last_30m ?? endpoint.uptime_last_1d ?? 100;
  if (uptime < options.minUptimePercent) reasons.push("uptime");
  if (
    endpoint.toolCallErrorRate !== undefined &&
    endpoint.toolCallErrorRate > options.maxToolCallErrorRate
  ) {
    reasons.push("tool-errors");
  }
  if (endpoint.context_length !== null && endpoint.context_length < options.minContextLength) {
    reasons.push("context");
  }
  if (
    endpoint.max_completion_tokens !== null &&
    endpoint.max_completion_tokens < options.minMaxCompletionTokens
  ) {
    reasons.push("completion");
  }
  if (options.requireToolSupport) {
    const params = endpoint.supported_parameters ?? [];
    if (!params.includes("tools") || !params.includes("tool_choice")) reasons.push("tools");
  }
  return reasons;
}

export interface ProviderRank {
  slug: string;
  /** Best surviving endpoint for this provider. */
  endpoint: OpenRouterEndpoint;
  slugUptime: number;
  perRequest: number;
  total: number;
  rank: number;
  /**
   * True when the provider failed the endpoint filters and was kept anyway,
   * because keepAtLeastN needed more providers to stand.
   */
  rescued?: boolean;
  /** The filter checks this provider failed (rescued providers only). */
  failedReasons?: string[];
}

export type RankingMode = "free" | "cheapest";

export interface Ranking {
  mode: RankingMode;
  rankings: ProviderRank[];
  survivors: string[];
  blacklist: string[];
  /**
   * slug -> reasons it was blacklisted (all of them, one entry per cause). Always
   * built: reasons are stored with every ranking, so turning the debug option on
   * later works immediately instead of showing nothing until the next re-rank.
   */
  blacklistReasons?: Record<string, string[]>;
  /**
   * Providers that failed the endpoint filters but stood anyway, because
   * keepAtLeastN needed more providers to stand than the filters left. Empty when
   * the filters left enough providers on their own.
   */
  rescued: string[];
  profile: RequestProfile;
  computedAt: number;
}

/**
 * Filter failures that disqualify a provider from the keepAtLeastN floor.
 *
 * - status: the endpoint is not serving; the route is dead right now.
 * - pricing: the price cannot be parsed, so the route cannot be cost-ranked.
 *   The plugin never routes to a provider whose cost it cannot verify.
 * - tools: the model cannot call tools, so the session cannot work at all.
 */
const UNRESCUABLE_REASONS = new Set(["status", "pricing", "tools"]);

/** One failed endpoint: the checks it missed and how badly it missed them. */
interface Failure {
  endpoint: OpenRouterEndpoint;
  reasons: string[];
  severity: number;
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
 *
 * keepAtLeastN is the floor on the providers that stay standing. The filters can
 * be strict enough to leave none, and then the request would go out unrouted, to a
 * provider nobody vetted. The floor stops the filtering early instead: the
 * providers that fail least hard stand as well, and the ones that failed harder
 * stay blacklisted. The count of standing providers stops at keepAtLeastN, so
 * only the providers that missed the thresholds by the least are let through.
 * When keepAtLeastN is higher than topN, the floor also raises the cap on the
 * providers that passed, even when nothing needs rescuing.
 *
 * A rescued provider stands as a whole: the routing block ignores providers,
 * not aliases, so every alias of a rescued provider goes back on the route.
 * Two rules keep that honest. A provider with any dead, unpriceable or
 * tool-less alias is never rescued: that broken alias could get the traffic,
 * not just the alias the rescue decided on. And in free mode only an all-free
 * provider is rescued: a provider that also carries a paid alias would put
 * that paid alias back on the route.
 */
export function rankProviders(
  endpoints: OpenRouterEndpoint[],
  profile: RequestProfile,
  options: OptimizerOptions,
): Ranking {
  const now = Date.now();

  // slug -> block causes. Always built: the payload is tiny, and persisting it with
  // every ranking is what makes debugBlacklistReasons useful on a stored ranking.
  const reasonMap = new Map<string, Set<string>>();
  const addReason = (slug: string, reason: string) => {
    const existing = reasonMap.get(slug);
    if (existing) existing.add(reason);
    else reasonMap.set(slug, new Set([reason]));
  };

  // 1) Endpoint filters: only surviving endpoints can claim "free" or be ranked.
  //    Filtered slugs are remembered: they are known providers and enforceable.
  const eligible: Array<{ endpoint: OpenRouterEndpoint; slug: string }> = [];
  const filteredSlugs = new Set<string>();
  // Slugs with at least one endpoint that passed every filter. They stand on their
  // own and never need rescuing.
  const qualified = new Set<string>();
  // slug -> its failing endpoints, with the reasons and how hard each one failed.
  // The rescue picks the least-bad alias of a provider, so every failed alias has
  // to be kept until the mode is known (in free mode only a free alias may stand).
  const failing = new Map<string, Failure[]>();
  for (const endpoint of endpoints) {
    const slug = providerSlug(endpoint);
    if (!slug) continue;
    const filterReasons = filterEndpoint(endpoint, options);
    if (filterReasons.length > 0) {
      filteredSlugs.add(slug);
      for (const filterReason of filterReasons) addReason(slug, filterReason);
      const failure: Failure = {
        endpoint,
        reasons: filterReasons,
        severity: filterSeverity(endpoint, filterReasons, options),
      };
      const list = failing.get(slug);
      if (list) list.push(failure);
      else failing.set(slug, [failure]);
      continue;
    }
    qualified.add(slug);
    eligible.push({ endpoint, slug });
  }

  // 2) Free detection (slug level: one free alias is enough for the provider).
  //    Classified at the tier the workload bills: an endpoint free below a
  //    context-size threshold is paid above it, and vice versa.
  const freeSlugs = new Set<string>();
  if (options.preferFreeProviders) {
    for (const { endpoint, slug } of eligible) {
      if (isFreePricing(endpoint.pricing, profile.avgInput)) freeSlugs.add(slug);
    }
  }
  const freeMode = freeSlugs.size > 0;

  // 3) Best surviving endpoint per slug (paid slugs are skipped in free mode).
  const bySlug = new Map<string, ProviderRank>();
  for (const { endpoint, slug } of eligible) {
    if (freeMode && !freeSlugs.has(slug)) continue;
    const { perRequest } = requestCost(endpoint.pricing, profile);
    const total = totalCost(perRequest, profile.numRequests);
    const uptime = endpoint.uptime_last_30m ?? endpoint.uptime_last_1d ?? 100;

    const existing = bySlug.get(slug);
    if (!existing || perRequest < existing.perRequest) {
      bySlug.set(slug, { slug, endpoint, slugUptime: uptime, perRequest, total, rank: 0 });
    }
  }

  // Tie-break deterministically on slug so equal prices keep stable rank order.
  const ordered = [...bySlug.values()].sort(
    (a, b) => a.perRequest - b.perRequest || (a.slug < b.slug ? -1 : 1),
  );

  // 4) keepAtLeastN floor. The filters can starve the routing: a model whose
  //    providers all miss a threshold (a 24k context, a flaky uptime) leaves no
  //    provider standing, and the request then goes out unrouted, to a provider
  //    nobody vetted. The floor stops the filtering early: the providers that fail
  //    least hard stand as well, and the ones that failed harder stay blacklisted.
  //
  //    Which ones: the providers the filters removed, ordered by the user's free
  //    preference first (with preferFreeProviders, a rescued free provider
  //    outranks a rescued paid one: the preference survives the floor, and every
  //    rescue is named in a warning), then by how little they failed - the
  //    lightest miss first (a provider at 89.9% uptime misses less than one at
  //    40%), then the fewest failed checks, then the cheapest, then the slug so
  //    the order is stable. Providers that already stand are never rescued, and
  //    in free mode only an all-free provider qualifies, so the mode's promise
  //    survives.
  const rescued: string[] = [];
  const rescuedRanks: ProviderRank[] = [];
  // The providers that stand on their own: the cheapest ones in cheapest mode
  // (topN caps them, keepAtLeastN raises the cap so enough good providers can
  // hold the floor), every free one in free mode (topN is ignored there).
  const standing = freeMode
    ? ordered
    : ordered.slice(0, Math.max(options.topN, options.keepAtLeastN));
  // How many providers the floor still misses. The floor only ever adds
  // providers: the count stops at keepAtLeastN, so the providers that failed
  // harder than the rescued ones stay blacklisted.
  const deficit = Math.max(0, options.keepAtLeastN - standing.length);
  if (deficit > 0) {
    const extraIgnore = new Set(options.extraIgnore);
    const candidates: Array<{ slug: string; failure: Failure; pool: Failure[]; free: boolean }> =
      [];
    for (const [slug, failures] of failing) {
      // A provider that already stands on its own never needs rescuing.
      if (qualified.has(slug)) continue;
      // The user excluded it explicitly.
      if (extraIgnore.has(slug)) continue;
      // In free mode only a free alias may stand: a paid provider would break
      // the mode's promise.
      const pool = freeMode
        ? failures.filter((failure) => isFreePricing(failure.endpoint.pricing, profile.avgInput))
        : failures;
      if (pool.length === 0) continue;
      // A rescued slug is routable as a whole, so every alias it has goes back
      // on the route, not just the one the rescue is decided on. In free mode
      // that means a provider that also carries a paid alias would put that
      // paid alias back on the route: only an all-free provider may stand.
      // (A provider with a passing alias is qualified and never reaches this
      // point, so "every failing alias" covers the provider here.)
      if (freeMode && pool.length !== failures.length) continue;
      // And for the same reason, a dead, unpriceable or tool-less alias anywhere
      // on the provider can get the traffic: any one of them disqualifies the
      // provider, not just the alias that failed least hard.
      if (pool.some((failure) => failure.reasons.some((reason) => UNRESCUABLE_REASONS.has(reason))))
        continue;
      // The alias the rescue decision is made on: the one that fails least hard.
      const best = pool.reduce((a, b) => (b.severity < a.severity ? b : a));
      // The user's free preference, as far as the rescue can honor it: a
      // provider with a failing free alias is preferred over a paid one. In
      // free mode every candidate is free, so this is a no-op there.
      const free = pool.some((failure) =>
        isFreePricing(failure.endpoint.pricing, profile.avgInput),
      );
      candidates.push({ slug, failure: best, pool, free });
    }
    candidates.sort((a, b) => {
      // The user's free preference outranks the miss magnitude: without this,
      // a barely-failing paid provider would be rescued ahead of a harder-
      // failing free one, and the request would route to a paid provider
      // against the preference. Every rescue is named in a warning.
      if (options.preferFreeProviders && a.free !== b.free) return a.free ? -1 : 1;
      if (a.failure.severity !== b.failure.severity) return a.failure.severity - b.failure.severity;
      if (a.failure.reasons.length !== b.failure.reasons.length) {
        return a.failure.reasons.length - b.failure.reasons.length;
      }
      const cost =
        requestCost(a.failure.endpoint.pricing, profile).perRequest -
        requestCost(b.failure.endpoint.pricing, profile).perRequest;
      if (cost !== 0) return cost;
      return a.slug < b.slug ? -1 : 1;
    });
    for (const { slug, failure, pool } of candidates.slice(0, deficit)) {
      // The rank entry describes the provider as the routing sees it: with
      // sort: "price" OpenRouter tries the provider's cheapest alias first, so
      // the entry reports that alias's price, not the least-bad failure's. The
      // failed reasons stay on the alias the rescue decision used: they are why
      // the provider was rescue-eligible.
      const routed = pool.reduce((a, b) =>
        requestCost(b.endpoint.pricing, profile).perRequest <
        requestCost(a.endpoint.pricing, profile).perRequest
          ? b
          : a,
      );
      const { perRequest } = requestCost(routed.endpoint.pricing, profile);
      const uptime = routed.endpoint.uptime_last_30m ?? routed.endpoint.uptime_last_1d ?? 100;
      rescued.push(slug);
      rescuedRanks.push({
        slug,
        endpoint: routed.endpoint,
        slugUptime: uptime,
        perRequest,
        total: totalCost(perRequest, profile.numRequests),
        rank: 0,
        rescued: true,
        failedReasons: failure.reasons,
      });
    }
  }

  // The full ranking: every provider that passed the filters, by price, then the
  // rescued ones. The rescued ones come last because they failed a check and are
  // only there to hold the floor.
  const rankings = [...ordered, ...rescuedRanks];
  rankings.forEach((entry, index) => (entry.rank = index + 1));
  // The providers that stay routable: the ones that passed every filter (the
  // cheapest of them, capped by the higher of topN and keepAtLeastN) plus the
  // rescued ones.
  const survivors = [...standing.map((entry) => entry.slug), ...rescued];
  const survivorSet = new Set(survivors);

  // In free mode the paid eligible slugs all go into the blacklist; in cheapest mode
  // it holds every ranked-but-not-surviving slug. Filtered-out slugs are enforceable
  // (known providers) but only when at least one survivor keeps the route open.
  // extraIgnore always applies: it is the user's explicit instruction.
  const blacklist =
    survivors.length === 0
      ? [...new Set(options.extraIgnore)]
      : [
          ...new Set(
            [
              ...eligible.map((entry) => entry.slug),
              ...filteredSlugs,
              ...options.extraIgnore,
            ].filter((slug) => !survivorSet.has(slug)),
          ),
        ];

  // Ranked-but-not-surviving slugs are blocked by price (topN in cheapest mode,
  // paid-in-free-mode otherwise); extraIgnore is the user's explicit instruction.
  const priceReason = freeMode ? "paid" : "not-cheapest";
  for (const { slug } of eligible) {
    if (!survivorSet.has(slug)) addReason(slug, priceReason);
  }
  for (const slug of options.extraIgnore) {
    addReason(slug, "extra-ignore");
  }
  // Keep the blacklist's order and only include slugs that are actually blocked:
  // a slug can carry filter + price + extraIgnore reasons at once.
  const blacklistReasons: Record<string, string[]> = {};
  for (const slug of blacklist) {
    const reasons = reasonMap.get(slug);
    if (reasons && reasons.size > 0) blacklistReasons[slug] = [...reasons];
  }

  return {
    mode: freeMode ? "free" : "cheapest",
    rankings,
    survivors,
    blacklist,
    blacklistReasons,
    rescued,
    profile,
    computedAt: now,
  };
}

/**
 * Compose the OpenRouter `provider` routing block. Existing user-provided routing keys
 * survive; ignore + sort are this plugin's authority when a blacklist is available.
 * An array-form `provider` is treated as a provider-order preference and folded into
 * `order` instead of being silently dropped when the block is rewritten.
 */
export function composeRouting(
  existing: unknown,
  blacklist: string[] | undefined,
  options: OptimizerOptions,
) {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : Array.isArray(existing)
        ? { order: [...existing] }
        : {};
  const routing = { ...base };
  if (options.injectSort && routing.sort === undefined) routing.sort = "price";
  if (blacklist && blacklist.length > 0) routing.ignore = [...blacklist];
  return routing;
}
