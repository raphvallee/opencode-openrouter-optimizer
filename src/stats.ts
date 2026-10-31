/**
 * OpenCode-side usage source (the documented `opencode stats --json` CLI) and the
 * hybrid merge with OpenRouter Activity API rows.
 *
 * `opencode stats --json --models` rows look like:
 *   { "model": { "id": "z-ai/glm-5.3-flash", "providerID": "openrouter", "variant": "high" },
 *     "steps": 6335,
 *     "tokens": { "input": ..., "output": ..., "reasoning": ..., "cache": { "read": ..., "write": ... } } }
 *
 * Variants of the same base slug are summed into one profile. The stats process only
 * ever runs inside the background refresh task: the request path reads precomputed
 * rankings from the DB and never waits on it.
 */

import { normalizeModelKey } from "./db"
import type { RequestProfile } from "./pricing"

export { normalizeModelKey } from "./db"

export interface LocalProfile {
  requests: number
  totalInput: number
  cachedInput: number
  totalOutput: number
}

interface StatsModelRow {
  model?: { id?: unknown }
  steps?: unknown
  tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
}

function num(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0
}

/** Parse `opencode stats --json --models` output into per-normalized-key profiles. */
export function parseStatsModels(json: string): Map<string, LocalProfile> {
  const profiles = new Map<string, LocalProfile>()
  let models: unknown
  try {
    models = (JSON.parse(json) as { models?: unknown })?.models
  } catch {
    return profiles
  }
  if (!Array.isArray(models)) return profiles
  for (const row of models as StatsModelRow[]) {
    const id = typeof row?.model?.id === "string" ? row.model.id : undefined
    if (!id) continue
    const tokens = row.tokens ?? {}
    const key = normalizeModelKey(id)
    const steps = num(row.steps)
    // A row without a usable steps count has no request to attribute tokens to;
    // accumulating its tokens anyway would skew the per-request averages.
    if (steps <= 0) continue
    const profile = profiles.get(key) ?? { requests: 0, totalInput: 0, cachedInput: 0, totalOutput: 0 }
    // Same best-effort semantics as before: input excludes cache buckets, so total
    // input is input + read + write; cache.read is the cached portion.
    profile.requests += steps
    profile.totalInput += num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write)
    profile.cachedInput += num(tokens.cache?.read)
    profile.totalOutput += num(tokens.output) + num(tokens.reasoning)
    profiles.set(key, profile)
  }
  return profiles
}

/** Precomputed lookup: exact key plus every profile sharing each model suffix. */
export interface ProfileIndex {
  exact: Map<string, LocalProfile>
  bySuffix: Map<string, Array<[string, LocalProfile]>>
}

export function buildProfileIndex(profiles: Map<string, LocalProfile>): ProfileIndex {
  const exact = new Map<string, LocalProfile>()
  const bySuffix = new Map<string, Array<[string, LocalProfile]>>()
  for (const [key, profile] of profiles) {
    exact.set(key, profile)
    const suffix = key.split("/").pop() ?? key
    const bucket = bySuffix.get(suffix)
    if (bucket) bucket.push([key, profile])
    else bySuffix.set(suffix, [[key, profile]])
  }
  return { exact, bySuffix }
}

function mergeInto(target: LocalProfile, source: LocalProfile): void {
  target.requests += source.requests
  target.totalInput += source.totalInput
  target.cachedInput += source.cachedInput
  target.totalOutput += source.totalOutput
}

/** One model's profile out of a prebuilt index: exact key or identical suffix match. */
export function pickProfileFromIndex(index: ProfileIndex, slug: string): LocalProfile | undefined {
  const target = normalizeModelKey((slug ?? "").trim())
  const suffix = target.split("/").pop() ?? target
  let merged: LocalProfile | undefined
  const exact = index.exact.get(target)
  if (exact) {
    merged = { requests: 0, totalInput: 0, cachedInput: 0, totalOutput: 0 }
    mergeInto(merged, exact)
  }
  for (const [key, profile] of index.bySuffix.get(suffix) ?? []) {
    if (key === target) continue
    if (!merged) merged = { requests: 0, totalInput: 0, cachedInput: 0, totalOutput: 0 }
    mergeInto(merged, profile)
  }
  return merged
}

/** One-shot convenience wrapper; the plugin reuses OpenCodeStats.pick instead. */
export function pickProfile(profiles: Map<string, LocalProfile>, slug: string): LocalProfile | undefined {
  return pickProfileFromIndex(buildProfileIndex(profiles), slug)
}

export interface OpenCodeStatsOptions {
  /** Command used for `opencode stats`. */
  command?: string
  /** Stats window in days, aligned with the OpenRouter Activity 30-day aggregate. */
  days?: number
  /** Snapshot cache lifetime in milliseconds. */
  ttlMs?: number
  /** Injectable command runner (tests). */
  run?: (args: string[]) => Promise<string>
  log?: (message: string) => void
}

