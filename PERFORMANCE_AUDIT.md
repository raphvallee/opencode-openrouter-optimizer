# Performance Audit - opencode-openrouter-optimizer

Date: 2026-10-30
Scope: `index.ts`, `src/**`, `scripts/**`, `test/**`
Baseline: `bun test` 47 pass in 166 ms, `bun run typecheck` clean.
Probe: `bun run scripts/perf-probe.ts [--live]` (added by this audit).

> Status: all quick wins (QW-1 through QW-14) were implemented on 2026-10-31.
> See section 8 for the change list, verification and after numbers. The big changes
> (BC-1 through BC-7) remain open.

## 1. Executive summary

The code is structurally sound: the request path never waits on the network, the stats
CLI runs only in the background, prepared statements are reused, ranking is pure, and
WAL is enabled. The remaining cost is concentrated in four places:

1. **Every OpenRouter request is read, JSON-parsed, JSON-stringified and rebuilt**, even
   when the plugin changes nothing (`src/plugin.ts:117-169`). This is the dominant CPU
   cost: about 220 us per 1 MB body, on the single Bun event loop, for every LLM call
   including every tool-loop step.
2. **The request path performs three synchronous SQLite reads and parses a full ranking
   snapshot** (`src/plugin.ts:135-137`, `src/db.ts:95-119`). The stored snapshot contains
   full endpoint objects (1.5 KB to 7.1 KB live) although routing needs only 112 bytes.
3. **The OpenRouter Activity API is fetched once per model refresh** (`src/plugin.ts:49-52`,
   `src/openrouter.ts:102-135`). Each call downloads and scans the full account-wide
   30-day payload, so N models means N identical downloads per TTL window.
4. **Failed refreshes retry on every single request** (`src/plugin.ts:94-101`). If the
   endpoints API is down, request rate becomes retry rate.

No correctness regression was observed. Findings are ordered by payoff, with measured
or directly inferred impact and effort.

## 2. Measured hot-path cost

Environment: Bun 1.4.3, Windows, in-memory SQLite, no network. Treat as relative numbers,
not absolutes.

| Operation | Cost |
| --- | --- |
| JSON.parse, 50 KB body | 7.2 us |
| JSON.parse + JSON.stringify, 50 KB body | 9.3 us |
| JSON.parse, 200 KB body | 33.2 us |
| JSON.parse + JSON.stringify, 200 KB body | 45.2 us |
| JSON.parse, 500 KB body | 62.6 us |
| JSON.parse + JSON.stringify, 500 KB body | 109.7 us |
| JSON.parse, 1 MB body | 113.8 us |
| JSON.parse + JSON.stringify, 1 MB body | 221.3 us |
| Full ranking snapshot | 2,576 bytes (112 bytes compact) |
| Live ranking snapshot, claude-sonnet-4.5 | 7.1 KB (112 bytes compact) |
| `ensureFetchRow` (1 SELECT) | 1.5 us |
| `getRankings` (SELECT + JSON.parse) | 3.7 us |
| Today's three reads per request | 6.5 us |

A typical agent turn has a 100 KB to 1 MB serialized body and several requests per turn.
The plugin therefore adds roughly 0.05 ms to 0.25 ms of blocking work per request, plus
allocations and GC pressure. SQLite adds another ~7 us and copies the whole row, including
dead `endpoints_json`. The absolute numbers are small, but this is per request, on the
event loop, across all concurrent sessions.

## 3. Quick wins

### QW-1. Stop persisting the full rankings array, persist compact routing only
Evidence: `src/db.ts:29-35` stores `rankings: unknown[]`; `src/plugin.ts:77-83` writes it;
`src/plugin.ts:142-144` is the only reader, and only for debug logging.

The request path only needs `survivors`, `blacklist` and `mode`. Full `ProviderRank[]`
with endpoint objects is used for a debug line and by no routing logic. Live snapshots are
1.5 KB to 7.1 KB; the compact form is ~112 bytes.

