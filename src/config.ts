/** Plugin configuration resolved from opencode.json plugin options plus sane defaults. */

export interface OptimizerOptions {
  /** Re-fetch prices + re-rank when last_fetched is older than this many hours. */
  ttlHours: number
  /** Number of cheapest providers allowed through. */
  topN: number
  /** Endpoint filters. */
  minContextLength: number
  minMaxCompletionTokens: number
  minUptimePercent: number
  requireToolSupport: boolean
  /**
   * Endpoint filter on OpenRouter's Tool Call Error Rate (percent of tool-calling
   * requests per provider that produced at least one invalid tool call, volume-
   * weighted over the trailing week). Endpoints above the cap are filtered out and
   * blacklisted like other filter failures. 100 disables the filter.
   */
  maxToolCallErrorRate: number
  /** Add `provider.sort: "price"` so OpenRouter picks the cheapest survivor. */
  injectSort: boolean
  /**
   * Max time a request waits for its first ranking. Waiting keeps the whole session on
   * one provider's cache, so a provider switch does not pay the cache-write charge twice.
   * A failed or slow refresh releases the request unmodified. 0 disables waiting.
   */
  rankingWaitMs: number
  /** Fallbacks until real stats exist for a model. */
  fallbackAvgInput: number
  fallbackAvgOutput: number
  fallbackCacheHitRate: number
  /**
   * When any surviving provider serves the model at $0 (input and output) and the slug
   * is not a ":free" variant, switch to free mode: keep every free provider routable
   * (topN does not cap them) and blacklist the paid providers.
   */
  preferFreeProviders: boolean
  /** Extra provider slugs that are always blacklisted (e.g. "chutes"). */
  extraIgnore: string[]
  /** Env var name for the OpenRouter management key (Activity API). */
  managementKeyEnv: string
  /**
   * Command used to read OpenCode's own usage stats (`<command> stats --json ...`).
   * Runs only inside the refresh task; a first request may wait for that task to finish.
   */
  statsCommand: string
  /** Stats window in days, aligned with the OpenRouter Activity 30-day aggregate. */
  statsDays: number
  /** Stats snapshot cache lifetime in minutes; concurrent refreshes share one snapshot. */
  statsCacheMinutes: number
  /** Test hook: bypass the CLI with a custom command runner. */
  statsRun?: (args: string[]) => Promise<string>
  /** Override the DB file path (mostly for tests). */
  dbPath?: string
  /** Verbose logging. */
  debug: boolean
}

export const DEFAULT_OPTIONS: OptimizerOptions = {
  ttlHours: 6,
  topN: 3,
  minContextLength: 64_000,
  minMaxCompletionTokens: 8_000,
  minUptimePercent: 90,
  requireToolSupport: true,
  maxToolCallErrorRate: 1,
  injectSort: true,
  rankingWaitMs: 15_000,
  fallbackAvgInput: 20_000,
  fallbackAvgOutput: 800,
  fallbackCacheHitRate: 0.2,
  preferFreeProviders: true,
  extraIgnore: [],
  managementKeyEnv: "OPENROUTER_MANAGEMENT_KEY",
  statsCommand: "opencode",
  statsDays: 30,
  statsCacheMinutes: 10,
  statsRun: undefined,
  dbPath: undefined,
  debug: false,
}

function num(input: unknown, fallback: number): number {
  if (typeof input === "string") {
    // "" and "  " coerce to 0 via Number(), which would silently disable filters
    // like minContextLength; a blank string is "unset", not zero.
    const trimmed = input.trim()
    if (trimmed.length === 0) return fallback
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : fallback
}

function bool(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input
  if (input === "true") return true
  if (input === "false") return false
  return fallback
}

function stringList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.filter((value): value is string => typeof value === "string" && value.length > 0)
}

export function resolveOptions(input?: unknown): OptimizerOptions {
  const raw = (input ?? {}) as Record<string, unknown>
  return {
    ttlHours: num(raw.ttlHours, DEFAULT_OPTIONS.ttlHours),
    topN: Math.max(1, num(raw.topN, DEFAULT_OPTIONS.topN)),
    minContextLength: num(raw.minContextLength, DEFAULT_OPTIONS.minContextLength),
    minMaxCompletionTokens: num(raw.minMaxCompletionTokens, DEFAULT_OPTIONS.minMaxCompletionTokens),
    minUptimePercent: num(raw.minUptimePercent, DEFAULT_OPTIONS.minUptimePercent),
    requireToolSupport: bool(raw.requireToolSupport, DEFAULT_OPTIONS.requireToolSupport),
    maxToolCallErrorRate: Math.min(100, num(raw.maxToolCallErrorRate, DEFAULT_OPTIONS.maxToolCallErrorRate)),
    injectSort: bool(raw.injectSort, DEFAULT_OPTIONS.injectSort),
    rankingWaitMs: num(raw.rankingWaitMs, DEFAULT_OPTIONS.rankingWaitMs),
    fallbackAvgInput: num(raw.fallbackAvgInput, DEFAULT_OPTIONS.fallbackAvgInput),
    fallbackAvgOutput: num(raw.fallbackAvgOutput, DEFAULT_OPTIONS.fallbackAvgOutput),
    fallbackCacheHitRate: Math.min(1, num(raw.fallbackCacheHitRate, DEFAULT_OPTIONS.fallbackCacheHitRate)),
    preferFreeProviders: bool(raw.preferFreeProviders, DEFAULT_OPTIONS.preferFreeProviders),
    extraIgnore: stringList(raw.extraIgnore),
    managementKeyEnv: typeof raw.managementKeyEnv === "string" ? raw.managementKeyEnv : DEFAULT_OPTIONS.managementKeyEnv,
    statsCommand:
      typeof raw.statsCommand === "string" && raw.statsCommand.trim().length > 0 ? raw.statsCommand.trim() : DEFAULT_OPTIONS.statsCommand,
    statsDays: Math.max(1, num(raw.statsDays, DEFAULT_OPTIONS.statsDays)),
    statsCacheMinutes: num(raw.statsCacheMinutes, DEFAULT_OPTIONS.statsCacheMinutes),
    statsRun: typeof raw.statsRun === "function" ? (raw.statsRun as (args: string[]) => Promise<string>) : DEFAULT_OPTIONS.statsRun,
    dbPath: typeof raw.dbPath === "string" && raw.dbPath.length > 0 ? raw.dbPath : DEFAULT_OPTIONS.dbPath,
    debug: bool(raw.debug, DEFAULT_OPTIONS.debug),
  }
}