/**
 * Cached, single-flight access to OpenCode's own stats CLI. Concurrent callers share
 * one process and one snapshot for `ttlMs`; never throws, so a missing or broken CLI
 * degrades to "no local data" and the merge falls back to the OpenRouter side.
 */
export class OpenCodeStats {
  private readonly command: string
  private readonly days: number
  private readonly ttlMs: number
  private readonly run: (args: string[]) => Promise<string>
  private readonly log: (message: string) => void
  private cached: Map<string, LocalProfile> | undefined
  private index: ProfileIndex = buildProfileIndex(new Map())
  private fetchedAt = 0
  private inflight: Promise<Map<string, LocalProfile>> | undefined

  constructor(options: OpenCodeStatsOptions = {}) {
    this.command = options.command?.trim() || "opencode"
    this.days = Math.max(1, Math.round(options.days ?? 30))
    this.ttlMs = Math.max(0, options.ttlMs ?? 10 * 60_000)
    this.run = options.run ?? defaultRun
    this.log = options.log ?? (() => {})
  }

  /** Profiles for every model OpenCode has served; cached per TTL, one process at a time. */
  async get(): Promise<Map<string, LocalProfile>> {
    if (this.cached && Date.now() - this.fetchedAt < this.ttlMs) return this.cached
    // A failed first fetch is held for the TTL too: without this, every get() would
    // respawn the CLI per model refresh while still returning nothing useful.
    if (!this.cached && this.fetchedAt !== 0 && Date.now() - this.fetchedAt < this.ttlMs) {
      return new Map<string, LocalProfile>()
    }
    if (!this.inflight) {
      this.inflight = this.fetchAll()
        .then((profiles) => {
          this.cached = profiles
          this.index = buildProfileIndex(profiles)
          this.fetchedAt = Date.now()
          return profiles
        })
        .catch((error) => {
          this.log(`opencode stats fetch failed: ${error instanceof Error ? error.message : String(error)}`)
          this.fetchedAt = Date.now()
          return this.cached ?? new Map<string, LocalProfile>()
        })
        .finally(() => {
          this.inflight = undefined
        })
    }
    return this.inflight
  }

  /** Force a refetch on the next get(); the last snapshot stays as failure fallback. */
  invalidate(): void {
    this.fetchedAt = 0
  }

  /** Lookup against the cached suffix index, avoiding a full scan per model refresh. */
  pick(slug: string): LocalProfile | undefined {
    return pickProfileFromIndex(this.index, slug)
  }

  private async fetchAll(): Promise<Map<string, LocalProfile>> {
    // A large --limit keeps the models section from being truncated.
    const args = [this.command, "stats", "--json", "--models", "--days", String(this.days), "--limit", "1000"]
    return parseStatsModels(await this.run(args))
  }
}

async function defaultRun(args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: args, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 60_000)
  try {
    // Drain both pipes concurrently. An unread stderr can fill the OS buffer and
    // block the child until the timeout kills it.
    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) {
      const detail = stderr.trim()
      throw new Error(`opencode stats exited with code ${code}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
    }
    return output
  } finally {
    clearTimeout(timer)
  }
}

export function mergeProfile(
  local: LocalProfile | undefined,
  openrouter: { requests: number; promptTokens: number; completionTokens: number; cachedTokens: number } | undefined,
  fallbacks: { avgInput: number; avgOutput: number; cacheHitRate: number },
  /** Optional debug sink; the plugin passes its debug-gated logger. */
  log?: (message: string, data: Record<string, number>) => void,
): RequestProfile {
  const localRequests = local?.requests ?? 0
  const remoteRequests = openrouter?.requests ?? 0
  const requests = localRequests + remoteRequests

  if (requests === 0) {
    return {
      avgInput: fallbacks.avgInput,
      avgOutput: fallbacks.avgOutput,
      cacheHitRate: fallbacks.cacheHitRate,
      numRequests: 0,
    }
  }

  const localInput = local?.totalInput ?? 0
  const localCached = local?.cachedInput ?? 0
  const localOutput = local?.totalOutput ?? 0
  const remoteInput = openrouter?.promptTokens ?? 0
  const remoteCached = openrouter?.cachedTokens ?? 0
  const remoteOutput = openrouter?.completionTokens ?? 0

  const totalInput = localInput + remoteInput
  const totalOutput = localOutput + remoteOutput
  // Both averages fall back when their side has no measured tokens: cushioning one
  // side but not the other would collapse just the input (or output) cost estimate.
  const avgInput = totalInput > 0 ? totalInput / requests : fallbacks.avgInput
  const avgOutput = totalOutput > 0 ? totalOutput / requests : fallbacks.avgOutput
  const cacheHitRate = totalInput > 0 ? Math.min(1, Math.max(0, (localCached + remoteCached) / totalInput)) : fallbacks.cacheHitRate

  log?.("[openrouter-optimizer] recalculated average profile", {
    cacheHitRate,
    avgInputTokensPerRequest: avgInput,
    avgOutputTokensPerRequest: avgOutput,
  })

  return {
    avgInput,
    avgOutput,
    cacheHitRate,
    numRequests: requests,
  }
}