Fix: store `{survivors, blacklist, mode, computedAt}` in the hot column, or keep
`rankings` only when `debug` is true (separate column or separate table). Expected effect:
7x to 60x smaller rows, less write amplification, and a much cheaper per-request parse.
This is the highest value-to-risk quick win.

### QW-2. Cache routing snapshots in memory, one read per request at most
Evidence: `src/plugin.ts:135-137` calls `ensureFetchRow`, then `ensureFresh` calls
`db.getFetch` (`:96`), then `getRankings` calls `getFetch` again (`src/db.ts:112`). Three
sync SELECTs, two of them redundant.

Fix: fetch the row once, or better, keep a `Map<model, Routing>` populated at setup and
updated by `refreshModel`. Request path becomes a map lookup. DB stays the durable store.
Cross-process staleness is bounded by TTL; if that matters, revalidate on a short timer or
on `updated_at` change. Expected effect: removes ~6.5 us and all row-sized string copies
from the hot path, and removes synchronous I/O from the event loop.

### QW-3. Do not reserialize the body when nothing changed
Evidence: `src/plugin.ts:156-165` always `JSON.stringify` and rebuilds `Request`, even when
`ranking` is missing or `blacklist.length === 0` (first request per model, and any model
with no blocked providers).

Fix: `const snapshot = request.clone()`, read and parse the clone, mutate only when a
routing block is actually written. If unchanged, leave the original request untouched.
When changed, rebuild as today. Expected effect: saves stringify plus a `Headers` copy and
a `Request` allocation on pass-through paths. It also avoids consuming the original body
when parsing fails, which is a small robustness gain.

### QW-4. Use the event model ref to skip body parsing entirely when no routing applies
Evidence: `HttpEventLike` only types `providerID` (`src/plugin.ts:10-13`), but the host
event is `SessionHttpRequest` with a full `Model.Ref` that includes `modelID`
(`node_modules/@opencode/plugin/dist/promise/session.d.ts:70-76`).

Fix: look up the model from `evt.model.modelID` first. Only read and parse the body when a
ranking with a non-empty blacklist exists. The body model remains authoritative for the
parse-and-rewrite branch, and the plugin can fall back to the body if the ref is missing.
Expected effect: first request per model, models with no blocked providers, and any
non-routed path cost near zero. Combined with QW-3, the only remaining cost is the
parallel `request.clone()` tee.

### QW-5. Make debug logging lazy
Evidence: `src/plugin.ts:141-148` builds a `Set`, filters, maps, formats prices with
`toFixed(6)` and joins strings on every routed request, then discards all of it because
`debug` is false by default (`src/plugin.ts:26-28`).

Fix: guard with `if (options.debug)` or accept a thunk. Expected effect: removes per-request
allocations and formatting on the default configuration.

### QW-6. Never select the large text columns on the hot path
Evidence: `src/db.ts:74` selects `*`; both `endpoints_json` and `rankings_json` are returned
for every lookup.

Fix: add a lean statement for `model, last_fetched, survivors, blacklist, mode` (after
QW-1), and keep full-row reads for `inspect`. Expected effect: avoids copying the entire
row, currently ~9 KB endpoints plus ~7 KB rankings, per request.

### QW-7. Remove the write-only `endpoints_json`
Evidence: `src/db.ts:77-83` and `:107-109` write it; the grep shows no reader other than
`inspect` and `state`. Re-ranking never reads it.

Fix: stop writing it, or move it to a cold/optional table if audit data is wanted. Expected
effect: halves the refresh write size and shrinks every row, which also helps QW-6. This is
the clearest dead-weight removal in the codebase.

### QW-8. Collapse the two refresh writes and relax fsync
Evidence: `src/plugin.ts:76-83` calls `recordFetch` and `setRanking`, two UPSERTs, so two
WAL commits per refresh; `src/db.ts:67-68` does not set `synchronous`.

