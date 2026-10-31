import { describe, expect, test } from "bun:test"
import { mergeProfile, OpenCodeStats, parseStatsModels, pickProfile, normalizeModelKey } from "../src/stats"
import { sumActivity, type ActivityRow } from "../src/openrouter"

describe("normalizeModelKey", () => {
  test("lowercases, dot-normalizes and strips variants", () => {
    expect(normalizeModelKey("Meta-Llama/Llama-3.3-70B-Instruct")).toBe("meta-llama/llama-3-3-70b-instruct")
    expect(normalizeModelKey("meta-llama/llama-3-3-70b-instruct")).toBe("meta-llama/llama-3-3-70b-instruct")
    expect(normalizeModelKey("deepseek/deepseek-r1:free")).toBe("deepseek/deepseek-r1")
    expect(normalizeModelKey("openai/gpt-4.1#think")).toBe("openai/gpt-4-1")
  })
})

describe("sumActivity", () => {
  test("sums per-model rows only", () => {
    const rows: ActivityRow[] = [
      { date: "2026-01-01", model: "meta-llama/llama-3.3-70b-instruct", model_permaslug: "", endpoint_id: "e1", provider_name: "DeepInfra", requests: 3, prompt_tokens: 30_000, completion_tokens: 1_200, cached_tokens: 6_000, usage: 0.01 },
      { date: "2026-01-02", model: "meta-llama/llama-3.3-70b-instruct", model_permaslug: "", endpoint_id: "e2", provider_name: "Novita", requests: 2, prompt_tokens: 10_000, completion_tokens: 800, cached_tokens: 4_000, usage: 0.005 },
      { date: "2026-01-02", model: "openai/gpt-4.1", model_permaslug: "", endpoint_id: "e3", provider_name: "OpenAI", requests: 7, prompt_tokens: 70_000, completion_tokens: 3_000, usage: 0.2 },
    ]
    const summed = sumActivity(rows, "meta-llama/llama-3.3-70b-instruct")
    expect(summed.requests).toBe(5)
    expect(summed.promptTokens).toBe(40_000)
    expect(summed.completionTokens).toBe(2_000)
    expect(summed.cachedTokens).toBe(10_000)
  })
})

