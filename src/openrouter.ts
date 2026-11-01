/** OpenRouter HTTP clients (endpoints API: public; Activity API: management key). */

import { providerSlug, type OpenRouterEndpoint } from "./ranking"

const BASE_URL = "https://openrouter.ai/api/v1"
const FRONTEND_BASE_URL = "https://openrouter.ai/api/frontend"

export interface EndpointsResponse {
  id: string
  name: string
  endpoints: OpenRouterEndpoint[]
}

/** Activity rows from GET /api/v1/activity (last 30 completed UTC days). */
export interface ActivityRow {
  date: string
  model: string
  model_permaslug?: string
  endpoint_id: string
  provider_name: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens?: number
  reasoning_tokens?: number
  usage: number
}

export interface ActivityResult {
  requests: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Strip OpenRouter variant suffixes: ":free", ":nitro", "#variant". */
export function baseModelSlug(model: string): string {
  const hash = model.indexOf("#")
  const stripped = hash === -1 ? model : model.slice(0, hash)
  const colon = stripped.indexOf(":")
  return colon === -1 ? stripped : stripped.slice(0, colon)
}

/** Some model refs carry a "provider/prefix:variant" compound (e.g. "x-ai/grok-4:free"). */
export interface FetchOptions {
  baseUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Overall deadline for one API call, composed with the plugin shutdown signal. */
function requestSignal(options: FetchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
}

export async function fetchModelEndpoints(model: string, options: FetchOptions = {}): Promise<EndpointsResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.baseUrl ?? BASE_URL
  const signal = requestSignal(options)

  async function get(slug: string): Promise<Response> {
    // The slug is already a URL path ("author/name[:variant]"); do not encode the "/".
    const response = await fetchImpl(`${base}/models/${slug}/endpoints`, {
      headers: { accept: "application/json" },
      signal,
    })
    return response
  }

