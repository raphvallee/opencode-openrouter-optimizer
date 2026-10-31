import { describe, expect, test } from "bun:test"
import { baseModelSlug, fetchModelEndpoints, OpenRouterError } from "../src/openrouter"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("baseModelSlug", () => {
  test("strips variant suffixes", () => {
    expect(baseModelSlug("deepseek/deepseek-r1:free")).toBe("deepseek/deepseek-r1")
    expect(baseModelSlug("openai/gpt-4.1#think")).toBe("openai/gpt-4.1")
    expect(baseModelSlug("openai/gpt-4.1")).toBe("openai/gpt-4.1")
  })
})

describe("fetchModelEndpoints", () => {
  const payload = { data: { id: "vendor/model", name: "Vendor Model", endpoints: [{ model_id: "vendor/model" }] } }

  test("keeps the slash unencoded and returns the data envelope", async () => {
    const urls: string[] = []
    const response = await fetchModelEndpoints("vendor/model", {
      fetchImpl: async (url) => {
        urls.push(String(url))
        return jsonResponse(payload)
      },
    })
    expect(urls[0]).toBe("https://openrouter.ai/api/v1/models/vendor/model/endpoints")
    expect(response.endpoints.length).toBe(1)
  })

  test("retries without the variant suffix on 404", async () => {
    const urls: string[] = []
    const response = await fetchModelEndpoints("vendor/model:free", {
      fetchImpl: async (url) => {
        urls.push(String(url))
        return urls.length === 1 ? jsonResponse({ error: "not found" }, 404) : jsonResponse(payload)
      },
    })
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/models/vendor/model:free/endpoints",
      "https://openrouter.ai/api/v1/models/vendor/model/endpoints",
    ])
    expect(response.id).toBe("vendor/model")
  })

  test("throws after both attempts fail", async () => {
    const failure = fetchModelEndpoints("vendor/nonexistent", {
      fetchImpl: async () => jsonResponse({ error: "not found" }, 404),
    })
    expect(failure).rejects.toBeInstanceOf(OpenRouterError)
  })

  test("throws on unexpected payload shapes", async () => {
    const failure = fetchModelEndpoints("vendor/model", {
      fetchImpl: async () => jsonResponse({ data: {} }, 200),
    })
    expect(failure).rejects.toBeInstanceOf(OpenRouterError)
  })

  test("aborts a hung fetch once the overall timeout expires", async () => {
    const failure = fetchModelEndpoints("vendor/model", {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) return reject(new Error("missing signal"))
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    })
    await expect(failure).rejects.toBeDefined()
  })
})