Fix: one UPSERT with all fields in one transaction, and `PRAGMA synchronous = NORMAL` for
WAL (standard durability/throughput tradeoff for this kind of cache DB). Refresh is rare,
so this is minor, but it is free.

### QW-9. Add failure backoff so a failed refresh is not retried per request
Evidence: `src/plugin.ts:94-101` treats `last_fetched === null` as stale, and a failed
refresh leaves it null (`src/db.ts:75`). The only dedupe is the in-flight map, so as soon as
the attempt fails the next request starts another one.

Fix: record `last_attempt` and `attempts` (or `retry_after`) and skip until a jittered
backoff expires. Expected effect: turns a retry storm into bounded retries. This is the
highest severity operational finding even though the steady-state CPU cost is zero.

### QW-10. Enforce the already-declared HTTP timeouts
Evidence: `FetchOptions.timeoutMs` exists (`src/openrouter.ts:53-58`) but is never used by
either client (`:60-71`, `:102-114`).

Fix: compose `AbortSignal.timeout(options.timeoutMs ?? 15_000)` with the plugin signal.
Expected effect: a hung endpoints or activity request cannot occupy an in-flight slot until
process shutdown. Straightforward reliability and concurrency win.

### QW-11. Drain stderr from the stats subprocess
Evidence: `src/stats.ts:150-161` pipes stderr but never reads it. A chatty CLI can fill the
OS pipe buffer and block the child, so the 60 s timer is the only escape.

Fix: consume `stderr` concurrently or set it to `ignore`. Expected effect: removes a
potential 60 s stall and makes the stats snapshot deterministic.

### QW-12. Run endpoints fetch and profile build concurrently
Evidence: `src/plugin.ts:72-73` awaits endpoints, then `buildProfile` starts stats and
activity. These are independent.

Fix: `const [endpoints, profile] = await Promise.all([...])`. Expected effect: refresh wall
time drops by roughly the smaller of the two network times, which reduces the window where
a model still routes with the old ranking.

### QW-13. Index stats profiles by suffix
Evidence: `src/stats.ts:66-79` scans every profile for every model refresh, with a
`split("/").pop()` allocation per entry. Complexity is O(models refreshed * profiles).

Fix: build `Map<suffix, LocalProfile>` once per snapshot. Expected effect: small at current
scale, but removes an avoidable quadratic pattern and per-refresh allocations.

### QW-14. Collapse `ensureFetchRow` into one statement
Evidence: `src/db.ts:99-104` does SELECT, then INSERT, then SELECT on first sight.

Fix: `INSERT OR IGNORE` followed by one SELECT, or return the row from a single
`INSERT ... ON CONFLICT DO NOTHING RETURNING` where supported. Minor.

## 4. Big changes

### BC-1. Zero-I/O request path with an in-process routing table
Build a routing cache at plugin setup and treat SQLite as a durable backing store. Refresh
writes both. The request path becomes: map lookup, optional body rewrite, done. Add a
short-TTL revalidation if multiple OpenCode processes share the DB. This supersedes QW-2
and QW-6 and eliminates all synchronous I/O from the hot path. Main risk is cross-process
staleness, which is already bounded by the 6 h TTL and can be tightened cheaply.

### BC-2. Fetch OpenRouter Activity once per TTL and index by model
`buildProfile` calls `fetchOpenRouterProfile(model)` for each model, and that function
downloads the full account-wide `/activity` payload and linearly scans it
(`src/openrouter.ts:102-135`). Fix by adding a cached, single-flight activity snapshot
(`{byBaseSlug: Map<string, ActivityResult>, fetchedAt}`) shared by all refreshes, analogous
to `OpenCodeStats`. Expected effect: N downloads and N full scans become 1 per TTL window,
with the same result. This is the highest-value background change. Also consider making the
stats and activity snapshots refresh lazily but proactively, so a burst of model refreshes
shares one snapshot.

