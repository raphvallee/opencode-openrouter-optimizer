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

/** Provider slugs are short lowercase tags, canonicalised everywhere they are built. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isProviderSlug(value: string | undefined): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

/**
 * Provider slug is the tag prefix, e.g. "deepinfra" for "deepinfra/turbo". The tag
 * path is canonicalised (trimmed, lower-cased) and validated; a tag or provider
 * name that cannot produce a safe slug yields "" (the endpoint is dropped from
 * ranking instead of crashing the refresh or injecting junk upstream).
 */
export function providerSlug(endpoint: OpenRouterEndpoint): string {
  const tag = endpoint?.tag;
  if (typeof tag === "string") {
    const fromTag = tag.split("/", 1)[0]?.trim().toLowerCase();
    if (isProviderSlug(fromTag)) return fromTag;
  }
  const name = endpoint?.provider_name;
  if (typeof name !== "string") return "";
  const fromName = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return isProviderSlug(fromName) ? fromName : "";
}

/**
 * A hostile upstream cannot make the ranking iterate without bound: at most
 * this many endpoints are considered per refresh.
 */
const MAX_ENDPOINTS = 512;

/**
 * True when an endpoints payload names exactly one provider, by the same
 * canonical slug logic the ranking uses. Returns that provider's slug, or
 * undefined when the model has zero or several. The bypass decision: a model
 * with a single provider sends its requests unmodified, so the refresh task
 * uses this to skip the probes (tool call error rate) a bypassed model never
 * needs. Endpoints whose slug cannot be canonicalized are not a provider:
 * they are dropped everywhere anyway and do not make a multi-provider model.
 */
