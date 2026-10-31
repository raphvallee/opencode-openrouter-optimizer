/** Wiring: http.request interception, background refresh, stats collection. */

import { Plugin } from "@opencode/plugin"
import { DEFAULT_OPTIONS, resolveOptions, type OptimizerOptions } from "./config"
import { OptimizerDb, routingStateFromRow, type RoutingSnapshot, type RoutingState } from "./db"
import { fetchModelEndpoints, fetchOpenRouterProfile, baseModelSlug } from "./openrouter"
import { composeRouting, rankProviders, type ProviderRank } from "./ranking"
import { mergeProfile, OpenCodeStats, type LocalProfile } from "./stats"

interface HttpEventLike {
  request?: Request
  model?: { providerID?: string; modelID?: string }
}

const LOG_PREFIX = "[openrouter-optimizer]"

/** Failure backoff: 30s doubling to 1h, with 50-100% jitter. */
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 3_600_000

function backoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10)
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent)
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

function emptyState(model: string): RoutingState {
  return {
    model,
    lastFetched: null,
    lastAttempt: null,
    attempts: 0,
    retryAfter: null,
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export function definePlugin(overrides: Partial<OptimizerOptions> = {}) {
  return Plugin.define({
    id: "openrouter-optimizer",
    async setup(ctx) {
      const options = resolveOptions({
        ...DEFAULT_OPTIONS,
        ...overrides,
        ...((ctx.options ?? {}) as Record<string, unknown>),
      })
      const debug = (...parts: unknown[]) => {
        if (options.debug) console.log(LOG_PREFIX, ...parts)
      }
      const warn = (...parts: unknown[]) => console.warn(LOG_PREFIX, ...parts)

      const db = new OptimizerDb(options.dbPath)
      const ttlMs = options.ttlHours * 3_600_000
      const inflight = new Map<string, Promise<void>>()
      const controller = new AbortController()
      let statsWarned = false
      const stats = new OpenCodeStats({
        command: options.statsCommand,
        days: options.statsDays,
        ttlMs: options.statsCacheMinutes * 60_000,
        run: options.statsRun,
        // A broken stats CLI silently degrades every profile to fallbacks, which can
        // rank the wrong providers cheapest. The first failure is therefore a real
        // warning; repeats stay quiet (debug) until the process restarts.
        log: (message) => {
          if (statsWarned) {
            debug(message)
            return
          }
          statsWarned = true
          warn(`opencode stats unavailable, ranking falls back to defaults until it recovers: ${message}`)
        },
      })

      // Read per refresh: the key may be exported after the plugin loaded.
      const managementKey = () => process.env[options.managementKeyEnv]

      // One-time notices per model: a ranking with zero survivors passes requests
      // through unrouted, which must not be invisible.
      const unroutedWarned = new Set<string>()

      // Hot path state: warm the cache once, then every request is a map lookup.
      // The DB stays durable; another process may refresh behind us, which is bounded
      // by the same TTL the routing decisions already use.
      const routes = new Map<string, RoutingState>()
      // Bases of models whose stored routing came in under a variant key: when the
      // event ref has no ranking of its own, the request body may name such a variant.
      const routedVariantBase = new Set<string>()
      for (const state of db.loadRoutingStates(options.debug)) {
        routes.set(state.model, state)
        if (state.routing && state.routing.blacklist.length > 0) routedVariantBase.add(baseModelSlug(state.model))
      }

      /** Resolve one model's state, reading the DB at most once per process. */
      function stateFor(model: string, now: number): RoutingState {
        const cached = routes.get(model)
        if (cached) return cached
        const state = routingStateFromRow(db.ensureFetchRow(model, now), options.debug)
        routes.set(model, state)
        return state
      }

      /** Build the merged request profile: OpenCode stats CLI + OpenRouter activity (+ fallbacks). */
      async function buildProfile(model: string) {
        // Both sources run concurrently in the background task; both snapshots are
        // cached and single-flighted across models.
        const key = managementKey()
        const [statsResult, remoteResult] = await Promise.allSettled([
          stats.get(),
          key ? fetchOpenRouterProfile(model, key, { signal: controller.signal }) : Promise.resolve(undefined),
        ])
        let local: LocalProfile | undefined
        if (statsResult.status === "fulfilled") local = stats.pick(model)
        let remote
        if (key) {
          if (remoteResult.status === "fulfilled") remote = remoteResult.value
          else {
            warn(`activity fetch failed for ${model}:`, remoteResult.reason instanceof Error ? remoteResult.reason.message : remoteResult.reason)
          }
        }
        return mergeProfile(local, remote, {
          avgInput: options.fallbackAvgInput,
          avgOutput: options.fallbackAvgOutput,
          cacheHitRate: options.fallbackCacheHitRate,
        })
      }

      async function refreshModel(model: string): Promise<void> {
        try {
          debug("refreshing", model)
          // Endpoint prices and the request profile are independent: start both now.
          const [endpoints, profile] = await Promise.all([
            fetchModelEndpoints(model, { signal: controller.signal }),
            buildProfile(model),
          ])
          const ranking = rankProviders(endpoints.endpoints, profile, options)
          const now = Date.now()
          const routing: RoutingSnapshot = {
            survivors: ranking.survivors,
            blacklist: ranking.blacklist,
            computedAt: ranking.computedAt,
            mode: ranking.mode,
          }
          // One write per refresh. Full rankings are debug-only payload.
          db.saveRefresh(model, routing, now, options.debug ? ranking.rankings : undefined)

          const state = routes.get(model) ?? emptyState(model)
          state.lastFetched = now
          state.lastAttempt = now
          state.attempts = 0
          state.retryAfter = null
          state.routing = routing
          if (options.debug) state.details = ranking.rankings
          routes.set(model, state)
          // Track routed bases so variant-suffixed request bodies can find their
          // routing even when the event ref itself has no ranking yet.
          if (routing.survivors.length === 0 && routing.blacklist.length === 0) {
            // Nothing is enforced and requests pass through unrouted; make that
            // visible once per model per process instead of debug-only.
            if (!unroutedWarned.has(model)) {
              unroutedWarned.add(model)
              warn(`${model}: no endpoint passed the filters, requests pass through unrouted`)
            }
          } else {
            routedVariantBase.add(baseModelSlug(model))
          }

          debug(
            `ranked ${model} (${routing.mode}): top ${routing.survivors.length} = [${routing.survivors.join(", ")}]`,
            `blacklist size ${routing.blacklist.length}`,
          )
        } catch (error) {
          // A shutdown abort cancels the refresh; it is not a refresh failure and the
          // DB may already be closing, so skip failure bookkeeping entirely.
          if (controller.signal.aborted || isAbortError(error)) return
          const failedAt = Date.now()
          const state = routes.get(model) ?? emptyState(model)
          state.attempts += 1
          state.lastAttempt = failedAt
          state.retryAfter = failedAt + backoffMs(state.attempts)
          routes.set(model, state)
          try {
            db.recordFailure(model, failedAt, state.retryAfter)
            // Other processes record failures into the same row; the DB is the
            // shared truth for the attempt count that drives backoff duration.
            const row = db.getFetch(model)
            if (row) {
              state.attempts = row.attempts
              state.lastAttempt = row.last_attempt ?? failedAt
              state.retryAfter = row.retry_after ?? state.retryAfter
            }
          } catch (dbError) {
            warn(`failure bookkeeping failed for ${model}:`, dbError instanceof Error ? dbError.message : dbError)
          }
          warn(`refresh failed for ${model}:`, error instanceof Error ? error.message : error)
        }
      }

      /** Lazy, never-blocking refresh trigger. Single-flight per model, with backoff. */
      function ensureFresh(state: RoutingState, now: number): void {
        const model = state.model
        if (inflight.has(model)) return
        const fresh = state.lastFetched !== null && now - state.lastFetched <= ttlMs
        if (fresh) return
        if (state.retryAfter !== null && now < state.retryAfter) return
        const task = refreshModel(model).finally(() => inflight.delete(model))
        // refreshModel handles its own errors, but its failure bookkeeping can still
        // reject (locked/closed DB): never leave an unhandled rejection behind.
        task.catch(() => {})
        inflight.set(model, task)
        void task
      }

      /** Route one model for debug output: only evaluated when debug is enabled. */
      function logRouting(model: string, state: RoutingState | undefined): void {
        if (!options.debug) return
        const routing = state?.routing
        if (!routing) {
          debug(`routing ${model}: no ranking yet, passing through`)
          return
        }
        if (routing.blacklist.length === 0) {
          debug(`routing ${model}: nothing to block, passing through`)
          return
        }
        const allowed = new Set(routing.survivors)
        const details = state?.details as ProviderRank[] | undefined
        const selected = details
          ? details
              .filter((entry) => entry && allowed.has(entry.slug))
              .map((entry) => `${entry.slug} ($${Number(entry.perRequest ?? 0).toFixed(6)})`)
          : routing.survivors
        debug(
          `routing ${model} (${routing.mode ?? "cheapest"}): keeping ${selected.length} = [${selected.join(", ")}]`,
          `blocking ${routing.blacklist.length}`,
        )
      }

      /** The full routing pass for one request; throws bubble to the hook guard below. */
      async function routeRequest(evt: HttpEventLike): Promise<void> {
        const request = evt.request
        if (!request) return
        const url = request.url ?? ""
        const providerID = evt.model?.providerID
        if (request.method !== "POST") return
        if (!/openrouter\.ai/.test(url) && providerID !== "openrouter") return

        const now = Date.now()
        const refModel = typeof evt.model?.modelID === "string" ? evt.model.modelID : ""

        // Fast path: the event already names the model. If it was ranked and has no
        // blacklist, there is nothing to inject, so the request body is never read,
        // parsed or rebuilt.
        let state: RoutingState | undefined
        if (refModel) {
          state = stateFor(refModel, now)
          ensureFresh(state, now)
          const refRouting = state.routing
          if (refRouting && refRouting.blacklist.length === 0) {
            logRouting(refModel, state)
            return
          }
          if (!refRouting) {
            logRouting(refModel, state)
            // No ranking yet. The body may name a variant of this model that carries
            // its own routing; keep inspecting for those, pass the rest through.
            if (!routedVariantBase.has(baseModelSlug(refModel))) return
          }
        }

        // The body is a one-shot stream. Inspect a clone so an untouched request keeps
        // its original body; only a real routing change needs a replacement Request.
        let raw: string
        try {
          raw = await request.clone().text()
        } catch (error) {
          warn("request body unreadable:", error instanceof Error ? error.message : error)
          return
        }

        let body: unknown
        let model = ""
        try {
          body = JSON.parse(raw) as { model?: unknown }
          model = typeof (body as { model?: unknown }).model === "string" ? ((body as { model?: string }).model ?? "") : ""
        } catch {
          // A non-JSON body cannot carry routing. Leave the original request untouched.
          return
        }

        if (typeof body !== "object" || body === null || !model.includes("/")) return

        if (model !== refModel) {
          state = stateFor(model, now)
          ensureFresh(state, now)
        }
        const routing = state?.routing
        if (!routing || routing.blacklist.length === 0) {
          logRouting(model, state)
          return
        }

        logRouting(model, state)
        const mutated = body as Record<string, unknown>
        mutated.provider = composeRouting(mutated.provider, routing.blacklist, options)

        const finalBody = JSON.stringify(mutated)
        const headers = new Headers(request.headers)
        headers.delete("content-length")
        try {
          evt.request = new Request(request.url, {
            method: request.method,
            headers,
            body: finalBody,
            signal: request.signal,
          })
        } catch (error) {
          warn("request rebuild failed:", error instanceof Error ? error.message : error)
          return
        }
      }

      await ctx.session.hook("http.request", async (event) => {
        const evt = event as unknown as HttpEventLike
        // Any hook error is caught and the request continues unmodified: a DB hiccup
        // (SQLITE_BUSY, closed DB) must never fail or stall a user request.
        try {
          await routeRequest(evt)
        } catch (error) {
          warn("routing skipped, request passes through:", error instanceof Error ? error.message : error)
        }
      })

      return async () => {
        controller.abort()
        const pending = [...inflight.values()]
        inflight.clear()
        // Wait for in-flight refreshes so their failure bookkeeping never races the
        // DB close below (aborted refreshes are not recorded as failures).
        await Promise.allSettled(pending)
        routes.clear()
        db.close()
      }
    },
  })
}
