import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, resolveOptions } from "../src/config"
import { composeRouting, filterEndpoint, rankProviders, providerSlug, type OpenRouterEndpoint } from "../src/ranking"
import { isFreePricing } from "../src/pricing"

function endpoint(overrides: Partial<OpenRouterEndpoint> = {}): OpenRouterEndpoint {
  return {
    name: "X | test-model",
    model_id: "vendor/test-model",
    context_length: 128_000,
    max_completion_tokens: 16_384,
    max_prompt_tokens: null,
    pricing: { prompt: "0.0000001", completion: "0.0000003", discount: 0 },
    provider_name: "X",
    tag: `${overrides.provider_name ?? "vendor"}/fp8`,
    supported_parameters: ["tools", "tool_choice", "max_tokens"],
    status: 0,
    uptime_last_30m: 100,
    uptime_last_1d: 100,
    ...overrides,
  }
}

const profile = { avgInput: 10_000, avgOutput: 1_000, cacheHitRate: 0.5, numRequests: 120 }

describe("providerSlug", () => {
  test("uses the tag prefix", () => {
    expect(providerSlug(endpoint({ tag: "deepinfra/turbo", provider_name: "DeepInfra" }))).toBe("deepinfra")
  })

  test("falls back to the provider name", () => {
    expect(providerSlug(endpoint({ tag: "", provider_name: "Akash ML" }))).toBe("akash-ml")
  })
})

describe("filterEndpoint", () => {
  test("drops providers without tool support", () => {
    const reasons = filterEndpoint(
      endpoint({ supported_parameters: ["response_format"], tag: "x1/fp8", provider_name: "x1" }),
      DEFAULT_OPTIONS,
    )
    expect(reasons).toEqual(["tools"])
  })

  test("drops small context and tiny completion caps and low uptime", () => {
    expect(filterEndpoint(endpoint({ context_length: 24_000 }), DEFAULT_OPTIONS)).toEqual(["context"])
    expect(filterEndpoint(endpoint({ max_completion_tokens: 4_096 }), DEFAULT_OPTIONS)).toEqual(["completion"])
    expect(filterEndpoint(endpoint({ uptime_last_30m: 80 }), DEFAULT_OPTIONS)).toEqual(["uptime"])
  })

  test("drops endpoints with missing or unparseable pricing", () => {
    expect(filterEndpoint(endpoint({ pricing: { prompt: "", completion: "" } }), DEFAULT_OPTIONS)).toEqual(["pricing"])
    expect(filterEndpoint(endpoint({ pricing: { prompt: "N/A", completion: "0.0000005" } }), DEFAULT_OPTIONS)).toEqual(["pricing"])
    expect(filterEndpoint(endpoint({ pricing: { prompt: "0.0000001", completion: "" } }), DEFAULT_OPTIONS)).toEqual(["pricing"])
  })

  test("reports every failed check, not just the first", () => {
    // Small context, low uptime and no tool support all fail on one endpoint.
    expect(
      filterEndpoint(
        endpoint({ context_length: 24_000, uptime_last_30m: 40, supported_parameters: ["response_format"] }),
        DEFAULT_OPTIONS,
      ),
    ).toEqual(["uptime", "context", "tools"])
    // Low uptime plus a tiny completion cap.
    expect(filterEndpoint(endpoint({ uptime_last_30m: 80, max_completion_tokens: 4_096 }), DEFAULT_OPTIONS)).toEqual([
      "uptime",
      "completion",
    ])
  })

  test("drops an unparseable cache-write price but accepts an unknown cache-read price", () => {
    expect(
      filterEndpoint(
        endpoint({ pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_write: "N/A" } }),
        DEFAULT_OPTIONS,
      ),
    ).toEqual(["pricing"])
    expect(
      filterEndpoint(
        endpoint({ pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "N/A" } }),
        DEFAULT_OPTIONS,
      ),
    ).toEqual([])
  })

  test("accepts a healthy endpoint", () => {
    expect(filterEndpoint(endpoint(), DEFAULT_OPTIONS)).toEqual([])
  })
})

