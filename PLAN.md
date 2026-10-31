# PLAN: opencode-openrouter-optimizer

An OpenCode v2 plugin (Bun + TypeScript) that watches every OpenRouter model request,
ranks OpenRouter providers by expected cost per request, and injects a per-request
blacklist (`provider.ignore`) so OpenRouter routes to the 3 cheapest eligible providers.
The plugin never delays a request: all network work happens in the background and the
following requests pick up the freshly computed blacklist.

## Confirmed decisions

1. Stats source: hybrid. OpenRouter Activity API (30-day aggregates, management key via
   `OPENROUTER_MANAGEMENT_KEY` env var) plus OpenCode's own usage stats via the documented
   CLI (`opencode stats --json --models --days 30`). The CLI runs only inside the
   background refresh task (cached, single-flighted), never on the request path; the
   30-day window matches the Activity API so both halves of the merge pool equal-length
   windows. Both are treated as equals because OpenCode sessions have the same request
   shape whether the provider is OpenRouter or direct.
2. Blacklist style: `provider.ignore` (everything except the top 3), plus
   `provider.sort: "price"` so OpenRouter picks the cheapest survivor.
3. Refresh: lazy 6h TTL, triggered by a request, computed in the background, so no
   request ever waits on the plugin. A never-fetched model passes through unmodified
   once and is routed from the second request on.
4. Endpoint filters before ranking: require tool support, `context_length >= 64k`,
   `max_completion_tokens >= 8k`, uptime >= 90%.
5. Discount `d`: the endpoint's `pricing.discount` field from OpenRouter.
6. DB: bun:sqlite in the global OpenCode data dir (`~/.local/share/opencode/`,
   honors `XDG_DATA_HOME`), file `openrouter-optimizer.db`.

## Data flow

```
http.request hook (scoped: URL contains openrouter.ai or providerID "openrouter")
  -> resolve model from the event model ref, else from the body
  -> look up the in-process routing cache (warmed from DB at setup; DB read only on first sight)
  -> if stale, not backing off: kick a background refresh task
  -> if a blacklist exists: inspect request.clone(), inject provider, rebuild the Request
  -> otherwise leave the original request and body untouched

background refresh task (never the request path, single-flight per model):
     GET /api/v1/models/{author}/{slug}/endpoints      (public, no auth)
     opencode stats --json --models --days 30          (global snapshot, cached + single-flight)
     GET /api/v1/activity (when a management key is set)
     compute per-provider perRequest cost with the user formula
     filter endpoints, rank, keep top 3, persist one compact routing snapshot
     on failure: persist attempt count + retry_after (30s doubling to 1h, jittered)
```

## Ranking math

For each provider endpoint (rates adjusted by the endpoint discount
`d = pricing.discount`):

- `inputRate` = `pricing.prompt * (1 - d)`
- `outputRate` = `pricing.completion * (1 - d)`
- `readRate` = `(pricing.input_cache_read ?? pricing.prompt) * (1 - d)`
- `writeRate` = `(pricing.input_cache_write ?? 0) * (1 - d)`
- cache hit rate `h` = reads / total input (0 when unknown), clamped to [0, 1]

```
perRequest = T_in * (h * readRate + (1 - h) * (inputRate + writeRate))
           + T_out * outputRate
total      = perRequest * numRequests
```

`total` ordering equals `perRequest` ordering (`numRequests` is the same constant for
every provider), but `total` is stored for display. One provider slug may hold several
endpoints (aliases, quantizations); the provider's cost is its best surviving endpoint.
Providers are ranked ascending on `perRequest`; the top `topN` (default 3) survive,
every other seen provider slug goes into the blacklist.

**Free mode.** On a canonical (non-`:free`) slug, if any *filter-passing* provider
endpoint serves input and output at $0, the ranker switches to `mode: "free"`: every
free provider survives (topN does not cap them) and the blacklist contains exactly the
paid providers. Judging free status only on filtered endpoints prevents a broken free
alias from blacklisting every paid provider and leaving no usable route.
`preferFreeProviders: false` restores plain top-3-by-cost.

## Stats merge (hybrid)

