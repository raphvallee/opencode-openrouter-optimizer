/**
 * Performance probe for the request hot path and the ranking snapshot format.
 * Usage: bun run scripts/perf-probe.ts [--live]
 *
 * No network by default. `--live` also measures real OpenRouter endpoints payloads,
 * so the snapshot sizes reflect production data.
 */

import { DEFAULT_OPTIONS } from "../src/config"
import { OptimizerDb } from "../src/db"
import { fetchModelEndpoints } from "../src/openrouter"
import type { ProviderRank } from "../src/ranking"
import { rankProviders } from "../src/ranking"

const live = process.argv.includes("--live")
const profile = { avgInput: 20_000, avgOutput: 800, cacheHitRate: 0.4, numRequests: 42 }
const ITER = 20_000

function us(ms: number, n: number): string {
  return ((ms / n) * 1000).toFixed(1)
}

// 1) Body parse/serialize cost at realistic conversation sizes.
const bodyRows: Array<Record<string, string | number>> = []
for (const kb of [50, 200, 500, 1000]) {
  const body = JSON.stringify({ model: "vendor/model", messages: [{ role: "user", content: "x".repeat(kb * 1024) }] })
  const n = 2_000
  let start = performance.now()
  for (let i = 0; i < n; i++) JSON.parse(body).model
  const parseMs = performance.now() - start
  start = performance.now()
  for (let i = 0; i < n; i++) JSON.stringify(JSON.parse(body))
  const roundMs = performance.now() - start
  bodyRows.push({ "body KB": kb, "parse us": us(parseMs, n), "parse+stringify us": us(roundMs, n) })
}
console.log("== request body cost ==")
console.table(bodyRows)

// 2) Ranking snapshot sizes: full ProviderRank[] vs the compact routing payload
//    actually needed by the request path.
const fullRankings = (): ProviderRank[] => {
  const rows: ProviderRank[] = []
  for (let i = 0; i < 5; i++) {
    rows.push({
      slug: `provider-${i}`,
      endpoint: {
        name: `provider-${i} | model`,
        model_id: "vendor/model",
        context_length: 131_072,
        max_completion_tokens: 32_768,
        max_prompt_tokens: null,
        pricing: { prompt: "0.0000001", completion: "0.0000002", input_cache_read: "0.00000001" },
        provider_name: `Provider ${i}`,
        tag: `provider-${i}/fp8`,
        supported_parameters: ["tools", "tool_choice", "temperature"],
        status: 0,
        uptime_last_30m: 99,
        uptime_last_1d: 100,
      },
      slugUptime: 99,
      perRequest: 0.001 * (i + 1),
      total: 0.042 * (i + 1),
      rank: i + 1,
    })
  }
  return rows
}

const full = JSON.stringify({
  rankings: fullRankings(),
  survivors: ["provider-0", "provider-1", "provider-2"],
  blacklist: ["provider-3", "provider-4"],
  computedAt: Date.now(),
  mode: "cheapest",
})
const compact = JSON.stringify({
  survivors: ["provider-0", "provider-1", "provider-2"],
  blacklist: ["provider-3", "provider-4"],
  mode: "cheapest",
})
console.log("== ranking snapshot ==")
console.table([{ format: "full", bytes: full.length }, { format: "compact", bytes: compact.length }])

// 3) SQLite read cost per request, with the full snapshot stored as today.
const db = new OptimizerDb(":memory:")
db.ensureFetchRow("vendor/model", Date.now())
db.recordFetch("vendor/model", fullRankings().map((r) => r.endpoint), Date.now())
db.setRanking("vendor/model", {
  rankings: fullRankings() as never,
  survivors: ["provider-0", "provider-1", "provider-2"],
  blacklist: ["provider-3", "provider-4"],
  computedAt: Date.now(),
  mode: "cheapest",
})

let start = performance.now()
for (let i = 0; i < ITER; i++) db.ensureFetchRow("vendor/model", Date.now())
const ensureMs = performance.now() - start
start = performance.now()
for (let i = 0; i < ITER; i++) db.getRankings("vendor/model")
const rankingMs = performance.now() - start
start = performance.now()
for (let i = 0; i < ITER; i++) {
  db.getFetch("vendor/model")
  db.getRankings("vendor/model")
}
const readsMs = performance.now() - start
start = performance.now()
for (let i = 0; i < ITER; i++) {
  // The pre-Map hot path also ran ensureFetchRow once per request, which is an
  // INSERT OR IGNORE plus a SELECT - a write, not one of the "3 reads".
  db.ensureFetchRow("vendor/model", Date.now())
  db.getFetch("vendor/model")
  db.getRankings("vendor/model")
}
const combinedMs = performance.now() - start
db.close()

console.log("== sqlite hot-path cost ==")
console.table([
  { operation: "ensureFetchRow (insert-or-ignore + select)", "us/call": us(ensureMs, ITER) },
  { operation: "getRankings (select + JSON.parse)", "us/call": us(rankingMs, ITER) },
  { operation: "legacy reads per request (getFetch + getRankings)", "us/call": us(readsMs, ITER) },
  { operation: "legacy state per request (+ ensureFetchRow)", "us/call": us(combinedMs, ITER) },
])

// 4) New hot path: compact routing in a Map, no SQLite read and no JSON.parse per request.
const compactRouting = JSON.parse(compact) as { survivors: string[]; blacklist: string[]; mode: string }
const routeMap = new Map([["vendor/model", compactRouting]])
start = performance.now()
for (let i = 0; i < ITER; i++) routeMap.get("vendor/model")
const mapMs = performance.now() - start
start = performance.now()
for (let i = 0; i < ITER; i++) JSON.parse(compact)
const compactParseMs = performance.now() - start
start = performance.now()
for (let i = 0; i < ITER; i++) JSON.parse(full)
const fullParseMs = performance.now() - start

console.log("== new hot path ==")
console.table([
  { operation: "Map lookup (cached routing)", "us/call": us(mapMs, ITER) },
  { operation: "compact snapshot parse", "us/call": us(compactParseMs, ITER) },
  { operation: "full snapshot parse", "us/call": us(fullParseMs, ITER) },
])

// 5) Optional live snapshot sizes.
if (live) {
  console.log("== live endpoint/ranking sizes ==")
  const rows: Array<Record<string, unknown>> = []
  for (const model of ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro", "meta-llama/llama-3.3-70b-instruct"]) {
    try {
      const data = await fetchModelEndpoints(model)
      const ranking = rankProviders(data.endpoints, profile, DEFAULT_OPTIONS)
      rows.push({
        model,
        endpoints: data.endpoints.length,
        "endpoints KB": (JSON.stringify(data.endpoints).length / 1024).toFixed(1),
        "ranking KB": (
          JSON.stringify({ rankings: ranking.rankings, survivors: ranking.survivors, blacklist: ranking.blacklist }).length / 1024
        ).toFixed(1),
      })
    } catch (error) {
      rows.push({ model, error: error instanceof Error ? error.message : String(error) })
    }
  }
  console.table(rows)
}