### BC-3. A real refresh scheduler: bounded concurrency, jitter, backoff, visibility
Today refreshes are fire-and-forget promises with a per-model in-flight map only
(`src/plugin.ts:33`, `:94-102`). Recommended: a small queue with a concurrency cap (for
example 3 to 5), jittered start times, per-model retry state, `AbortSignal.timeout`, and a
shutdown that awaits or aborts in-flight work. This prevents cold-start fan-out and retry
storms, and makes refresh behavior observable. Pairs naturally with QW-9 and QW-10.

### BC-4. HTTP caching and bulk metadata
The endpoints API is per model. Add ETag/`If-None-Match` or `If-Modified-Since` handling so
unchanged pricing responses cost a 304 instead of a full payload and parse. If OpenRouter
exposes a bulk model catalog with provider data, prefer one cached catalog fetch over N
per-model fetches. Verify the current API surface first; do not guess endpoints. Expected
effect: lower bandwidth, fewer rate-limit encounters, less JSON parse in the background.

### BC-5. Split hot and cold schemas, add retention
Move to a narrow `routing` table (`model, survivors, blacklist, mode, last_fetched,
last_attempt, retry_after`) for the request path, and keep detailed snapshots (`rankings`,
`endpoints`) in a separate cold table or only when debug is enabled. Add eviction for
models unused for a long period. This makes QW-1, QW-6 and QW-7 permanent rather than
incremental, and keeps the hot table small enough to load fully into memory at startup.

### BC-6. Move routing out of per-request body rewriting (exploratory)
The plugin's own design goal says it never delays a request, but the `http.request` hook
does block on body read and serialization before dispatch. If OpenCode forwards
`SessionRequest.options` or provider options into the outgoing provider body, the routing
block could be set once per generation instead of rewritten into every serialized request.
Validate this against the host: inspect `SessionRequest.options`
(`session.d.ts:20-31`), the `prompt`/`context`/`model.request` hooks, and the OpenRouter
provider adapter. If it works, this removes the dominant hot-path cost entirely. If it does
not, keep the body rewrite and optimize it with QW-3 and QW-4. Do not attempt textual JSON
injection into the body stream; the correctness risk is not worth the microseconds.

### BC-7. Avoid full-body parsing in the common routed case (only if BC-6 fails)
Even when the body must be rewritten, a streaming scan could locate the top-level `model`
field without materializing the whole tree, and only do the full parse plus stringify when
a routing block is required. This saves the parse but not the stringify, and the stringify
still requires the object. A real win would need a serialization strategy that preserves
the original bytes and appends a provider block, which is fragile. Defer until BC-6 is
ruled out and only pursue if profiling shows the parse, not the stringify, dominates.

## 5. Prioritized roadmap

| Phase | Work | Why |
| --- | --- | --- |
| 0, now | QW-9, QW-10, QW-11 | Remove retry storms, hung requests and subprocess stalls. Pure reliability. |
| 1, cheap CPU | QW-1, QW-2, QW-5, QW-6, QW-7 | Shrink and cache routing data; strip debug and dead-column work from every request. |
| 2, hot path | QW-3, QW-4, BC-1 | Make pass-through free and the routed path allocation-light. |
| 3, background | QW-12, QW-8, QW-13, BC-2, BC-3 | One activity fetch per TTL, bounded refresh, faster refresh cycles. |
| 4, architecture | BC-4, BC-5, BC-6 | Conditional HTTP, hot/cold schema split, and removing body rewriting if the host allows it. |

## 6. What is already good, do not regress

- Network work is fully off the request path, with per-model single-flight.
- The stats CLI is cached and single-flighted across models.
- Prepared statements are reused instead of re-prepared per call.
- WAL and `busy_timeout` are enabled.
- Ranking and pricing are pure and independently tested; no I/O mixed into them.
- Hook failures are caught and requests pass through unmodified.
- `content-length` is dropped when a body is replaced, so the runtime recomputes it.

## 7. Measurement caveats

- Numbers are from one Windows machine on Bun 1.4.3, in-memory SQLite, warm JIT.
- The 1 MB body case is a synthetic single large string; real multi-message payloads can
  parse faster or slower depending on shape.
