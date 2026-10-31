import { describe, expect, spyOn, test } from "bun:test"
import { definePlugin } from "../src/plugin"

const ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/vendor/model/endpoints"

function endpointsPayload() {
  return {
    data: {
      id: "vendor/model",
      name: "Vendor Model",
      endpoints: [
        { name: "A | m", model_id: "vendor/model", context_length: 128_000, max_completion_tokens: 32_768, max_prompt_tokens: null, pricing: { prompt: "0.0000001", completion: "0.0000002" }, provider_name: "A", tag: "alpha/fp8", supported_parameters: ["tools", "tool_choice"], status: 0, uptime_last_30m: 99 },
        { name: "B | m", model_id: "vendor/model", context_length: 128_000, max_completion_tokens: 32_768, max_prompt_tokens: null, pricing: { prompt: "0.0000002", completion: "0.0000003" }, provider_name: "B", tag: "beta/fp8", supported_parameters: ["tools", "tool_choice"], status: 0, uptime_last_30m: 99 },
        { name: "G | m", model_id: "vendor/model", context_length: 128_000, max_completion_tokens: 32_768, max_prompt_tokens: null, pricing: { prompt: "0.0000003", completion: "0.0000004" }, provider_name: "G", tag: "gamma/fp8", supported_parameters: ["tools", "tool_choice"], status: 0, uptime_last_30m: 99 },
        { name: "E | m", model_id: "vendor/model", context_length: 128_000, max_completion_tokens: 32_768, max_prompt_tokens: null, pricing: { prompt: "0.000001", completion: "0.000002" }, provider_name: "E", tag: "epsilon/fp8", supported_parameters: ["tools", "tool_choice"], status: 0, uptime_last_30m: 99 },
      ],
    },
  }
}

function openRouterRequest(model = "vendor/model"): Request {
  return new Request("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "42" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  })
}

function makeCtx(options = {}) {
  const hooks = new Map<string, { handler: (event: unknown) => Promise<void>; opts: unknown }>()
  const ctx = {
    options,
    event: {
      // Empty async iterable: no session events in this test.
      subscribe: async function* () {},
    },
    session: {
      hook: async (name: string, handler: (event: unknown) => Promise<void>, opts?: unknown) => {
        hooks.set(name, { handler, opts })
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, hooks }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("http.request hook", () => {
  test("first request passes through, next requests carry the blacklist", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    const savedFetch = globalThis.fetch
    const realFetch = savedFetch.bind(globalThis)
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === ENDPOINTS_URL && (init?.signal as AbortSignal | undefined)?.aborted !== true) {
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }))
      }
      return realFetch(input as never, init)
    }) as typeof fetch

    try {
      const { ctx, hooks } = makeCtx({})
      const plugin = definePlugin({
        dbPath: ":memory:",
        // Never spawn the real opencode CLI in tests: empty stats, merge falls back.
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never)
      const cleanup = await plugin.setup!(ctx as never)

      const handler = hooks.get("http.request")!.handler

      // Request 1: never-fetched model, must go out unmodified (no config yet) while the
      // background refresh computes prices.
      const evt1 = { request: openRouterRequest(), model: { providerID: "openrouter" }, kind: "primary" }
      await handler(evt1)
      const body1 = await (evt1 as { request: Request }).request.text()
      expect(JSON.parse(body1)?.provider).toBeUndefined()

      // Wait for the background ranking, then assert request 2 carries ignore + sort.
      let seen: { ignore: string[]; sort?: string } | undefined
      for (let attempt = 0; attempt < 40 && !seen; attempt++) {
        await sleep(25)
        const evt = { request: openRouterRequest(), model: { providerID: "openrouter" }, kind: "primary" }
        await handler(evt)
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as { provider?: { ignore?: string[]; sort?: string } }
        if (parsed.provider?.ignore && parsed.provider.ignore.length > 0) seen = { ignore: parsed.provider.ignore, sort: parsed.provider.sort }
      }
      expect(seen?.ignore).toEqual(["epsilon"])
      expect(seen?.sort).toBe("price")

      // Non-OpenRouter providers are untouched.
      const evt3 = {
        request: new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-anything", messages: [] }),
        }),
        model: { providerID: "anthropic" },
        kind: "primary",
      }
      await handler(evt3)
      expect(JSON.parse(await (evt3 as { request: Request }).request.text()).provider).toBeUndefined()

      await cleanup?.()
    } finally {
      globalThis.fetch = savedFetch
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv
    }
  }, 10_000)

  test("debug logging names the topN providers kept when routing", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    const savedFetch = globalThis.fetch
    const realFetch = savedFetch.bind(globalThis)
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === ENDPOINTS_URL) return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }))
      return realFetch(input as never, init)
    }) as typeof fetch

    const logs: string[] = []
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "))
    })

    try {
      const { ctx, hooks } = makeCtx({})
      const plugin = definePlugin({
        dbPath: ":memory:",
        debug: true,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never)
      const cleanup = await plugin.setup!(ctx as never)
      const handler = hooks.get("http.request")!.handler

      const evt1 = { request: openRouterRequest(), model: { providerID: "openrouter" }, kind: "primary" }
      await handler(evt1)

      // Poll until the background refresh has written a ranking, then route once more.
      let keepLine: string | undefined
      for (let attempt = 0; attempt < 40 && !keepLine; attempt++) {
        await sleep(25)
        const evt = { request: openRouterRequest(), model: { providerID: "openrouter" }, kind: "primary" }
        await handler(evt)
        keepLine = logs.find((line) => line.includes("keeping 3 = ["))
      }

      expect(keepLine).toContain("(cheapest)")
      expect(keepLine).toContain("alpha ($")
      expect(keepLine).toContain("beta ($")
      expect(keepLine).toContain("gamma ($")
      expect(keepLine).not.toContain("epsilon")
      expect(logs.some((line) => line.includes("blocking 1"))).toBe(true)

      await cleanup?.()
    } finally {
      spy.mockRestore()
      globalThis.fetch = savedFetch
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv
    }
  }, 10_000)
})