export function singleProviderSlug(endpoints: readonly OpenRouterEndpoint[]): string | undefined {
  if (!Array.isArray(endpoints)) return undefined;
  const seen = new Set<string>();
  for (const endpoint of endpoints.slice(0, MAX_ENDPOINTS)) {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
    const slug = providerSlug(endpoint);
    if (!slug) continue;
    seen.add(slug);
    if (seen.size > 1) return undefined;
  }
  return seen.size === 1 ? [...seen][0] : undefined;
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
const finiteIn = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;

function failureMagnitude(
  endpoint: OpenRouterEndpoint,
  reason: string,
  options: OptimizerOptions,
): number {
  const ratio = (missing: number, span: number): number =>
    Math.min(1, Math.max(0, missing / Math.max(span, 1)));
  switch (reason) {
    case "uptime": {
      // Missing or invalid uptime never ranks better than a perfect score; a
      // failed-check endpoint gets maximum magnitude instead.
      const uptime =
        finiteIn(endpoint.uptime_last_30m, 0, 100) ?? finiteIn(endpoint.uptime_last_1d, 0, 100);
      return ratio(options.minUptimePercent - (uptime ?? 0), options.minUptimePercent);
    }
    case "tool-errors": {
      // The cap is a maximum, so the miss is measured against the headroom that
      // was left above it: twice the cap eats half of the remaining band.
      const rate = finiteIn(endpoint.toolCallErrorRate, 0, 100);
      return ratio(
        (rate ?? 100) - options.maxToolCallErrorRate,
        100 - options.maxToolCallErrorRate,
      );
    }
    case "context": {
      const length = finiteIn(endpoint.context_length, 0, 100_000_000) ?? 0;
      return ratio(options.minContextLength - length, options.minContextLength);
    }
    case "completion": {
      const max = finiteIn(endpoint.max_completion_tokens, 0, 100_000_000) ?? 0;
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
/** True when the value is an actual finite number; null/undefined mean "missing" (pass-through). */
function presentFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when the value is present but not usable: fails the filter closed. */
function presentButInvalid(value: unknown, min: number, max: number): boolean {
  if (value === null || value === undefined) return false;
  return !presentFiniteNumber(value) || value < min || value > max;
}

export function filterEndpoint(endpoint: OpenRouterEndpoint, options: OptimizerOptions): string[] {
  const reasons: string[] = [];
  if (endpoint.status !== 0 && endpoint.status !== null && endpoint.status !== undefined)
    reasons.push("status");
  if (!hasKnownPricing(endpoint.pricing)) reasons.push("pricing");
  const uptime =
    finiteIn(endpoint.uptime_last_30m, 0, 100) ?? finiteIn(endpoint.uptime_last_1d, 0, 100);
  // Present-but-invalid uptime fails closed; missing uptime passes (no evidence,
  // and the ranking must not guess it is 100).
  if (presentButInvalid(endpoint.uptime_last_30m, 0, 100)) reasons.push("uptime");
  else if (presentButInvalid(endpoint.uptime_last_1d, 0, 100)) reasons.push("uptime");
  else if (uptime !== undefined && uptime < options.minUptimePercent) reasons.push("uptime");
  if (endpoint.toolCallErrorRate !== undefined) {
    if (!presentFiniteNumber(endpoint.toolCallErrorRate)) reasons.push("tool-errors");
    else if (endpoint.toolCallErrorRate < 0 || endpoint.toolCallErrorRate > 100)
      reasons.push("tool-errors");
    else if (endpoint.toolCallErrorRate > options.maxToolCallErrorRate) reasons.push("tool-errors");
  }
  if (endpoint.context_length !== null && endpoint.context_length !== undefined) {
    if (presentButInvalid(endpoint.context_length, 0, 100_000_000)) reasons.push("context");
    else if (endpoint.context_length < options.minContextLength) reasons.push("context");
  }
  if (endpoint.max_completion_tokens !== null && endpoint.max_completion_tokens !== undefined) {
    if (presentButInvalid(endpoint.max_completion_tokens, 0, 100_000_000))
      reasons.push("completion");
    else if (endpoint.max_completion_tokens < options.minMaxCompletionTokens)
      reasons.push("completion");
  }
  if (options.requireToolSupport) {
    const params = Array.isArray(endpoint.supported_parameters)
      ? endpoint.supported_parameters
      : [];
    if (!params.includes("tools") || !params.includes("tool_choice")) reasons.push("tools");
  }
  return reasons;
}

/**
 * One recorded block cause with its threshold and how badly it was missed, so
 * the debug output can show "why" and "by how much" for every blacklisted
 * provider. Persisted with every ranking, so debugBlacklistReasons works on a
 * stored ranking too.
 */
export interface BlacklistReason {
  /** Canonical cause code: uptime, tool-errors, context, completion, status, pricing, tools, not-cheapest, paid, extra-ignore. */
  reason: string;
  /** Human-readable threshold the cause enforces, e.g. "min 90%" or "top 3". */
  threshold: string;
  /**
   * The provider's own value for this cause, when it has one (uptime %, tool
   * error rate %, context length, completion cap or per-request price). The
   * best value across the provider's endpoints, i.e. the one that came closest
   * to passing. Absent for causes with no number (status, pricing, tools,
   * extra-ignore).
   */
  value?: number;
  /**
   * How far past the threshold the value is, clamped to 0..1: 0 is a hair's
   * miss, 1 the worst possible (or a cause with no measurable miss). Persists
   * so the debug output can order providers from the closest miss to the
   * hardest failure without re-ranking.
   */
  magnitude: number;
}

/** Human-readable threshold for a block cause, shown in parentheses in debug output. */
export function reasonThreshold(reason: string, options: OptimizerOptions): string {
  switch (reason) {
    case "uptime":
      return `min ${options.minUptimePercent}%`;
    case "tool-errors":
      return `max ${options.maxToolCallErrorRate}%`;
    case "context":
      return `min ${options.minContextLength}`;
    case "completion":
      return `min ${options.minMaxCompletionTokens}`;
    case "status":
      return "endpoint serving";
    case "pricing":
      return "parseable price";
    case "tools":
      return "tools + tool_choice";
    case "not-cheapest":
      return `top ${Math.max(options.topN, options.keepAtLeastN)}`;
    case "paid":
      return "$0";
    case "extra-ignore":
      return "user blacklist";
    default:
      return "unknown";
  }
}

/**
 * The endpoint's own numbers for the causes it failed, so the debug output can
 * show how close each provider came to passing. A failure caused by unusable
 * evidence (a null, non-finite or out-of-range value) records no value: there
 * is nothing honest to show.
 */
function reasonValues(
  endpoint: OpenRouterEndpoint,
  reasons: string[],
): Record<string, number | undefined> {
  const values: Record<string, number | undefined> = {};
  for (const reason of reasons) {
    switch (reason) {
      case "uptime":
        // The same decision the filter made: invalid evidence fails closed and
        // shows no value; a real number below the floor shows the number.
        values[reason] =
          presentButInvalid(endpoint.uptime_last_30m, 0, 100) ||
          presentButInvalid(endpoint.uptime_last_1d, 0, 100)
            ? undefined
            : (finiteIn(endpoint.uptime_last_30m, 0, 100) ??
              finiteIn(endpoint.uptime_last_1d, 0, 100));
        break;
      case "tool-errors": {
        const rate = endpoint.toolCallErrorRate;
        values[reason] =
          rate !== undefined && finiteIn(rate, 0, 100) !== undefined ? rate : undefined;
        break;
      }
      case "context":
        values[reason] =
          endpoint.context_length !== null && endpoint.context_length !== undefined
            ? (finiteIn(endpoint.context_length, 0, 100_000_000) ?? undefined)
            : undefined;
        break;
      case "completion":
        values[reason] =
          endpoint.max_completion_tokens !== null && endpoint.max_completion_tokens !== undefined
            ? (finiteIn(endpoint.max_completion_tokens, 0, 100_000_000) ?? undefined)
            : undefined;
        break;
      default:
        values[reason] = undefined;
    }
  }
  return values;
}

/**
 * How far past its threshold a recorded cause is, on the same 0..1 scale as
 * failureMagnitude so the debug ordering reads like the rescue ordering: lower
 * is a closer miss. A cause with no usable value fails closed at 1. The price
 * causes measure the miss against the per-request cost of the providers that
 * stood (a hair above the cut-off is a near-miss, ten times it is a hard fail);
 * "paid" is always a full miss against the $0 requirement.
 */
function reasonMagnitude(
  reason: string,
  value: number | undefined,
  options: OptimizerOptions,
  priceCutoff: number | undefined,
): number {
  const ratio = (missing: number, span: number): number =>
    Math.min(1, Math.max(0, missing / Math.max(span, 1)));
  switch (reason) {
    case "uptime":
      // A usable number below the floor misses by the share of the floor it is
      // short; unusable evidence fails closed at a full miss.
      return value === undefined
        ? 1
        : ratio(options.minUptimePercent - value, options.minUptimePercent);
    case "tool-errors":
      // The cap is a maximum, so the miss is measured against the headroom
      // above it, the way failureMagnitude does.
      return value === undefined
        ? 1
        : ratio(value - options.maxToolCallErrorRate, 100 - options.maxToolCallErrorRate);
    case "context":
      return value === undefined
        ? 1
        : ratio(options.minContextLength - value, options.minContextLength);
    case "completion":
      return value === undefined
        ? 1
        : ratio(options.minMaxCompletionTokens - value, options.minMaxCompletionTokens);
    case "not-cheapest":
      // Relative miss: just above the price cut-off is a hair's miss, many
      // times it is a hard failure. The cut-off is the price of the providers
      // that stood; without one the cause is a full miss.
      return value === undefined || priceCutoff === undefined || priceCutoff <= 0
        ? 1
        : Math.min(1, Math.max(0, (value - priceCutoff) / priceCutoff));
    default:
      return 1;
  }
}

/**
 * Debug-only severity for a provider's recorded block causes, mirroring
 * filterSeverity's weighting: lower means the provider missed its thresholds by
 * less, so the debug output sorts "closest miss" first.
 */
export function blacklistMissSeverity(reasons: BlacklistReason[]): number {
  let severity = 0;
  for (const entry of reasons) severity += (FAILURE_WEIGHTS[entry.reason] ?? 20) * entry.magnitude;
  return severity;
}

/** Debug display for a recorded cause value: percents show %, prices show $. */
export function formatBlacklistValue(reason: string, value: number): string {
  if (reason === "uptime" || reason === "tool-errors") {
    // Two decimals at most, trailing zeros dropped: 1.04%, not 1.0445729%.
    const rounded = Number(value.toFixed(2));
    return `${rounded}%`;
  }
  if (reason === "not-cheapest" || reason === "paid") return `$${value.toFixed(6)}`;
  return String(value);
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

/**
 * Why the ranking looks the way it does. "bypassed" means the model has
 * exactly one provider: no test ran at all and the request goes out
 * unmodified.
 */
export type RankingMode = "free" | "cheapest" | "bypassed";

export interface Ranking {
  mode: RankingMode;
  rankings: ProviderRank[];
  survivors: string[];
  blacklist: string[];
  /**
   * slug -> why it was blacklisted, one entry per cause with the threshold it
   * enforces, the provider's own value for it (when there is one) and how far
   * past the threshold that value is. Always built: reasons are stored with
   * every ranking, so turning the debug option on later works immediately
   * instead of showing nothing until the next re-rank.
   */
  blacklistReasons?: Record<string, BlacklistReason[]>;
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
 * The bypass ranking for a model served by exactly one provider. No test can
 * change which provider serves the model, so none are run: the endpoint
 * filters, free-mode blacklisting, the rescue floor and the tool call error
 * rate probe are all skipped, and the request goes out unmodified.
 *
 * The rank entry reports the cheapest alias with known pricing (what a price
 * sort would pick first if one were injected), so the debug output and the
 * persisted ranking stay honest about cost. When no alias carries parseable
 * pricing there is no honest price to report and the entry carries Infinity
 * instead of a made-up number; the request is unaffected either way. The
 * blacklist is empty: nothing is enforced, nothing is injected.
 */
function bypassRanking(
  slug: string,
  endpoints: OpenRouterEndpoint[],
  profile: RequestProfile,
  now: number,
): Ranking {
  const providerEndpoints: OpenRouterEndpoint[] = [];
  for (const endpoint of endpoints.slice(0, MAX_ENDPOINTS)) {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
    if (providerSlug(endpoint) === slug) providerEndpoints.push(endpoint);
  }
  // The slug came from the payload, so this cannot be empty.
  let routed = providerEndpoints[0];
  let perRequest = Number.POSITIVE_INFINITY;
  for (const endpoint of providerEndpoints) {
    if (!hasKnownPricing(endpoint.pricing, profile.avgInput)) continue;
    const { perRequest: cost } = requestCost(endpoint.pricing, profile);
    if (cost < perRequest) {
      perRequest = cost;
      routed = endpoint;
    }
  }
  const slugUptime = routed.uptime_last_30m ?? routed.uptime_last_1d ?? 100;
  const rankings: ProviderRank[] = [
    {
      slug,
      endpoint: routed,
      slugUptime,
      perRequest,
      total: totalCost(perRequest, profile.numRequests),
      rank: 1,
    },
  ];
  return {
    mode: "bypassed",
    rankings,
    survivors: [slug],
    blacklist: [],
    // No provider is blocked, so there are no causes to record.
    blacklistReasons: Object.create(null) as Record<string, BlacklistReason[]>,
    rescued: [],
    profile,
    computedAt: now,
  };
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
  // Bypass: exactly one provider serves the model (and the user did not
  // blacklist it in extraIgnore), so no test can change the routing and none
  // are run. The request goes out completely unmodified; the tool call error
  // rate probe is never sent (the refresh task skips it on the same signal).
  // The routing is still recorded so restarts and later requests behave the
  // same. A sole provider listed in extraIgnore is not bypassed: that list is
  // an explicit instruction, and it survives the bypass decision untouched.
  const soleProvider = singleProviderSlug(endpoints);
  if (soleProvider !== undefined && !options.extraIgnore.includes(soleProvider)) {
    return bypassRanking(soleProvider, endpoints, profile, now);
  }

  // slug -> block causes. Always built: the payload is tiny, and persisting it with
  // every ranking is what makes debugBlacklistReasons useful on a stored ranking.
  const reasonMap = new Map<string, Set<string>>();
  // slug -> cause -> the provider's best (closest-to-passing) value for that
  // cause across its endpoints: a provider whose aliases failed with 40% and
  // 85% uptime shows the 85%, the alias that nearly made it.
  const valueMap = new Map<string, Map<string, number>>();
  const addReason = (slug: string, reason: string, value?: number) => {
    const existing = reasonMap.get(slug);
    if (existing) existing.add(reason);
    else reasonMap.set(slug, new Set([reason]));
    if (value === undefined || !Number.isFinite(value)) return;
    const values = valueMap.get(slug) ?? new Map<string, number>();
    valueMap.set(slug, values);
    const current = values.get(reason);
    // For uptime/context/completion bigger is closer to passing; for the
    // tool-error cap and the per-request price smaller is.
    if (current === undefined) values.set(reason, value);
    else if (reason === "uptime" || reason === "context" || reason === "completion")
      values.set(reason, Math.max(current, value));
    else values.set(reason, Math.min(current, value));
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
  for (const endpoint of endpoints.slice(0, MAX_ENDPOINTS)) {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
    const slug = providerSlug(endpoint);
    if (!slug) continue;
    const filterReasons = filterEndpoint(endpoint, options);
    if (filterReasons.length > 0) {
      filteredSlugs.add(slug);
      const endpointValues = reasonValues(endpoint, filterReasons);
      for (const filterReason of filterReasons) {
        addReason(slug, filterReason, endpointValues[filterReason]);
      }
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
      const severity = (value: number): number =>
        Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
      if (severity(a.failure.severity) !== severity(b.failure.severity)) {
        return severity(a.failure.severity) - severity(b.failure.severity);
      }
      if (a.failure.reasons.length !== b.failure.reasons.length) {
        return a.failure.reasons.length - b.failure.reasons.length;
      }
      const cost =
        requestCost(a.failure.endpoint.pricing, profile).perRequest -
        requestCost(b.failure.endpoint.pricing, profile).perRequest;
      if (Number.isFinite(cost) && cost !== 0) return cost;
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
  const blacklistFull =
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
  // Enforce a hard ceiling: a hostile payload can never balloon the ignore list.
  const blacklist = blacklistFull.filter((slug) => SLUG_PATTERN.test(slug)).slice(0, 512);

  // Ranked-but-not-surviving slugs are blocked by price (topN in cheapest mode,
  // paid-in-free-mode otherwise); extraIgnore is the user's explicit instruction.
  // The price cause carries the provider's per-request cost as its value: how
  // far above the price cut-off it sits is what "not-cheapest" means here.
  const priceReason = freeMode ? "paid" : "not-cheapest";
  for (const { endpoint, slug } of eligible) {
    if (!survivorSet.has(slug))
      addReason(slug, priceReason, requestCost(endpoint.pricing, profile).perRequest);
  }
  for (const slug of options.extraIgnore) {
    addReason(slug, "extra-ignore");
  }
  // Keep the blacklist's order and only include slugs that are actually blocked:
  // a slug can carry filter + price + extraIgnore reasons at once. Each cause is
  // persisted with its threshold, the provider's own value and how far past the
  // threshold that value is, so the debug output can show what was missed and by
  // how much on any stored ranking.
  const priceCutoff = standing.length > 0 ? standing[standing.length - 1].perRequest : undefined;
  const blacklistReasons: Record<string, BlacklistReason[]> = Object.create(null) as Record<
    string,
    BlacklistReason[]
  >;
  for (const slug of blacklist) {
    if (slug === "__proto__") continue;
    const reasons = reasonMap.get(slug);
    if (!reasons || reasons.size === 0) continue;
    const values = valueMap.get(slug);
    const entries: BlacklistReason[] = [...reasons]
      .slice(0, 32)
      .map((reason) => {
        const value = values?.get(reason);
        return value === undefined
          ? {
              reason,
              threshold: reasonThreshold(reason, options),
              magnitude: reasonMagnitude(reason, undefined, options, priceCutoff),
            }
          : {
              reason,
              threshold: reasonThreshold(reason, options),
              value,
              magnitude: reasonMagnitude(reason, value, options, priceCutoff),
            };
      })
      // Closest miss first: the causes a provider almost passed lead its entry
      // and the hardest failure trails, so the strictest of the user's filters
      // is easy to spot when debugging.
      .sort((a, b) => a.magnitude - b.magnitude || (a.reason < b.reason ? -1 : 1));
    blacklistReasons[slug] = entries;
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