Per normalized model key (lowercase, `.` -> `-`, OpenRouter variant suffixes like
`:free` stripped, suffix match across provider prefixes):

- OpenRouter activity rows: `requests`, `prompt_tokens`, `completion_tokens`,
  `cached_tokens` summed client-side per model.
- OpenCode stats CLI rows: `opencode stats --json --models --days 30`. Per model, the
  `steps` count is the request count and the token breakdown is summed; variant rows of
  the same base slug are merged. Local totals are approximated as
  `input + cache.read + cache.write` total input, `cache.read` as the cached part,
  `output + reasoning` as output. This is a best-effort normalization across providers
  that report cache differently. The snapshot covers the machine's whole OpenCode
  history (including sessions before the plugin was installed) and is cached +
  single-flighted, so many models refreshed in the same TTL window share one run.
- Combined: weighted averages over the pooled request counts; either side alone is fine
  and both empty fall back to configurable defaults (20k in / 800 out / h=0.2).

## DB schema

```sql
CREATE TABLE fetches (         -- one row per OpenRouter slug
  model TEXT PRIMARY KEY,
  last_fetched INTEGER,       -- NULL until first successful fetch
  last_attempt INTEGER,       -- last refresh start, success or failure
  attempts INTEGER NOT NULL DEFAULT 0,  -- consecutive failures
  retry_after INTEGER,        -- failure backoff deadline
  survivors_json TEXT,        -- compact: provider slugs allowed through
  blacklist_json TEXT,        -- compact: provider slugs injected into provider.ignore
  mode TEXT,                  -- "free" | "cheapest"
  computed_at INTEGER,
  details_json TEXT,          -- full ProviderRank[] only when debug is enabled
  updated_at INTEGER
);
```

Legacy `endpoints_json`/`rankings_json` databases are migrated on open: rankings are
folded into the compact columns, then the legacy payload columns are cleared and dropped.

## Files

```
index.ts                 plugin entry (Plugin.define)
src/config.ts            defaults + opencode.json options resolution
src/pricing.ts           pure formula
src/ranking.ts           endpoint filtering, provider ranking, routing injection
src/openrouter.ts        endpoints + activity API clients
src/db.ts                bun:sqlite access layer, compact routing snapshot + migration
src/stats.ts             opencode stats CLI runner (cached, single-flight) + hybrid merge
src/plugin.ts            wiring: in-memory routing cache, hooks, background refresh
scripts/inspect.ts       dump db state ({ "inspect": "bun run scripts/inspect.ts" })
scripts/selfcheck.ts     live smoke check against the OpenRouter API
test/                    bun test: pricing formula, ranking, merge math, db round-trip
```

## Edge cases handled

- `:free` / variant suffixes: endpoints fetch strips the suffix on 404 and retries.
- Endpoints API or Activity API failure: keep the last known rankings, log quietly, and
  back off (30s doubling to 1h, jittered) instead of retrying on every request.
- Non-JSON bodies or body less than a slug: untouched.
- `content-length` of a rewritten request is dropped so the runtime recalculates it.
- A request is only rebuilt when a routing block is actually injected; otherwise the
  original body stream is preserved via `request.clone()` inspection.
- Endpoints and Activity calls have a 15s timeout composed with the plugin shutdown signal.
- Any hook error is caught and the request continues unmodified.
- Providers that vanish from the endpoints list between fetches are cleared from the
  blacklist, and new providers are never added to the blacklist until ranked.
- Free mode: paid providers are blacklisted the moment a filter-passing provider offers
  the model at $0; the next TTL refresh drops the mode if prices change.

## Assumptions

- OpenCode's stats `input` excludes cached tokens; cached coverage comes from
  `cache.read`/`cache.write`. Documented as best-effort for cross-provider merging.
- `opencode stats --json --models` row shape (`steps`, `tokens.*`, variant rows) is a
  documented CLI surface; a parser that sees an unfamiliar shape degrades to an empty
  local profile and ranking still works on the OpenRouter side + fallbacks.
- The OpenRouter account's activity rows cover every client of that account, which is
  the intended "same kind of request" pool.