describe("hot path", () => {
  test("a hook error is contained: requests pass through after the DB is closed", async () => {
    const { ctx, hooks } = makeCtx({})
    const plugin = definePlugin({
      dbPath: ":memory:",
      statsRun: async () => JSON.stringify({ models: [] }),
    } as never)
    const cleanup = await plugin.setup!(ctx as never)
    await cleanup?.()

    const warnings: string[] = []
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "))
    })
    try {
      const handler = hooks.get("http.request")!.handler
      const evt = { request: openRouterRequest(), model: { providerID: "openrouter", modelID: "vendor/model" }, kind: "primary" }
      // stateFor hits the closed DB, the hook guard catches it and the request passes through.
      await handler(evt)
      expect(JSON.parse(await (evt as { request: Request }).request.text()).model).toBe("vendor/model")
      expect(warnings.some((line) => line.includes("routing skipped"))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test("uses the event model ref and leaves the body untouched when no blacklist exists", async () => {
    const savedFetch = globalThis.fetch
    const realFetch = savedFetch.bind(globalThis)
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === ENDPOINTS_URL) return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }))
      return realFetch(input as never, init)
    }) as typeof fetch

    try {
      const { ctx, hooks } = makeCtx({})
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never)
      const cleanup = await plugin.setup!(ctx as never)
      const handler = hooks.get("http.request")!.handler

      const req = openRouterRequest()
      const originalClone = req.clone
      let clones = 0
      Object.defineProperty(req, "clone", {
        value: () => {
          clones++
          return originalClone.call(req)
        },
      })

      const evt = { request: req, model: { providerID: "openrouter", modelID: "vendor/model" }, kind: "primary" }
      await handler(evt)

      // No ranking yet: the body must not be read, cloned or rebuilt.
      expect(clones).toBe(0)
      expect(JSON.parse(await (evt as { request: Request }).request.text()).model).toBe("vendor/model")

      await sleep(20)
      await cleanup?.()
    } finally {
      globalThis.fetch = savedFetch
    }
  })

  test("does not retry a failed refresh on the next request (backoff)", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    const savedFetch = globalThis.fetch
    const realFetch = savedFetch.bind(globalThis)
    let endpointCalls = 0
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/endpoints")) {
        endpointCalls++
        return Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 }))
      }
      return realFetch(input as never, init)
    }) as typeof fetch

    const warnings: string[] = []
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "))
    })

    try {
      const { ctx, hooks } = makeCtx({})
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never)
      const cleanup = await plugin.setup!(ctx as never)
      const handler = hooks.get("http.request")!.handler

      const evt1 = { request: openRouterRequest("vendor/backoff"), model: { providerID: "openrouter" }, kind: "primary" }
      await handler(evt1)
      for (let attempt = 0; attempt < 40 && !warnings.some((line) => line.includes("refresh failed")); attempt++) {
        await sleep(25)
      }
      expect(endpointCalls).toBe(1)

      const evt2 = { request: openRouterRequest("vendor/backoff"), model: { providerID: "openrouter" }, kind: "primary" }
      await handler(evt2)
      await sleep(50)
      expect(endpointCalls).toBe(1)

      await cleanup?.()
    } finally {
      spy.mockRestore()
      globalThis.fetch = savedFetch
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv
    }
  }, 10_000)
})