describe("rankProviders", () => {
  const endpoints = [
    endpoint({ provider_name: "alpha", tag: "alpha/turbo", pricing: { prompt: "0.0000004", completion: "0.0000004" } }),
    endpoint({ provider_name: "beta", tag: "beta/fp8", pricing: { prompt: "0.0000001", completion: "0.0000002" } }),
    endpoint({ provider_name: "gamma", tag: "gamma/fp16", pricing: { prompt: "0.0000002", completion: "0.0000003" } }),
    endpoint({ provider_name: "delta", tag: "delta/fp8", pricing: { prompt: "0.0000003", completion: "0.0000006" } }),
    endpoint({ provider_name: "epsilon", tag: "epsilon/fp8", pricing: { prompt: "0.0000006", completion: "0.0000008" } }),
    // alias endpoint for beta, slightly cheaper completion: still one "beta" slug
    endpoint({ provider_name: "beta", tag: "beta/fp16", pricing: { prompt: "0.0000001", completion: "0.0000001" } }),
    // broken endpoint: filtered out entirely
    endpoint({ provider_name: "theta", tag: "theta/fp8", uptime_last_30m: 40 }),
  ]

  test("ranks by per-request cost with one entry per provider and best endpoint wins", () => {
    const ranking = rankProviders(endpoints, profile, DEFAULT_OPTIONS)
    expect(ranking.rankings.map((rank) => rank.slug)).toEqual(["beta", "gamma", "delta", "alpha", "epsilon"])
    expect(ranking.survivors).toEqual(["beta", "gamma", "delta"])
    // input 10k * (0.5*1e-7 + 0.5*(1e-7 + 0)) = 1e-3 ; output 1k * 1e-7 = 1e-4
    expect(ranking.rankings[0].perRequest).toBeCloseTo(0.0011)
    expect(ranking.rankings[0].total).toBeCloseTo(0.0011 * 120)
  })

  test("blacklist contains every non-surviving provider, filtered-out providers and extraIgnore", () => {
    const options = { ...DEFAULT_OPTIONS, extraIgnore: ["zed"] }
    const ranking = rankProviders(endpoints, profile, options)
    // theta was filtered out (low uptime), but it is a known provider slug: with
    // survivors present it is blacklisted so sort:"price" cannot steer traffic to it.
    expect(ranking.blacklist).toEqual(["alpha", "epsilon", "theta", "zed"])
  })

  test("filtered-out providers are only enforced when a survivor keeps the route open", () => {
    // Every endpoint filtered out and the floor is off: survivors is empty, so only
    // extraIgnore applies and requests pass through rather than losing every known
    // route.
    const options = { ...DEFAULT_OPTIONS, extraIgnore: ["zed"], keepAtLeastN: 0 }
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "theta", tag: "theta/fp8", uptime_last_30m: 40 }),
        endpoint({ provider_name: "iota", tag: "iota/fp8", context_length: 24_000 }),
      ],
      profile,
      options,
    )
    expect(ranking.survivors).toEqual([])
    expect(ranking.blacklist).toEqual(["zed"])
  })

  test("discounted providers rank with d applied", () => {
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "alpha", tag: "alpha/turbo", pricing: { prompt: "0.000001", completion: "0.000001", discount: 0.5 } }),
        endpoint({ provider_name: "beta", tag: "beta/fp8", pricing: { prompt: "0.0000008", completion: "0.0000008" } }),
      ],
      profile,
      DEFAULT_OPTIONS,
    )
    // alpha effective prompt 0.0000005 < beta 0.0000008
    expect(ranking.survivors).toEqual(["alpha", "beta"])
  })

  test("fewer than topN survivors yields an empty blacklist", () => {
    const ranking = rankProviders(endpoints.slice(0, 2), profile, DEFAULT_OPTIONS)
    expect(ranking.survivors).toEqual(["beta", "alpha"])
    expect(ranking.blacklist).toEqual([])
  })

  test("unparseable pricing is an automatic blacklist, never free mode", () => {
    const junk = endpoint({ provider_name: "junk", tag: "junk/fp8", pricing: { prompt: "", completion: "" } })
    const ranking = rankProviders([junk, ...endpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("cheapest")
    expect(ranking.survivors).toEqual(["beta", "gamma", "delta"])
    expect(ranking.blacklist).toContain("junk")

    // A junk-priced endpoint alone must not poison the mode into "free".
    const onlyJunk = rankProviders(
      [endpoint({ provider_name: "junk", tag: "junk/fp8", pricing: { prompt: "N/A", completion: "N/A" } })],
      profile,
      DEFAULT_OPTIONS,
    )
    expect(onlyJunk.mode).toBe("cheapest")
    expect(onlyJunk.survivors).toEqual([])
    expect(onlyJunk.blacklist).toEqual([])
  })

  test("an unparseable cache-write price is blacklisted like other unknown pricing", () => {
    const junkWrite = endpoint({
      provider_name: "junkwrite",
      tag: "junkwrite/fp8",
      pricing: { prompt: "0.0000001", completion: "0.0000002", input_cache_write: "N/A" },
    })
    const ranking = rankProviders([junkWrite, ...endpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.survivors).not.toContain("junkwrite")
    expect(ranking.blacklist).toContain("junkwrite")
  })

  test("an unparseable cache-read price is not blacklisted and bills cached input at the input rate", () => {
    const readUnknown = endpoint({
      provider_name: "readunknown",
      tag: "readunknown/fp8",
      pricing: { prompt: "0.0000001", completion: "0.0000001", input_cache_read: "N/A" },
    })
    const ranking = rankProviders([readUnknown], profile, DEFAULT_OPTIONS)
    expect(ranking.survivors).toEqual(["readunknown"])
    expect(ranking.blacklist).toEqual([])
    // h = 0.5: no cache discount, so cached and uncached input both bill at 1e-7.
    expect(ranking.rankings[0].perRequest).toBeCloseTo(10_000 * 0.0000001 + 1_000 * 0.0000001)
  })

  test("blacklistReasons explains every blocked provider, with all reasons listed", () => {
    const options = { ...DEFAULT_OPTIONS, extraIgnore: ["zed"] }
    const ranking = rankProviders(endpoints, profile, options)
    expect(ranking.blacklist).toEqual(["alpha", "epsilon", "theta", "zed"])
    // alpha/epsilon lose the price race, theta fails the uptime filter, zed is the
    // user's explicit instruction.
    expect(ranking.blacklistReasons).toEqual({
      alpha: ["not-cheapest"],
      epsilon: ["not-cheapest"],
      theta: ["uptime"],
      zed: ["extra-ignore"],
    })
  })

  test("blacklistReasons lists multiple reasons for a provider with several causes", () => {
    const options = { ...DEFAULT_OPTIONS, extraIgnore: ["alpha"] }
    const ranking = rankProviders(endpoints, profile, options)
    // alpha is both too expensive for topN and explicitly ignored.
    expect(ranking.blacklist).toContain("alpha")
    expect(ranking.blacklistReasons?.alpha).toEqual(["not-cheapest", "extra-ignore"])
  })

  test("blacklistReasons reasons filters before pricing and covers every blacklist entry", () => {
    const junk = endpoint({ provider_name: "junk", tag: "junk/fp8", pricing: { prompt: "", completion: "" } })
    const ranking = rankProviders([junk, ...endpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.blacklistReasons?.junk).toEqual(["pricing"])
    for (const slug of ranking.blacklist) {
      expect(ranking.blacklistReasons?.[slug]).not.toBeNull()
      expect((ranking.blacklistReasons?.[slug] ?? []).length).toBeGreaterThan(0)
    }
  })
})

describe("keepAtLeastN floor", () => {
  /** A provider that passes every filter. */
  const good = (name: string) => endpoint({ provider_name: name, tag: `${name}/fp8` })

  test("keeps the provider that fails least hard when the filters starve the routing", () => {
    // Every provider fails: uptime 89.9 misses the 90% threshold by a hair, 80 misses
    // it by 10 points, 10 misses it by 80. The lightest miss stands.
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "near", tag: "near/fp8", uptime_last_30m: 89.9 }),
        endpoint({ provider_name: "mid", tag: "mid/fp8", uptime_last_30m: 80 }),
        endpoint({ provider_name: "far", tag: "far/fp8", uptime_last_30m: 10 }),
      ],
      profile,
      DEFAULT_OPTIONS,
    )
    expect(ranking.survivors).toEqual(["near"])
    expect(ranking.rescued).toEqual(["near"])
    // The providers that failed harder stay blacklisted.
    expect(ranking.blacklist).toEqual(["mid", "far"])
  })

  test("counts how hard the miss was, not just which check failed", () => {
    // A 24k context misses the 64k window harder than an 80% uptime misses the 90%
    // one, so the uptime provider is the better rescue candidate.
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "small", tag: "small/fp8", context_length: 24_000 }),
        endpoint({ provider_name: "flaky", tag: "flaky/fp8", uptime_last_30m: 80 }),
      ],
      profile,
      DEFAULT_OPTIONS,
    )
    expect(ranking.rescued).toEqual(["flaky"])
    expect(ranking.survivors).toEqual(["flaky"])
  })

  test("rescue candidates are only added until the floor is met", () => {
    const options = { ...DEFAULT_OPTIONS, keepAtLeastN: 2 }
    const ranking = rankProviders(
      [
        good("alpha"),
        endpoint({ provider_name: "near", tag: "near/fp8", uptime_last_30m: 89.9 }),
        endpoint({ provider_name: "mid", tag: "mid/fp8", uptime_last_30m: 80 }),
        endpoint({ provider_name: "far", tag: "far/fp8", uptime_last_30m: 10 }),
      ],
      profile,
      options,
    )
    // alpha passed the filters, near fills the floor, mid and far stay blacklisted.
    expect(ranking.survivors).toEqual(["alpha", "near"])
    expect(ranking.rescued).toEqual(["near"])
    expect(ranking.blacklist).toEqual(["mid", "far"])
  })

  test("a provider that already stands is never rescued", () => {
    const ranking = rankProviders(
      [good("alpha"), endpoint({ provider_name: "near", tag: "near/fp8", uptime_last_30m: 89.9 })],
      profile,
      { ...DEFAULT_OPTIONS, keepAtLeastN: 3 },
    )
    expect(ranking.rescued).toEqual(["near"])
    expect(ranking.survivors).toEqual(["alpha", "near"])
    expect(ranking.blacklist).toEqual([])
  })

  test("does not rescue anything when the filters left enough providers standing", () => {
    const ranking = rankProviders([good("alpha"), good("beta")], profile, DEFAULT_OPTIONS)
    expect(ranking.rescued).toEqual([])
    expect(ranking.survivors).toEqual(["alpha", "beta"])
  })

  test("keepAtLeastN=0 disables the fallback", () => {
    const ranking = rankProviders(
      [endpoint({ provider_name: "near", tag: "near/fp8", uptime_last_30m: 89.9 })],
      profile,
      { ...DEFAULT_OPTIONS, keepAtLeastN: 0 },
    )
    expect(ranking.rescued).toEqual([])
    expect(ranking.survivors).toEqual([])
    expect(ranking.blacklist).toEqual([])
  })

  test("a provider whose best alias is dead, unpriceable or tool-less is never rescued", () => {
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "dead", tag: "dead/fp8", status: 500 }),
        endpoint({ provider_name: "unpriced", tag: "unpriced/fp8", pricing: { prompt: "", completion: "" } }),
        endpoint({ provider_name: "notools", tag: "notools/fp8", supported_parameters: ["response_format"] }),
        endpoint({ provider_name: "flaky", tag: "flaky/fp8", uptime_last_30m: 89.9 }),
      ],
      profile,
      { ...DEFAULT_OPTIONS, keepAtLeastN: 3 },
    )
    // Only the flaky provider has an alias that could still work.
    expect(ranking.rescued).toEqual(["flaky"])
    expect(ranking.survivors).toEqual(["flaky"])
    expect(ranking.blacklist).toEqual(["dead", "unpriced", "notools"])
  })

  test("a provider with a dead alias is never rescued even when another alias only misses a threshold", () => {
    // Routing is provider-wide: a rescued "mixed" would put its dead alias back
    // on the route alongside the flaky one, so the provider is skipped.
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "mixed", tag: "mixed/dead", status: 500 }),
        endpoint({ provider_name: "mixed", tag: "mixed/flaky", uptime_last_30m: 89.9 }),
      ],
      profile,
      DEFAULT_OPTIONS,
    )
    expect(ranking.rescued).toEqual([])
    expect(ranking.survivors).toEqual([])
    expect(ranking.blacklist).toEqual([])
  })

  test("a tool-less or unpriced alias also blocks a rescue", () => {
    for (const overrides of [
      { supported_parameters: ["response_format"] },
      { pricing: { prompt: "", completion: "" } },
    ] as Partial<OpenRouterEndpoint>[]) {
      const ranking = rankProviders(
        [
          endpoint({ provider_name: "mixed", tag: "mixed/broken", ...overrides }),
          endpoint({ provider_name: "mixed", tag: "mixed/flaky", uptime_last_30m: 89.9 }),
        ],
        profile,
        DEFAULT_OPTIONS,
      )
      expect(ranking.rescued).toEqual([])
    }
  })

  test("a provider whose every alias is dead is never rescued", () => {
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "dead", tag: "dead/one", status: 500 }),
        endpoint({ provider_name: "dead", tag: "dead/two", status: 503 }),
      ],
      profile,
      DEFAULT_OPTIONS,
    )
    expect(ranking.rescued).toEqual([])
    expect(ranking.survivors).toEqual([])
    expect(ranking.blacklist).toEqual([])
  })

  test("a provider blocked by extraIgnore is never rescued", () => {
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "near", tag: "near/fp8", uptime_last_30m: 89.9 }),
        endpoint({ provider_name: "mid", tag: "mid/fp8", uptime_last_30m: 80 }),
      ],
      profile,
      { ...DEFAULT_OPTIONS, keepAtLeastN: 2, extraIgnore: ["near"] },
    )
    expect(ranking.rescued).toEqual(["mid"])
    expect(ranking.survivors).toEqual(["mid"])
    expect(ranking.blacklist).toEqual(["near"])
  })

  test("in free mode only a free provider is rescued", () => {
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "freegood", tag: "freegood/fp8", pricing: { prompt: "0", completion: "0" } }),
        endpoint({
          provider_name: "freeflaky",
          tag: "freeflaky/fp8",
          pricing: { prompt: "0", completion: "0" },
          uptime_last_30m: 89.9,
        }),
        endpoint({
          provider_name: "paidflaky",
          tag: "paidflaky/fp8",
          pricing: { prompt: "0.0000001", completion: "0.0000002" },
          uptime_last_30m: 89.9,
        }),
      ],
      profile,
      { ...DEFAULT_OPTIONS, keepAtLeastN: 2 },
    )
    expect(ranking.mode).toBe("free")
    expect(ranking.survivors).toEqual(["freegood", "freeflaky"])
    expect(ranking.rescued).toEqual(["freeflaky"])
    expect(ranking.blacklist).toEqual(["paidflaky"])
  })

  test("in free mode a provider that also carries a paid alias is never rescued", () => {
    // A rescued slug is routable as a whole: its paid aliases would go back on
    // the route and break free mode. Only an all-free provider can stand.
    const ranking = rankProviders(
      [
        endpoint({ provider_name: "freegood", tag: "freegood/fp8", pricing: { prompt: "0", completion: "0" } }),
        endpoint({
          provider_name: "mixedfree",
          tag: "mixedfree/free",
          pricing: { prompt: "0", completion: "0" },
          uptime_last_30m: 89.9,
        }),
        endpoint({
          provider_name: "mixedfree",
          tag: "mixedfree/paid",
          pricing: { prompt: "0.0000001", completion: "0.0000002" },
          uptime_last_30m: 89.8,
        }),
      ],
      profile,
      { ...DEFAULT_OPTIONS, keepAtLeastN: 2 },
    )
    expect(ranking.mode).toBe("free")
    expect(ranking.survivors).toEqual(["freegood"])
    expect(ranking.rescued).toEqual([])
    expect(ranking.blacklist).toEqual(["mixedfree"])
  })

  test("preferFreeProviders rescues free providers before paid ones", () => {
    // No free provider passes the filters, so the mode is cheapest - but the
    // user's free preference still orders the rescue: the free provider stands
    // even though the paid one failed the filters less hard.
    const ranking = rankProviders(
      [
        endpoint({
          provider_name: "freefar",
          tag: "freefar/fp8",
          pricing: { prompt: "0", completion: "0" },
          uptime_last_30m: 10,
        }),
        endpoint({ provider_name: "paidnear", tag: "paidnear/fp8", uptime_last_30m: 89.9 }),
      ],
      profile,
      DEFAULT_OPTIONS,
    )
    expect(ranking.mode).toBe("cheapest")
    expect(ranking.rescued).toEqual(["freefar"])
    expect(ranking.survivors).toEqual(["freefar"])
    expect(ranking.blacklist).toEqual(["paidnear"])
  })

  test("preferFreeProviders=false keeps the severity ordering in the rescue", () => {
    const options = resolveOptions({ preferFreeProviders: false })
    const ranking = rankProviders(
      [
        endpoint({
          provider_name: "freefar",
          tag: "freefar/fp8",
          pricing: { prompt: "0", completion: "0" },
          uptime_last_30m: 10,
        }),
        endpoint({ provider_name: "paidnear", tag: "paidnear/fp8", uptime_last_30m: 89.9 }),
      ],
      profile,
      options,
    )
    expect(ranking.rescued).toEqual(["paidnear"])
    expect(ranking.survivors).toEqual(["paidnear"])
    expect(ranking.blacklist).toEqual(["freefar"])
  })

  test("a rescued provider's rank entry reports the cheapest failing alias, as routing would bill it", () => {
    // Two failing aliases: the least-bad one (uptime 89.9) wins the rescue
    // decision, but sort: "price" makes OpenRouter try the cheapest one first.
    const ranking = rankProviders(
      [
        endpoint({
          provider_name: "two",
          tag: "two/slow",
          pricing: { prompt: "0.0000002", completion: "0.0000004" },
          uptime_last_30m: 89.9,
        }),
        endpoint({
          provider_name: "two",
          tag: "two/cheap",
          pricing: { prompt: "0.0000001", completion: "0.0000001" },
          uptime_last_30m: 89.8,
        }),
      ],
      profile,
      DEFAULT_OPTIONS,
    )
    const entry = ranking.rankings.find((rank) => rank.slug === "two")
    expect(entry?.rescued).toBe(true)
    // The routed alias is the cheap one; the rescue reason is the light miss.
    expect(entry?.perRequest).toBeCloseTo(10_000 * 0.0000001 + 1_000 * 0.0000001)
    expect(entry?.failedReasons).toEqual(["uptime"])
  })

  test("the rescued provider is marked with the checks it failed", () => {
    const ranking = rankProviders(
      [endpoint({ provider_name: "flaky", tag: "flaky/fp8", uptime_last_30m: 89.9 })],
      profile,
      DEFAULT_OPTIONS,
    )
    const entry = ranking.rankings.find((rank) => rank.slug === "flaky")
    expect(entry?.rescued).toBe(true)
    expect(entry?.failedReasons).toEqual(["uptime"])
  })

  test("the standing count stops at keepAtLeastN", () => {
    const many = ["n1", "n2", "n3", "n4"].map((name) =>
      endpoint({ provider_name: name, tag: `${name}/fp8`, uptime_last_30m: 89.9 }),
    )
    const ranking = rankProviders(many, profile, { ...DEFAULT_OPTIONS, keepAtLeastN: 2 })
    expect(ranking.survivors).toHaveLength(2)
    // The two least-bad misses stand; the others stay blacklisted.
    expect(ranking.rescued).toHaveLength(2)
    expect(ranking.blacklist).toHaveLength(2)
  })
})

