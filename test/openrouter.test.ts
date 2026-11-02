import { describe, expect, test } from "bun:test";
import {
  baseModelSlug,
  fetchModelEndpoints,
  fetchOpenRouterProfile,
  fetchToolCallErrorRate,
  OpenRouterError,
} from "../src/openrouter";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("baseModelSlug", () => {
  test("strips variant suffixes", () => {
    expect(baseModelSlug("deepseek/deepseek-r1:free")).toBe("deepseek/deepseek-r1");
    expect(baseModelSlug("openai/gpt-4.1#think")).toBe("openai/gpt-4.1");
    expect(baseModelSlug("openai/gpt-4.1")).toBe("openai/gpt-4.1");
  });
});

describe("fetchModelEndpoints", () => {
  const payload = {
    data: { id: "vendor/model", name: "Vendor Model", endpoints: [{ model_id: "vendor/model" }] },
  };

  test("keeps the slash unencoded and returns the data envelope", async () => {
    const urls: string[] = [];
    const response = await fetchModelEndpoints("vendor/model", {
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse(payload);
      },
    });
    expect(urls[0]).toBe("https://openrouter.ai/api/v1/models/vendor/model/endpoints");
    expect(response.endpoints.length).toBe(1);
  });

  test("retries without the variant suffix on 404", async () => {
    const urls: string[] = [];
    const response = await fetchModelEndpoints("vendor/model:free", {
      fetchImpl: async (url) => {
        urls.push(String(url));
        return urls.length === 1
          ? jsonResponse({ error: "not found" }, 404)
          : jsonResponse(payload);
      },
    });
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/models/vendor/model:free/endpoints",
      "https://openrouter.ai/api/v1/models/vendor/model/endpoints",
    ]);
    expect(response.id).toBe("vendor/model");
  });

  test("does not retry the base slug on non-404 failures", async () => {
    const urls: string[] = [];
    const failure = fetchModelEndpoints("vendor/model:free", {
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({ error: "rate limited" }, 429);
      },
    });
    await expect(failure).rejects.toThrow("HTTP 429");
    expect(urls).toEqual(["https://openrouter.ai/api/v1/models/vendor/model:free/endpoints"]);
  });

  test("reports both statuses when the 404 retry fails differently", async () => {
    const failure = fetchModelEndpoints("vendor/model:free", {
      fetchImpl: async (url) =>
        String(url).includes(":free")
          ? jsonResponse({ error: "not found" }, 404)
          : jsonResponse({ error: "boom" }, 500),
    });
    await expect(failure).rejects.toThrow("404 -> 500");
  });

  test("throws after both attempts fail", async () => {
    const failure = fetchModelEndpoints("vendor/nonexistent", {
      fetchImpl: async () => jsonResponse({ error: "not found" }, 404),
    });
    expect(failure).rejects.toBeInstanceOf(OpenRouterError);
  });

  test("throws on unexpected payload shapes", async () => {
    const failure = fetchModelEndpoints("vendor/model", {
      fetchImpl: async () => jsonResponse({ data: {} }, 200),
    });
    expect(failure).rejects.toBeInstanceOf(OpenRouterError);
  });

  test("aborts a hung fetch once the overall timeout expires", async () => {
    const failure = fetchModelEndpoints("vendor/model", {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error("missing signal"));
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    await expect(failure).rejects.toBeDefined();
  });
});

describe("fetchOpenRouterProfile", () => {
  test("reduces activity rows for the model across variant suffixes", async () => {
    const activity = await fetchOpenRouterProfile("vendor/model", "key", {
      fetchImpl: async () =>
        jsonResponse([
          {
            date: "2026-01-01",
            model: "vendor/model:reasoning",
            requests: 2,
            prompt_tokens: 100,
            completion_tokens: 10,
            cached_tokens: 20,
          },
          {
            date: "2026-01-01",
            model: "other/model",
            requests: 9,
            prompt_tokens: 999,
            completion_tokens: 9,
          },
        ]),
    });
    expect(activity).toEqual({
      requests: 2,
      promptTokens: 100,
      completionTokens: 10,
      cachedTokens: 20,
    });
  });

  test("throws on an unrecognized activity envelope instead of silently ranking from zero rows", async () => {
    const failure = fetchOpenRouterProfile("vendor/model", "key", {
      fetchImpl: async () => jsonResponse({ unexpected: true }),
    });
    await expect(failure).rejects.toBeInstanceOf(OpenRouterError);
  });

  test("an empty data envelope is a legitimate zero-activity result", async () => {
    const activity = await fetchOpenRouterProfile("vendor/model", "key", {
      fetchImpl: async () => jsonResponse({ data: [] }),
    });
    expect(activity).toEqual({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
    });
  });

  test("throws when an activity row field is a string instead of a number", async () => {
    const failure = fetchOpenRouterProfile("vendor/model", "key", {
      fetchImpl: async () =>
        jsonResponse([
          {
            date: "2026-01-01",
            model: "vendor/model",
            requests: "2",
            prompt_tokens: 100,
            completion_tokens: 10,
          },
        ]),
    });
    await expect(failure).rejects.toThrow(/activity row 0 has invalid requests/);
  });

  test("throws when an activity row field is negative", async () => {
    const failure = fetchOpenRouterProfile("vendor/model", "key", {
      fetchImpl: async () =>
        jsonResponse([
          {
            date: "2026-01-01",
            model: "vendor/model",
            requests: 2,
            prompt_tokens: -1,
            completion_tokens: 10,
          },
        ]),
    });
    await expect(failure).rejects.toThrow(/activity row 0 has invalid prompt_tokens/);
  });
});

describe("fetchToolCallErrorRate", () => {
  function statsResponse(url: string, perf: unknown, rate: unknown): Response {
    return jsonResponse(String(url).includes("tool-call-error-rate") ? rate : perf);
  }

  test("returns volume-weighted rates per provider", async () => {
    const rates = await fetchToolCallErrorRate("vendor/model", {
      fetchImpl: async (url) =>
        statsResponse(
          String(url),
          {
            data: [
              { id: "e1", tag: "alpha/fp8", provider_name: "Alpha" },
              { id: "e2", tag: "alpha/fp8", provider_name: "Alpha" },
            ],
          },
          { data: [{ y: { e1: 2, e2: 4 }, volume: { e1: 100, e2: 300 } }] },
        ),
    });
    expect(rates.get("alpha")).toBeCloseTo(3.5);
  });

  test("throws on an unrecognized stats envelope instead of returning an empty map", async () => {
    const failure = fetchToolCallErrorRate("vendor/model", {
      fetchImpl: async (url) =>
        statsResponse(String(url), { unexpected: true }, { unexpected: true }),
    });
    await expect(failure).rejects.toBeInstanceOf(OpenRouterError);
  });

  test("throws when rows arrive but none can be weighted", async () => {
    const failure = fetchToolCallErrorRate("vendor/model", {
      fetchImpl: async (url) =>
        statsResponse(
          String(url),
          { data: [{ id: "e1", tag: "alpha/fp8" }] },
          { data: [{ y: { unknown: 2 }, volume: { unknown: 100 } }] },
        ),
    });
    await expect(failure).rejects.toThrow(/had rows but no usable rates/);
  });

  test("an empty stats envelope returns an empty rate map", async () => {
    const rates = await fetchToolCallErrorRate("vendor/model", {
      fetchImpl: async (url) => statsResponse(String(url), { data: [] }, { data: [] }),
    });
    expect(rates.size).toBe(0);
  });
});