describe("parseStatsModels", () => {
  test("sums variant rows into one normalized profile per base slug", () => {
    const profiles = parseStatsModels(
      JSON.stringify({
        models: [
          { model: { id: "vendor/model", providerID: "openrouter", variant: "high" }, steps: 2, tokens: { input: 10_000, output: 500, reasoning: 100, cache: { read: 2_000, write: 3_000 } } },
          { model: { id: "vendor/model:preview", providerID: "openrouter", variant: "xhigh" }, steps: 1, tokens: { input: 5_000, output: 250, reasoning: 0, cache: { read: 1_000, write: 0 } } },
          { model: { id: "other/model" }, steps: 3, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        ],
      }),
    )
    const profile = profiles.get("vendor/model")!
    // steps behave like request counts
    expect(profile.requests).toBe(3)
    // total input counts read + write too; cache.read is the cached portion
    expect(profile.totalInput).toBe(21_000)
    expect(profile.cachedInput).toBe(3_000)
    expect(profile.totalOutput).toBe(850)
  })

  test("tolerates junk payloads and malformed rows", () => {
    expect(parseStatsModels("not json").size).toBe(0)
    expect(parseStatsModels("{}").size).toBe(0)
    expect(parseStatsModels('{"models": [null, {}, {"model": {"id": 5}}]}').size).toBe(0)
  })
})

describe("pickProfile", () => {
  const profiles = parseStatsModels(
    JSON.stringify({
      models: [
        { model: { id: "vendor/model" }, steps: 1, tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
        { model: { id: "meta-llama/llama-3-3-70b-instruct" }, steps: 2, tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } },
      ],
    }),
  )

  test("matches exact and normalized suffix keys", () => {
    expect(pickProfile(profiles, "vendor/model")?.requests).toBe(1)
    expect(pickProfile(profiles, "meta-llama/Llama-3.3-70B-Instruct")?.requests).toBe(2)
    expect(pickProfile(profiles, "llama-3.3-70b-instruct")?.requests).toBe(2)
  })

  test("returns undefined for unknown models", () => {
    expect(pickProfile(profiles, "unknown/other")).toBeUndefined()
    expect(pickProfile(new Map(), "vendor/model")).toBeUndefined()
  })
})

describe("OpenCodeStats", () => {
  const row = { model: { id: "vendor/model", providerID: "openrouter" }, steps: 4, tokens: { input: 8_000, output: 400, reasoning: 0, cache: { read: 1_600, write: 0 } } }

  test("caches within TTL and single-flights concurrent calls", async () => {
    let calls = 0
    const stats = new OpenCodeStats({
      ttlMs: 60_000,
      run: async (args) => {
        calls++
        expect(args[1]).toBe("stats")
        expect(args[2]).toBe("--json")
        expect(args[3]).toBe("--models")
        expect(args[4]).toBe("--days")
        expect(args[5]).toBe("30")
        return JSON.stringify({ models: [row] })
      },
    })

    const [a, b] = await Promise.all([stats.get(), stats.get()])
    expect(calls).toBe(1)
    expect(a.get("vendor/model")?.requests).toBe(4)
    expect(b.get("vendor/model")?.requests).toBe(4)

    await stats.get()
    expect(calls).toBe(1)

    stats.invalidate()
    await stats.get()
    expect(calls).toBe(2)
  })

  test("pick reuses the cached suffix index", async () => {
    const stats = new OpenCodeStats({
      ttlMs: 60_000,
      run: async () =>
        JSON.stringify({
          models: [
            { model: { id: "meta-llama/llama-3-3-70b-instruct" }, steps: 2, tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } },
            row,
          ],
        }),
    })
    await stats.get()
    expect(stats.pick("meta-llama/Llama-3.3-70B-Instruct")?.requests).toBe(2)
    expect(stats.pick("vendor/model")?.requests).toBe(4)
    expect(stats.pick("unknown/other")).toBeUndefined()
  })

  test("failures return the last good snapshot (or empty) and never throw", async () => {
    let fail = true
    const stats = new OpenCodeStats({
      ttlMs: 0,
      run: async () => {
        if (fail) throw new Error("boom")
        return JSON.stringify({ models: [row] })
      },
    })

    const empty = await stats.get()
    expect(empty.size).toBe(0)

    fail = false
    stats.invalidate()
    const good = await stats.get()
    expect(good.get("vendor/model")?.requests).toBe(4)

    fail = true
    stats.invalidate()
    const fallback = await stats.get()
    expect(fallback.get("vendor/model")?.requests).toBe(4)
  })

  test("a failed first fetch is held for the TTL instead of respawning the CLI every get()", async () => {
    let calls = 0
    const stats = new OpenCodeStats({
      ttlMs: 60_000,
      run: async () => {
        calls++
        throw new Error("boom")
      },
    })

    const empty = await stats.get()
    expect(empty.size).toBe(0)
    // Within the TTL, repeated get() calls reuse the failure window, not new processes.
    await stats.get()
    await stats.get()
    expect(calls).toBe(1)

    // An explicit invalidate() still forces a retry.
    stats.invalidate()
    await stats.get()
    expect(calls).toBe(2)
  })
})

describe("mergeProfile", () => {
  const fallback = { avgInput: 20_000, avgOutput: 800, cacheHitRate: 0.2 }

  test("falls back when both sides are empty", () => {
    const profile = mergeProfile(undefined, undefined, fallback)
    expect(profile.avgInput).toBe(20_000)
    expect(profile.avgOutput).toBe(800)
    expect(profile.cacheHitRate).toBe(0.2)
    expect(profile.numRequests).toBe(0)
  })

  test("pools OpenCode and OpenRouter data as equals", () => {
    const local = { requests: 2, totalInput: 50_000, cachedInput: 10_000, totalOutput: 2_000 }
    const remote = { requests: 2, promptTokens: 30_000, completionTokens: 1_000, cachedTokens: 6_000 }
    const profile = mergeProfile(local, remote, fallback)
    expect(profile.numRequests).toBe(4)
    // (50k + 30k) / 4
    expect(profile.avgInput).toBeCloseTo(20_000)
    // (2k + 1k) / 4
    expect(profile.avgOutput).toBeCloseTo(750)
    // (10k + 6k) / (50k + 30k)
    expect(profile.cacheHitRate).toBeCloseTo(0.2)
  })

  test("openrouter-only data computes clean averages", () => {
    const profile = mergeProfile(undefined, { requests: 4, promptTokens: 40_000, completionTokens: 2_000, cachedTokens: 10_000 }, fallback)
    expect(profile.avgInput).toBeCloseTo(10_000)
    expect(profile.avgOutput).toBeCloseTo(500)
    expect(profile.cacheHitRate).toBeCloseTo(0.25)
  })
})