describe("composeRouting", () => {
  test("injects ignore and sort, preserving user-provided provider options", () => {
    const routing = composeRouting({ require_parameters: true }, ["alpha", "epsilon"], DEFAULT_OPTIONS)
    expect(routing).toEqual({ require_parameters: true, sort: "price", ignore: ["alpha", "epsilon"] })
  })

  test("array-form provider becomes an order preference instead of being dropped", () => {
    const routing = composeRouting(["alpha", "beta"], ["alpha"], DEFAULT_OPTIONS)
    expect(routing).toEqual({ order: ["alpha", "beta"], sort: "price", ignore: ["alpha"] })
  })

  test("without a blacklist only the sort is injected", () => {
    const routing = composeRouting(undefined, [], DEFAULT_OPTIONS)
    expect(routing).toEqual({ sort: "price" })
  })

  test("injectSort=false leaves the body routing-free until a blacklist exists", () => {
    const options = resolveOptions({ injectSort: false })
    expect(composeRouting(undefined, [], options)).toEqual({})
  })
})

describe("isFreePricing", () => {
  test("zero input and output is free regardless of formatting", () => {
    expect(isFreePricing({ prompt: "0", completion: "0" })).toBe(true)
    expect(isFreePricing({ prompt: "0.0", completion: "0.0", input_cache_read: "0" })).toBe(true)
    expect(isFreePricing({ prompt: 0, completion: 0 })).toBe(true)
  })

  test("any nonzero required side is paid", () => {
    expect(isFreePricing({ prompt: "0", completion: "0.0000001" })).toBe(false)
    expect(isFreePricing({ prompt: "0.0000001", completion: "0" })).toBe(false)
  })
})

