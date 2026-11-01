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
  /**
   * Disable the TUI part of the plugin (the `./tui` export): no routing-failure
   * toasts are raised. The server routing part is unaffected.
   */
  noTUI: boolean
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
  /**
   * With debug on, also log why every provider in the blacklist was blocked
   * (filter failures, price rank, free mode, extraIgnore). Requires debug.
   */
  debugBlacklistReasons: boolean
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
  noTUI: false,
  extraIgnore: [],
  managementKeyEnv: "OPENROUTER_MANAGEMENT_KEY",
  statsCommand: "opencode",
  statsDays: 30,
  statsCacheMinutes: 10,
  statsRun: undefined,
  dbPath: undefined,
  debug: false,
  debugBlacklistReasons: false,
}

const OPTION_KEYS: ReadonlyArray<keyof OptimizerOptions> = [
  "ttlHours",
  "topN",
  "minContextLength",
  "minMaxCompletionTokens",
  "minUptimePercent",
  "requireToolSupport",
  "maxToolCallErrorRate",
  "injectSort",
  "rankingWaitMs",
  "fallbackAvgInput",
  "fallbackAvgOutput",
  "fallbackCacheHitRate",
  "preferFreeProviders",
  "noTUI",
  "extraIgnore",
  "managementKeyEnv",
  "statsCommand",
  "statsDays",
  "statsCacheMinutes",
  "statsRun",
  "dbPath",
  "debug",
  "debugBlacklistReasons",
]

const VALID_KEYS = new Set<string>(OPTION_KEYS)

function describe(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (Array.isArray(value)) return `an array (length ${value.length})`
  if (typeof value === "object") return "an object"
  return typeof value
}

function invalid(key: string, message: string): never {
  throw new Error(
    `Invalid plugin configuration: option "${key}" ${message}. ` +
      `Fix it in your plugin options (for example opencode.json).`,
  )
}

interface NumberRule {
  min?: number
  max?: number
  integer?: boolean
}

function numberOption(
  raw: Record<string, unknown>,
  key: keyof OptimizerOptions,
  fallback: number,
  rule: NumberRule = {},
): number {
  const value = raw[key]
  if (value === undefined) return fallback
  let parsed: number
  if (typeof value === "number") {
    parsed = value
  } else if (typeof value === "string" && value.trim().length > 0) {
    parsed = Number(value.trim())
  } else {
    return invalid(key, `must be a finite number, got ${describe(value)}`)
  }
  if (!Number.isFinite(parsed)) return invalid(key, `must be a finite number, got ${describe(value)}`)
  if (rule.min !== undefined && parsed < rule.min) {
    return invalid(key, `must be >= ${rule.min}, got ${parsed}`)
  }
  if (rule.max !== undefined && parsed > rule.max) {
    return invalid(key, `must be <= ${rule.max}, got ${parsed}`)
  }
  if (rule.integer && !Number.isInteger(parsed)) {
    return invalid(key, `must be an integer, got ${parsed}`)
  }
  return parsed
}

function booleanOption(raw: Record<string, unknown>, key: keyof OptimizerOptions, fallback: boolean): boolean {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return invalid(key, `must be a boolean (true or false), got ${describe(value)}`)
}

function stringOption(raw: Record<string, unknown>, key: keyof OptimizerOptions, fallback: string): string {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== "string") return invalid(key, `must be a string, got ${describe(value)}`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return invalid(key, "must be a non-empty string")
  return trimmed
}

function optionalStringOption(raw: Record<string, unknown>, key: keyof OptimizerOptions): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") return invalid(key, `must be a string when set, got ${describe(value)}`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return invalid(key, "must be a non-empty string when set")
  return trimmed
}

function optionalFunctionOption(
  raw: Record<string, unknown>,
  key: keyof OptimizerOptions,
): ((args: string[]) => Promise<string>) | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== "function") return invalid(key, `must be a function when set, got ${describe(value)}`)
  return value as (args: string[]) => Promise<string>
}

function listOption(raw: Record<string, unknown>, key: keyof OptimizerOptions): string[] {
  const value = raw[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) return invalid(key, `must be an array of non-empty strings, got ${describe(value)}`)
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return invalid(`${key}[${index}]`, `must be a non-empty string, got ${describe(entry)}`)
    }
    return entry.trim()
  })
}