  let response = await get(model)
  // Only a missing slug (404) is worth retrying without the variant suffix. Auth,
  // rate-limit and server errors come from the API, not the slug form: retrying
  // them just doubles the request pressure.
  const stripped = baseModelSlug(model)
  const variantStatus = response.status
  if (response.status === 404 && stripped !== model) {
    response = await get(stripped)
  }
  if (!response.ok) {
    const detail = response.status === variantStatus ? `${response.status}` : `${variantStatus} -> ${response.status}`
    throw new OpenRouterError(`endpoints fetch failed for ${model}: HTTP ${detail}`, response.status)
  }
  const payload = (await response.json()) as { data?: EndpointsResponse }
  const data = payload?.data
  if (!data || !Array.isArray(data.endpoints)) {
    throw new OpenRouterError(`unexpected endpoints payload for ${model}`, response.status)
  }
  return data
}

function extractRows(payload: unknown): ActivityRow[] {
  if (Array.isArray(payload)) return payload as ActivityRow[]
  const data = (payload as { data?: unknown })?.data
  if (Array.isArray(data)) return data as ActivityRow[]
  const nested = (data as { data?: unknown })?.data
  if (Array.isArray(nested)) return nested as ActivityRow[]
  return []
}

/**
 * Fetch account activity and reduce it to sums for one model slug (suffix-insensitive:
 * "anthropic/claude-4.5-sonnet" also matches "anthropic/claude-4.5-sonnet:reasoning").
 */
export async function fetchOpenRouterProfile(
  model: string,
  managementKey: string | undefined,
  options: FetchOptions = {},
): Promise<ActivityResult | undefined> {
  if (!managementKey) return undefined
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.baseUrl ?? BASE_URL

  const response = await fetchImpl(`${base}/activity`, {
    headers: { accept: "application/json", authorization: `Bearer ${managementKey}` },
    signal: requestSignal(options),
  })
  if (!response.ok) {
    throw new OpenRouterError(`activity fetch failed: HTTP ${response.status}`, response.status)
  }
  const payload = await response.json()
  const rows = extractRows(payload)
  const target = baseModelSlug(model).toLowerCase()
  return sumActivity(rows, target)
}

export function sumActivity(rows: ActivityRow[], slugMatch: string): ActivityResult {
  const target = slugMatch.toLowerCase()
  const result: ActivityResult = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
  for (const row of rows) {
    if (baseModelSlug(row.model ?? "").toLowerCase() !== target) continue
    result.requests += row.requests ?? 0
    result.promptTokens += row.prompt_tokens ?? 0
    result.completionTokens += row.completion_tokens ?? 0
    result.cachedTokens += row.cached_tokens ?? 0
  }
  return result
}

/**
 * Canonical permaslug of a model, recovered from its endpoints. The public endpoints
 * API names every endpoint "<Provider> | <permaslug>" and carries no separate
 * permaslug field; the frontend stats routes (below) key on the permaslug, so the
 * tail of the last "|" is the cheapest way to resolve it. Every endpoint of a model
 * shares one permaslug, so ties (weird provider names) resolve by frequency.
 */
export function permaslugFromEndpoints(endpoints: OpenRouterEndpoint[]): string | undefined {
  const counts = new Map<string, number>()
  for (const endpoint of endpoints) {
    const name = endpoint.name ?? ""
    const separator = name.lastIndexOf("|")
    if (separator === -1) continue
    const tail = name.slice(separator + 1).trim()
    if (!tail || tail.includes("|")) continue
    counts.set(tail, (counts.get(tail) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [tail, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && tail < best)) {
      best = tail
      bestCount = count
    }
  }
  return best
}

/** Endpoint identity rows from the frontend stats API (undocumented, stable in practice). */
interface FrontendEndpoint {
  id: string
  tag?: string | null
  provider_slug?: string | null
  provider_name?: string | null
}

/** One day of Tool Call Error Rate: percentages per endpoint id, plus its volume. */
interface ToolCallErrorRow {
  y?: Record<string, number>
  volume?: Record<string, number>
}

function unwrapData(payload: unknown): unknown[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (Array.isArray(data)) return data
  if (Array.isArray(payload)) return payload as unknown[]
  return []
}

/**
 * Fetch the per-provider Tool Call Error Rate OpenRouter shows on a model page's
 * Performance tab: of all requests where the model finished by emitting tool calls,
 * the share that carried at least one invalid tool call (bad JSON, unknown name, or
 * schema mismatch). This API is undocumented; it is the same unauthenticated route
 * the website itself calls. Failures are handled by the caller: ranking proceeds
 * without the filter rather than blocking providers on missing data.
 *
 * Returns one volume-weighted average rate per provider slug (percent, 0-100),
 * aggregated over the whole window and every endpoint of the provider.
 */
export async function fetchToolCallErrorRate(
  permaslug: string,
  options: FetchOptions & { timeRange?: string } = {},
): Promise<Map<string, number>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.baseUrl ?? FRONTEND_BASE_URL
  const signal = requestSignal(options)
  const timeRange = options.timeRange ?? "1w"
  const slug = encodeURIComponent(permaslug)

  const [perfResponse, rateResponse] = await Promise.all([
    fetchImpl(`${base}/v1/stats/endpoint?permaslug=${slug}&latencyMetric=latency&perfWorkload=text_generation`, {
      headers: { accept: "application/json" },
      signal,
    }),
    fetchImpl(`${base}/v1/stats/tool-call-error-rate?permaslug=${slug}&timeRange=${timeRange}`, {
      headers: { accept: "application/json" },
      signal,
    }),
  ])
  if (!perfResponse.ok) {
    throw new OpenRouterError(`endpoint stats fetch failed for ${permaslug}: HTTP ${perfResponse.status}`, perfResponse.status)
  }
  if (!rateResponse.ok) {
    throw new OpenRouterError(`tool call error rate fetch failed for ${permaslug}: HTTP ${rateResponse.status}`, rateResponse.status)
  }

  const idToSlug = new Map<string, string>()
  for (const entry of unwrapData(await perfResponse.json()) as FrontendEndpoint[]) {
    if (!entry || typeof entry.id !== "string") continue
    const mapped = providerSlug({ tag: entry.tag ?? "", provider_name: entry.provider_name ?? entry.provider_slug ?? "" } as OpenRouterEndpoint)
    if (mapped) idToSlug.set(entry.id, mapped)
  }

  const sums = new Map<string, { weighted: number; volume: number }>()
  for (const row of unwrapData(await rateResponse.json()) as ToolCallErrorRow[]) {
    for (const [id, rate] of Object.entries(row?.y ?? {})) {
      const target = idToSlug.get(id)
      if (!target) continue
      const volume = row?.volume?.[id]
      // Volume is the daily request count behind the rate; without it the rate
      // cannot be weighted, so a lone unweighted sample must not decide the filter.
      if (typeof rate !== "number" || !Number.isFinite(rate) || typeof volume !== "number" || volume <= 0) continue
      const acc = sums.get(target) ?? { weighted: 0, volume: 0 }
      acc.weighted += rate * volume
      acc.volume += volume
      sums.set(target, acc)
    }
  }

  const rates = new Map<string, number>()
  for (const [target, acc] of sums) {
    if (acc.volume > 0) rates.set(target, acc.weighted / acc.volume)
  }
  return rates
}
