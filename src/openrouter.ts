/** OpenRouter HTTP clients (endpoints API: public; Activity API: management key). */

import type { OpenRouterEndpoint } from "./ranking"

const BASE_URL = "https://openrouter.ai/api/v1"

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
  const stripped = baseModelSlug(model)
  if (!response.ok && stripped !== model) {
    response = await get(stripped)
  }
  if (!response.ok) {
    throw new OpenRouterError(`endpoints fetch failed for ${model}: HTTP ${response.status}`, response.status)
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