describe("free-priority mode", () => {
  const paidEndpoints = [
    endpoint({ provider_name: "alpha", tag: "alpha/turbo", pricing: { prompt: "0.0000001", completion: "0.0000002" } }),
    endpoint({ provider_name: "beta", tag: "beta/fp8", pricing: { prompt: "0.0000002", completion: "0.0000004" } }),
    endpoint({ provider_name: "gamma", tag: "gamma/fp8", pricing: { prompt: "0.0000003", completion: "0.0000006" } }),
  ]
  const freeEndpoints = [
    endpoint({ provider_name: "zero1", tag: "zero1/fp8", pricing: { prompt: "0", completion: "0" } }),
    endpoint({ provider_name: "zero2", tag: "zero2/turbo-plus", pricing: { prompt: "0.0", completion: "0.0" } }),
    // "mixed" offers both a free alias and a paid alias; free counts once per slug
    endpoint({ provider_name: "mixed", tag: "mixed/fp8", pricing: { prompt: "0", completion: "0" } }),
    endpoint({ provider_name: "mixed", tag: "mixed/premium", pricing: { prompt: "0.0000001", completion: "0.0000002" } }),
  ]

  test("keeps every free provider routable and blacklists the paid ones", () => {
    const ranking = rankProviders([...paidEndpoints, ...freeEndpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("free")
    // topN is ignored in free mode: 3 free slugs survive even though topN = 3 here
    expect(ranking.survivors).toEqual(["mixed", "zero1", "zero2"])
    expect(ranking.blacklist).toEqual(["alpha", "beta", "gamma"])
    expect(ranking.rankings.every((rank) => rank.perRequest === 0)).toBe(true)
  })

  test("paid providers are blacklisted even when they would have been survivors", () => {
    const ranking = rankProviders(paidEndpoints, profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("cheapest")
    expect(ranking.survivors).toEqual(["alpha", "beta", "gamma"])

    const withFree = rankProviders([paidEndpoints[0], ...freeEndpoints], profile, DEFAULT_OPTIONS)
    expect(withFree.mode).toBe("free")
    expect(withFree.survivors).toEqual(["mixed", "zero1", "zero2"])
    expect(withFree.blacklist).toEqual(["alpha"])
  })

  test("free detection only counts endpoints that pass the filters", () => {
    // The free provider's only endpoint has a 24k context: filtered out, so the plugin
    // cannot rely on it and stays in cheapest mode. But free1 is a known slug and
    // survivors exist, so the broken endpoint's provider is blacklisted.
    const brokenFree = endpoint({
      provider_name: "free1",
      tag: "free1/fp8",
      pricing: { prompt: "0", completion: "0" },
      context_length: 24_000,
    })
    const ranking = rankProviders([brokenFree, ...paidEndpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("cheapest")
    expect(ranking.survivors).toEqual(["alpha", "beta", "gamma"])
    expect(ranking.blacklist).toEqual(["free1"])
  })

  test("an unparseable cache-write price cannot enter free mode", () => {
    const junkFree = endpoint({
      provider_name: "junkfree",
      tag: "junkfree/fp8",
      pricing: { prompt: "0", completion: "0", input_cache_write: "N/A" },
    })
    const ranking = rankProviders([junkFree, ...paidEndpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("cheapest")
    expect(ranking.survivors).toEqual(["alpha", "beta", "gamma"])
    expect(ranking.blacklist).toContain("junkfree")
  })

  test("free detection keys on the workload's context size (tiered pricing)", () => {
    // Free below 100K prompt tokens, paid above it: a long-context workload must not
    // trigger free mode, a short-context one should.
    const tieredFree = endpoint({
      provider_name: "tiered",
      tag: "tiered/fp8",
      pricing: {
        prompt: "0",
        completion: "0",
        overrides: [{ min_prompt_tokens: 100_000, prompt: "0.0000001", completion: "0" }],
      },
    })
    expect(rankProviders([tieredFree, ...paidEndpoints], { ...profile, avgInput: 200_000 }, DEFAULT_OPTIONS).mode).toBe(
      "cheapest",
    )
    expect(rankProviders([tieredFree, ...paidEndpoints], profile, DEFAULT_OPTIONS).mode).toBe("free")
  })

  test("an unknown cache-read price does not stop a zero-priced provider from being free", () => {
    const freeReadUnknown = endpoint({
      provider_name: "freeread",
      tag: "freeread/fp8",
      pricing: { prompt: "0", completion: "0", input_cache_read: "N/A" },
    })
    const ranking = rankProviders([freeReadUnknown, ...paidEndpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("free")
    expect(ranking.survivors).toContain("freeread")
  })

  test("preferFreeProviders=false restores the plain cost ranking", () => {
    const options = resolveOptions({ preferFreeProviders: false })
    const ranking = rankProviders([...paidEndpoints, ...freeEndpoints], profile, options)
    expect(ranking.mode).toBe("cheapest")
    // 0-cost endpoints still win the sort, but topN now caps survivors again
    expect(ranking.survivors).toEqual(["mixed", "zero1", "zero2"])
    expect(ranking.blacklist).toEqual(["alpha", "beta", "gamma"])
  })

  test("more free providers than topN are all kept in free mode", () => {
    const manyFree = ["f1", "f2", "f3", "f4"].map((name) =>
      endpoint({ provider_name: name, tag: `${name}/fp8`, pricing: { prompt: "0", completion: "0" } }),
    )
    const ranking = rankProviders(manyFree, profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("free")
    expect(ranking.survivors).toEqual(["f1", "f2", "f3", "f4"])
    expect(ranking.blacklist).toEqual([])
  })

  test("blacklistReasons reports paid-in-free-mode and skips non-blacklisted slugs", () => {
    const ranking = rankProviders([...paidEndpoints, ...freeEndpoints], profile, DEFAULT_OPTIONS)
    expect(ranking.mode).toBe("free")
    expect(ranking.blacklist).toEqual(["alpha", "beta", "gamma"])
    expect(ranking.blacklistReasons).toEqual({
      alpha: ["paid"],
      beta: ["paid"],
      gamma: ["paid"],
    })
  })
})
