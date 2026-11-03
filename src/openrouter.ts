/** OpenRouter HTTP clients (endpoints API: public; Activity API: management key). */

import { providerSlug, type OpenRouterEndpoint } from "./ranking.js";
import { readBoundedJson } from "./http.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const FRONTEND_BASE_URL = "https://openrouter.ai/api/frontend";

export interface EndpointsResponse {
  id: string;
  name: string;
  endpoints: OpenRouterEndpoint[];
}

/** Activity rows from GET /api/v1/activity (last 30 completed UTC days). */
export interface ActivityRow {
  date: string;
  model: string;
  model_permaslug?: string;
  endpoint_id: string;
  provider_name: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  usage: number;
}

export interface ActivityResult {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Strip OpenRouter variant suffixes: ":free", ":nitro", "#variant". */
export function baseModelSlug(model: string): string {
  const hash = model.indexOf("#");
  const stripped = hash === -1 ? model : model.slice(0, hash);
  const colon = stripped.indexOf(":");
  return colon === -1 ? stripped : stripped.slice(0, colon);
}

/** Some model refs carry a "provider/prefix:variant" compound (e.g. "x-ai/grok-4:free"). */
export interface FetchOptions {
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Cap on API payloads we are willing to buffer in memory. */
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
/** A model slug is "author/name[:variant][#marker]"; anything else is never sent as a URL path. */
const MODEL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/;
const MAX_ENDPOINTS = 512;
/** Hard ceiling on a model reference persisted to the db and kept in memory. */
const MAX_MODEL_REF = 192;

/** True when the value is a usable "author/name[:variant]" model reference. */
export function isOpenRouterModelRef(model: unknown): model is string {
  return typeof model === "string" && model.length <= MAX_MODEL_REF && MODEL_SLUG_RE.test(model);
}

/** Overall deadline for one API call, composed with the plugin shutdown signal. */
function requestSignal(options: FetchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export async function fetchModelEndpoints(
  model: string,
  options: FetchOptions = {},
): Promise<EndpointsResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE_URL;
  const signal = requestSignal(options);
  if (!isOpenRouterModelRef(model)) {
    // Never interpolate an unvalidated model id into the request path; callers
    // treat this like any other fetch failure (the request passes through).
    throw new OpenRouterError(`refusing to fetch endpoints for an unexpected model slug`, 0);
  }
  // Each segment is encoded separately, so "a/#think" and "a/../x" can never
  // escape the /models/<author>/<name>/endpoints route. A literal ":" (the
  // variant separator, e.g. "vendor/model:free") is kept raw, exactly like
  // before encoding existed; everything else dangerous is percent-encoded.
  const safeSegment = (segment: string): string =>
    encodeURIComponent(segment).replace(/%3A/gi, ":");
  const [author, rawName] = model.split("/");
  const authorSegment = safeSegment(author);

  async function get(name: string): Promise<Response> {
    const response = await fetchImpl(
      `${base}/models/${authorSegment}/${safeSegment(name)}/endpoints`,
      {
        headers: { accept: "application/json" },
        signal,
      },
    );
    return response;
  }

  let response = await get(rawName);
  // Only a missing slug (404) is worth retrying without the variant suffix. Auth,
  // rate-limit and server errors come from the API, not the slug form: retrying
  // them just doubles the request pressure.
  const stripped = baseModelSlug(rawName);
  const variantStatus = response.status;
  if (response.status === 404 && stripped !== rawName) {
    response = await get(stripped);
  }
  if (!response.ok) {
    const detail =
      response.status === variantStatus
        ? `${response.status}`
        : `${variantStatus} -> ${response.status}`;
    throw new OpenRouterError(
      `endpoints fetch failed for ${model}: HTTP ${detail}`,
      response.status,
    );
  }
  const payload = (await readBoundedJson(
    response,
    MAX_PAYLOAD_BYTES,
    `endpoints payload for ${model}`,
  )) as {
    data?: EndpointsResponse;
  };
  const data = payload?.data;
  if (!data || !Array.isArray(data.endpoints)) {
    throw new OpenRouterError(`unexpected endpoints payload for ${model}`, response.status);
  }
  // Drop anything that is not an object and never rank more than MAX_ENDPOINTS.
  const endpoints = data.endpoints
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .slice(0, MAX_ENDPOINTS);
  return { ...data, endpoints };
}

/**
 * Activity rows from the known envelope shapes. Returns undefined when the
 * payload matches none of them, so envelope drift surfaces as an
 * OpenRouterError (and the plugin's activity-failure warning) instead of
 * silently ranking from zero activity data.
 */
function extractRows(payload: unknown): ActivityRow[] | undefined {
  if (Array.isArray(payload)) return payload as ActivityRow[];
  const data = (payload as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data as ActivityRow[];
  const nested = (data as { data?: unknown } | null)?.data;
  if (Array.isArray(nested)) return nested as ActivityRow[];
  return undefined;
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
  if (!managementKey) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE_URL;

  const response = await fetchImpl(`${base}/activity`, {
    // A redirect must never carry the management key to another origin; fail closed.
    redirect: "error",
    headers: { accept: "application/json", authorization: `Bearer ${managementKey}` },
    signal: requestSignal(options),
  });
  if (!response.ok) {
    throw new OpenRouterError(`activity fetch failed: HTTP ${response.status}`, response.status);
  }
  const payload = await readBoundedJson(response, MAX_PAYLOAD_BYTES, "activity payload");
  const rows = extractRows(payload);
  if (!rows) {
    throw new OpenRouterError(`unexpected activity payload for ${model}`, response.status);
  }
  const target = baseModelSlug(model).toLowerCase();
  return sumActivity(rows, target);
}

function activityNumber(
  row: ActivityRow,
  field: "requests" | "prompt_tokens" | "completion_tokens" | "cached_tokens",
  rowIndex: number,
  required: boolean,
): number {
  const value = row[field];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`activity row ${rowIndex} is missing ${field}`);
    }
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `activity row ${rowIndex} has invalid ${field}: expected a finite non-negative number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function sumActivity(rows: ActivityRow[], slugMatch: string): ActivityResult {
  const target = slugMatch.toLowerCase();
  const result: ActivityResult = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`activity row ${index} is not an object`);
    }
    if (typeof row.model !== "string") {
      throw new Error(
        `activity row ${index} has invalid model: expected a string, got ${JSON.stringify(row.model)}`,
      );
    }
    if (baseModelSlug(row.model).toLowerCase() !== target) continue;
    result.requests += activityNumber(row, "requests", index, true);
    result.promptTokens += activityNumber(row, "prompt_tokens", index, true);
    result.completionTokens += activityNumber(row, "completion_tokens", index, true);
    result.cachedTokens += activityNumber(row, "cached_tokens", index, false);
  }
  return result;
}

/**
 * Canonical permaslug of a model, recovered from its endpoints. The public endpoints
 * API names every endpoint "<Provider> | <permaslug>" and carries no separate
 * permaslug field; the frontend stats routes (below) key on the permaslug, so the
 * tail of the last "|" is the cheapest way to resolve it. Every endpoint of a model
 * shares one permaslug, so ties (weird provider names) resolve by frequency.
 */
export function permaslugFromEndpoints(endpoints: OpenRouterEndpoint[]): string | undefined {
  const counts = new Map<string, number>();
  for (const endpoint of endpoints) {
    const name = typeof endpoint?.name === "string" ? endpoint.name : "";
    const separator = name.lastIndexOf("|");
    if (separator === -1) continue;
    const tail = name.slice(separator + 1).trim();
    if (!tail || tail.includes("|") || tail.length > 128) continue;
    counts.set(tail, (counts.get(tail) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [tail, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && tail < best)) {
      best = tail;
      bestCount = count;
    }
  }
  return best;
}

/** Endpoint identity rows from the frontend stats API (undocumented, stable in practice). */
interface FrontendEndpoint {
  id: string;
  tag?: string | null;
  provider_slug?: string | null;
  provider_name?: string | null;
}

/** One day of Tool Call Error Rate: percentages per endpoint id, plus its volume. */
interface ToolCallErrorRow {
  y?: Record<string, number>;
  volume?: Record<string, number>;
}

function unwrapData(payload: unknown, status: number, context: string): unknown[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(payload)) return payload as unknown[];
  // Returning [] here would silently turn envelope drift into "no data" and the
  // filter would disappear without a trace. Mirror the activity client: throw so
  // the caller warns with the route and status.
  throw new OpenRouterError(`unexpected ${context} payload`, status);
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? FRONTEND_BASE_URL;
  const signal = requestSignal(options);
  const timeRange = options.timeRange ?? "1w";
  const slug = encodeURIComponent(permaslug);

  const [perfResponse, rateResponse] = await Promise.all([
    fetchImpl(
      `${base}/v1/stats/endpoint?permaslug=${slug}&latencyMetric=latency&perfWorkload=text_generation`,
      {
        headers: { accept: "application/json" },
        signal,
      },
    ),
    fetchImpl(`${base}/v1/stats/tool-call-error-rate?permaslug=${slug}&timeRange=${timeRange}`, {
      headers: { accept: "application/json" },
      signal,
    }),
  ]);
  if (!perfResponse.ok) {
    throw new OpenRouterError(
      `endpoint stats fetch failed for ${permaslug}: HTTP ${perfResponse.status}`,
      perfResponse.status,
    );
  }
  if (!rateResponse.ok) {
    throw new OpenRouterError(
      `tool call error rate fetch failed for ${permaslug}: HTTP ${rateResponse.status}`,
      rateResponse.status,
    );
  }

  const idToSlug = new Map<string, string>();
  for (const entry of unwrapData(
    await readBoundedJson(perfResponse, MAX_PAYLOAD_BYTES, `endpoint stats for ${permaslug}`),
    perfResponse.status,
    `endpoint stats for ${permaslug}`,
  ) as FrontendEndpoint[]) {
    if (!entry || typeof entry.id !== "string") continue;
    const mapped = providerSlug({
      tag: entry.tag ?? "",
      provider_name: entry.provider_name ?? entry.provider_slug ?? "",
    } as OpenRouterEndpoint);
    if (mapped) idToSlug.set(entry.id, mapped);
  }

  const rows = unwrapData(
    await readBoundedJson(rateResponse, MAX_PAYLOAD_BYTES, `tool call error rate for ${permaslug}`),
    rateResponse.status,
    `tool call error rate for ${permaslug}`,
  ) as ToolCallErrorRow[];
  const sums = new Map<string, { weighted: number; volume: number }>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new OpenRouterError(
        `tool call error rate payload for ${permaslug} contains a non-object row`,
        rateResponse.status,
      );
    }
    const ratesByEndpoint = row.y;
    const volumes = row.volume;
    if (
      ratesByEndpoint !== undefined &&
      (typeof ratesByEndpoint !== "object" ||
        ratesByEndpoint === null ||
        Array.isArray(ratesByEndpoint))
    ) {
      throw new OpenRouterError(
        `tool call error rate payload for ${permaslug} has an invalid y map`,
        rateResponse.status,
      );
    }
    if (
      volumes !== undefined &&
      (typeof volumes !== "object" || volumes === null || Array.isArray(volumes))
    ) {
      throw new OpenRouterError(
        `tool call error rate payload for ${permaslug} has an invalid volume map`,
        rateResponse.status,
      );
    }
    for (const [id, rate] of Object.entries(ratesByEndpoint ?? {})) {
      const target = idToSlug.get(id);
      if (!target) continue;
      const volume = volumes?.[id];
      // Volume is the daily request count behind the rate; without it the rate
      // cannot be weighted, so a lone unweighted sample must not decide the filter.
      // Rates and volumes are also range-checked: an upstream that emits -100 or
      // 1e18 can neither launder a tool-call problem nor silence it.
      const volumeCapped =
        typeof volume === "number" && Number.isFinite(volume) && volume <= 1e12 ? volume : 0;
      if (
        typeof rate !== "number" ||
        !Number.isFinite(rate) ||
        rate < 0 ||
        rate > 100 ||
        volumeCapped <= 0
      )
        continue;
      const acc = sums.get(target) ?? { weighted: 0, volume: 0 };
      acc.weighted += rate * volumeCapped;
      acc.volume += volumeCapped;
      sums.set(target, acc);
    }
  }

  const rates = new Map<string, number>();
  for (const [target, acc] of sums) {
    if (acc.volume > 0) {
      const weighted = acc.weighted / acc.volume;
      rates.set(target, Math.min(100, Math.max(0, weighted)));
    }
  }
  if (rows.length > 0 && rates.size === 0) {
    // Rows arrived but none could be weighted: id mapping, rate, or volume drift.
    // Treat it as envelope damage instead of returning "no providers filtered".
    throw new OpenRouterError(
      `tool call error rate payload for ${permaslug} had rows but no usable rates`,
      rateResponse.status,
    );
  }
  return rates;
}