function validateUnknownKeys(raw: Record<string, unknown>): void {
  const unknown = Object.keys(raw).filter((key) => !VALID_KEYS.has(key))
  if (unknown.length === 0) return
  const details = unknown.map((key) => {
    const suggestion = OPTION_KEYS.find((valid) => valid.toLowerCase() === key.toLowerCase())
    return suggestion ? `"${key}" (did you mean "${suggestion}"?)` : `"${key}"`
  })
  throw new Error(
    `Invalid plugin configuration: unknown option(s) ${details.join(", ")}. ` +
      `Valid options: ${OPTION_KEYS.join(", ")}. Fix it in your plugin options (for example opencode.json).`,
  )
}

export function resolveOptions(input?: unknown): OptimizerOptions {
  if (input === undefined) input = {}
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(
      `Invalid plugin configuration: plugin options must be an object, got ${describe(input)}. ` +
        `Fix it in your plugin options (for example opencode.json).`,
    )
  }
  const raw = input as Record<string, unknown>
  validateUnknownKeys(raw)
  return {
    ttlHours: numberOption(raw, "ttlHours", DEFAULT_OPTIONS.ttlHours, { min: 0 }),
    topN: numberOption(raw, "topN", DEFAULT_OPTIONS.topN, { min: 1, integer: true }),
    minContextLength: numberOption(raw, "minContextLength", DEFAULT_OPTIONS.minContextLength, { min: 0, integer: true }),
    minMaxCompletionTokens: numberOption(raw, "minMaxCompletionTokens", DEFAULT_OPTIONS.minMaxCompletionTokens, {
      min: 0,
      integer: true,
    }),
    minUptimePercent: numberOption(raw, "minUptimePercent", DEFAULT_OPTIONS.minUptimePercent, { min: 0, max: 100 }),
    requireToolSupport: booleanOption(raw, "requireToolSupport", DEFAULT_OPTIONS.requireToolSupport),
    maxToolCallErrorRate: numberOption(raw, "maxToolCallErrorRate", DEFAULT_OPTIONS.maxToolCallErrorRate, {
      min: 0,
      max: 100,
    }),
    injectSort: booleanOption(raw, "injectSort", DEFAULT_OPTIONS.injectSort),
    rankingWaitMs: numberOption(raw, "rankingWaitMs", DEFAULT_OPTIONS.rankingWaitMs, { min: 0, integer: true }),
    fallbackAvgInput: numberOption(raw, "fallbackAvgInput", DEFAULT_OPTIONS.fallbackAvgInput, { min: 0 }),
    fallbackAvgOutput: numberOption(raw, "fallbackAvgOutput", DEFAULT_OPTIONS.fallbackAvgOutput, { min: 0 }),
    fallbackCacheHitRate: numberOption(raw, "fallbackCacheHitRate", DEFAULT_OPTIONS.fallbackCacheHitRate, {
      min: 0,
      max: 1,
    }),
    preferFreeProviders: booleanOption(raw, "preferFreeProviders", DEFAULT_OPTIONS.preferFreeProviders),
    noTUI: booleanOption(raw, "noTUI", DEFAULT_OPTIONS.noTUI),
    extraIgnore: listOption(raw, "extraIgnore"),
    managementKeyEnv: stringOption(raw, "managementKeyEnv", DEFAULT_OPTIONS.managementKeyEnv),
    statsCommand: stringOption(raw, "statsCommand", DEFAULT_OPTIONS.statsCommand),
    statsDays: numberOption(raw, "statsDays", DEFAULT_OPTIONS.statsDays, { min: 1, integer: true }),
    statsCacheMinutes: numberOption(raw, "statsCacheMinutes", DEFAULT_OPTIONS.statsCacheMinutes, { min: 0 }),
    statsRun: optionalFunctionOption(raw, "statsRun"),
    dbPath: optionalStringOption(raw, "dbPath"),
    debug: booleanOption(raw, "debug", DEFAULT_OPTIONS.debug),
    debugBlacklistReasons: booleanOption(raw, "debugBlacklistReasons", DEFAULT_OPTIONS.debugBlacklistReasons),
  }
}
