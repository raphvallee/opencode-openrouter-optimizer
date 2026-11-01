# opencode-openrouter-optimizer

OpenCode v2 plugin (Bun + TypeScript) that keeps OpenRouter routing cheap:

- Tracks every OpenRouter model used by OpenCode.
- Per model, fetches prices-per-provider (`GET /api/v1/models/{slug}/endpoints`), computes
  a compact routing snapshot (survivors, blacklist, mode) and stores it in sqlite with
  `last_fetched` plus retry/backoff state. The snapshot is cached in memory, so the request
  path does no database reads for known models.
- Computes the expected cost per request from OpenRouter Activity aggregates plus
  OpenCode's own usage stats (`opencode stats --json --models --days 30`, run only in
  the background refresh task with a cached single-flight snapshot), ranks providers,
  keeps the 3 cheapest and blacklists the rest by injecting `provider.ignore`
  (plus `provider.sort: "price"`) into every request.
- A model seen for the first time waits for its ranking before the request is sent, so the
  first prompt already goes to the provider the session will keep using. Switching after
  the fact would pay a cache-write charge twice on providers that bill for cache writes.
  Later requests use the in-memory snapshot; the 6h TTL refresh runs in the background and
  applies to the next request. A refresh that fails or exceeds `rankingWaitMs` releases the
  request unmodified instead of hanging it. Pass-through requests are inspected from a clone
  and are never re-serialized; only requests that receive a routing block are rebuilt.

## Cost model

```
Rate     = BaseRate * (1 - d)          d = pricing.discount from the endpoints API
readRate = input_cache_read ?? prompt
writeRate= input_cache_write ?? 0
perRequest = T_in * (h*readRate + (1-h)*(inputRate + writeRate)) + T_out * outputRate
total      = perRequest * numRequests
```

`T_in`, `T_out`, `h`, `numRequests` are merged from OpenCode usage (all providers,
because OpenCode request shapes do not depend on the provider) and OpenRouter Activity
rows (all clients using the OpenRouter account), treated as equals. Providers claim the
best surviving endpoint among the aliases they expose. Endpoints without tool support,
under 64k context, under 8k max completion tokens, under 90% uptime, or with missing or
unparseable prices are excluded from ranking and blacklisted alongside the non-surviving
providers, so the injected `provider.sort: "price"` cannot steer traffic to a
cheap-but-broken endpoint. An endpoint whose prices cannot be parsed (`""`, `"N/A"`, ...)
is treated as unknown pricing, never as free or $0. When no endpoint passes the filters,
the plugin passes requests through (only `extraIgnore` is enforced) rather than blocking
every known route; `provider.sort` is only injected when at least one survivor exists.

### Free-priority mode

Set `preferFreeProviders: false` to disable. When a canonical (non-`:free`) model still
has providers serving it at $0 (input, output and cache prices all parse to zero), the
ranker switches to `free` mode: every free provider stays routable (the top-3 cap does
not apply) and the blacklist is exactly the paid providers. Free status is judged only
on endpoints that pass the filters, so one broken free alias cannot leave the session
without a usable route.

## Install

Add the published package to `opencode.jsonc`:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-openrouter-optimizer"]
}
```

Pass options in object form:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-openrouter-optimizer",
      "options": {
        "ttlHours": 6,
        "topN": 3,
        "debug": true
      }
    }
  ]
}
```

A local clone can be loaded the same way, by path:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "D:/t3-projects/opencode-openrouter-optimizer",
      "options": { "debug": true }
    }
  ]
}
```

Optional: export `OPENROUTER_MANAGEMENT_KEY` (a management key from
openrouter.ai Settings > Management Keys, not an inference key) to enrich the profile
with 30 days of OpenRouter account activity. Without it, ranking uses OpenCode-side
usage and the fallback profile until real data accumulates.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `ttlHours` | `6` | Prices/refresh staleness window |
| `topN` | `3` | Cheapest providers allowed through |
| `minContextLength` | `64000` | Endpoint context filter |
| `minMaxCompletionTokens` | `8000` | Endpoint output-cap filter (3072-token style providers are excluded) |
| `minUptimePercent` | `90` | Endpoint uptime filter |
| `maxToolCallErrorRate` | `1` | Provider Tool Call Error Rate cap in percent; providers above it are filtered out and blacklisted. `100` disables |
| `requireToolSupport` | `true` | Require `tools`+`tool_choice` params |
| `injectSort` | `true` | Add `provider.sort: "price"` |
| `rankingWaitMs` | `15000` | Max time a first request waits for its initial ranking; `0` disables waiting (pass through immediately) |
| `fallbackAvgInput` / `fallbackAvgOutput` / `fallbackCacheHitRate` | `20000` / `800` / `0.2` | Fallback profile until stats exist |
| `preferFreeProviders` | `true` | $0 providers ("free mode") always stay routable; paid providers get blacklisted |
| `extraIgnore` | `[]` | Provider slugs always blacklisted |
| `managementKeyEnv` | `OPENROUTER_MANAGEMENT_KEY` | Env var name for the Activity key |
| `statsCommand` | `opencode` | CLI used for `stats --json` (background only) |
| `statsDays` | `30` | Stats window, aligned with the Activity 30-day aggregate |
| `statsCacheMinutes` | `10` | Stats snapshot cache; concurrent refreshes share one snapshot |
| `dbPath` | global OpenCode data dir | sqlite file override (tests) |
| `debug` | `false` | Verbose logging |

The DB lives next to OpenCode's own storage (`~/.local/share/opencode`, honoring
`XDG_DATA_HOME`) as `openrouter-optimizer.db`; every OpenCode instance and project
feeds the same stats.

## Inspect the state

```sh
bun run inspect
```

prints fetch/rank state (last fetch, survivors, blacklist size). OpenCode-side token
usage now comes straight from OpenCode's own `stats --json` (no plugin-side copy).

To preview exactly what the plugin's local stats side sees:

```sh
bun run scripts/stats-probe.ts
```

Optional live network check (no OpenCode needed):

```sh
bun run selfcheck [vendor/model]
```

## Development

```sh
bun install
bun test       # unit tests: pricing formula, ranking, stats merge, db round-trip
bun run typecheck
bun run scripts/perf-probe.ts --live   # hot-path + snapshot size probe
```