- Live snapshot sizes vary with the model and the number of providers; the three sampled
  models ranged from 1.5 KB to 7.1 KB.
- Activity API payload size could not be measured without a management key; the N+1
  finding is structural from the code, not a bandwidth measurement.
- Re-run `bun run scripts/perf-probe.ts --live` before and after each optimization to keep
  the comparison honest.

## 8. Implementation status (2026-10-31)

All quick wins are implemented. Tests went from 47 to 55 and stay green; typecheck is
clean. The live OpenCode message store confirms that `message.modelID` is the full
OpenRouter slug (for example `stealth/space-bunny-alpha`), so the QW-4 fast path is valid.

### Quick wins

| ID | Status | Change |
| --- | --- | --- |
| QW-1 | Done | `fetches` now stores `survivors_json`, `blacklist_json`, `mode`, `computed_at`; full rankings live in `details_json` only when `debug` is true. |
| QW-2 | Done | Plugin warms a `Map<model, RoutingState>` at setup and updates it on refresh. Request path does no SQLite reads for known models. |
| QW-3 | Done | The hook inspects `request.clone()` and only builds a replacement `Request` when a routing block is actually injected. |
| QW-4 | Done | `evt.model.modelID` is used first. When the model has no blacklist, the body is never read or parsed. |
| QW-5 | Done | `logRouting` is called only on debug paths and returns immediately when `debug` is false. |
| QW-6 | Done | Explicit column lists; the bulk cache warm has a lean statement that skips `details_json`. Legacy large columns are gone. |
| QW-7 | Done | `endpoints_json` is no longer written; the migration drops it after folding the compact data. |
| QW-8 | Done | One `saveRefresh` UPSERT per successful refresh, plus `PRAGMA synchronous = NORMAL`. |
| QW-9 | Done | `last_attempt`, `attempts` and `retry_after` are persisted; failed refreshes back off 30 s doubling to 1 h with jitter. |
| QW-10 | Done | `requestSignal` composes `AbortSignal.timeout` (15 s default) with the plugin shutdown signal for endpoints and activity calls. |
| QW-11 | Done | Stats stdout and stderr are drained concurrently; stderr is included in the failure message. |
| QW-12 | Done | Endpoint fetch and profile build run in `Promise.all`. |
| QW-13 | Done | `OpenCodeStats` keeps a prebuilt suffix/exact index and exposes `pick`; refresh no longer scans all profiles per model. |
| QW-14 | Done | `ensureFetchRow` is one `INSERT OR IGNORE` plus one `SELECT`. |

### After numbers

| Path | Before | After |
| --- | --- | --- |
| Routing lookup per request | 3 SELECTs plus full snapshot parse, ~7.4 us | Map lookup, ~0.0 us |
| Routing payload persisted | 1.5 KB to 7.1 KB | ~112 bytes |
| Pass-through request body | always parsed, stringified, rebuilt | untouched |
| Successful refresh writes | 2 UPSERTs | 1 UPSERT |
| Failed refresh | retried on every request | backoff, max 1 h |
| Endpoints/activity timeout | none | 15 s default |
| Refresh wall time | endpoints then profile | concurrent |

The remaining per-request cost is the unavoidable parse plus stringify when a blacklist
must be injected into the body (about 45 us at 200 KB, 220 us at 1 MB). Removing that is
BC-6, not a quick win. The next highest-value open items are BC-2 (one Activity fetch per
TTL instead of one per model) and BC-3 (bounded refresh scheduling).

### Verification

- `bun test`: 55 pass, 0 fail.
- `bun run typecheck`: clean.
- `bun run scripts/perf-probe.ts --live`: body, snapshot, SQLite, cached-map and live
  endpoint sizes.
- Migration is covered by a test that opens a legacy `rankings_json`/`endpoints_json`
  database and asserts the compact fields plus the retained debug details.
- New tests cover the model-ref fast path, the failure backoff and the timeout abort.
