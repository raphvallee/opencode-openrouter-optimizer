import { describe, expect, test } from "bun:test";
import { definePlugin } from "../src/plugin";

/**
 * Concurrency tests: the OpenCode server routes every client's requests through
 * this single plugin process, so the http.request hook can be invoked many times
 * in the same tick. These tests fire four handlers simultaneously and assert the
 * plugin neither crashes nor duplicates work, instead of starting a real server:
 * the handler here is byte-for-byte what the server calls.
 */

const ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/vendor/model/endpoints";
const ENDPOINTS_OTHER_URL = "https://openrouter.ai/api/v1/models/vendor/other/endpoints";

function endpointsPayload() {
  return {
    data: {
      id: "vendor/model",
      name: "Vendor Model",
      endpoints: [
        {
          name: "A | m",
          model_id: "vendor/model",
          context_length: 128_000,
          max_completion_tokens: 32_768,
          max_prompt_tokens: null,
          pricing: { prompt: "0.0000001", completion: "0.0000002" },
          provider_name: "A",
          tag: "alpha/fp8",
          supported_parameters: ["tools", "tool_choice"],
          status: 0,
          uptime_last_30m: 99,
        },
        {
          name: "B | m",
          model_id: "vendor/model",
          context_length: 128_000,
          max_completion_tokens: 32_768,
          max_prompt_tokens: null,
          pricing: { prompt: "0.0000002", completion: "0.0000003" },
          provider_name: "B",
          tag: "beta/fp8",
          supported_parameters: ["tools", "tool_choice"],
          status: 0,
          uptime_last_30m: 99,
        },
        {
          name: "G | m",
          model_id: "vendor/model",
          context_length: 128_000,
          max_completion_tokens: 32_768,
          max_prompt_tokens: null,
          pricing: { prompt: "0.0000003", completion: "0.0000004" },
          provider_name: "G",
          tag: "gamma/fp8",
          supported_parameters: ["tools", "tool_choice"],
          status: 0,
          uptime_last_30m: 99,
        },
        {
          name: "E | m",
          model_id: "vendor/model",
          context_length: 128_000,
          max_completion_tokens: 32_768,
          max_prompt_tokens: null,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          provider_name: "E",
          tag: "epsilon/fp8",
          supported_parameters: ["tools", "tool_choice"],
          status: 0,
          uptime_last_30m: 99,
        },
      ],
    },
  };
}

function openRouterRequest(model = "vendor/model"): Request {
  return new Request("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "42" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

function makeCtx(options = {}) {
  const hooks = new Map<string, { handler: (event: unknown) => Promise<void>; opts: unknown }>();
  const ctx = {
    options,
    event: {
      // Empty async iterable: no session events in this test.
      subscribe: async function* () {},
    },
    session: {
      hook: async (name: string, handler: (event: unknown) => Promise<void>, opts?: unknown) => {
        hooks.set(name, { handler, opts });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, hooks };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a fetch mock so the optional Tool Call Error Rate probe never reaches the
 * real network. Empty rows leave the ranking unchanged.
 */
function withStatsFallback(fetchImpl: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/frontend/v1/stats/")) {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }
    return fetchImpl(input as never, init);
  }) as typeof fetch;
}

interface RoutingBody {
  provider?: { ignore?: string[]; sort?: string };
}

async function parseRouting(evt: { request: Request }): Promise<RoutingBody> {
  return JSON.parse(await evt.request.text()) as RoutingBody;
}

describe("concurrent http.request hook", () => {
  test("4 simultaneous first-sight requests share one refresh and all route identically", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));

    // Count the endpoints fetches: with no single-flight, four racing requests
    // would start four parallel refreshes for the same model.
    let endpointsFetches = 0;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL && (init?.signal as AbortSignal | undefined)?.aborted !== true) {
        endpointsFetches++;
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    // A crash under concurrency would surface as an unhandled rejection (the
    // hook wrapper catches handler errors, so this is the only way to see one).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        // Never spawn the real opencode CLI in tests: empty stats, merge falls back.
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);

      const handler = hooks.get("http.request")!.handler;

      // Four events with no modelID, fired in the same tick: the same shape the
      // server produces when four clients hit the same never-seen model at once.
      // Every one of them must wait for the same single ranking, not start its own.
      const events = [0, 1, 2, 3].map(() => ({
        request: openRouterRequest(),
        model: { providerID: "openrouter" },
        kind: "primary",
      }));
      await Promise.all(events.map((evt) => handler(evt)));

      expect(unhandled).toEqual([]);

      // Single-flight: one refresh total, not four. The inflight map must make
      // the later arrivals join the first task instead of racing it.
      expect(endpointsFetches).toBe(1);

      // All four requests came out routed identically from the shared ranking.
      for (const evt of events) {
        const parsed = await parseRouting(evt);
        expect(parsed.provider?.ignore).toEqual(["epsilon"]);
        expect(parsed.provider?.sort).toBe("price");
      }

      await cleanup?.();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("4 simultaneous requests across two models single-flight per model", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));

    const endpointsFetches = new Map<string, number>();
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL || url === ENDPOINTS_OTHER_URL) {
        if ((init?.signal as AbortSignal | undefined)?.aborted !== true) {
          endpointsFetches.set(url, (endpointsFetches.get(url) ?? 0) + 1);
          return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
        }
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);

      const handler = hooks.get("http.request")!.handler;

      // Two sessions on model A, two on model B, all in the same tick: one
      // refresh per model, and each request routed by its own model's ranking.
      const events = [0, 1, 2, 3].map((index) => ({
        request: openRouterRequest(index % 2 === 0 ? "vendor/model" : "vendor/other"),
        model: { providerID: "openrouter" },
        kind: "primary",
      }));
      await Promise.all(events.map((evt) => handler(evt)));

      expect(unhandled).toEqual([]);
      expect(endpointsFetches.get(ENDPOINTS_URL)).toBe(1);
      expect(endpointsFetches.get(ENDPOINTS_OTHER_URL)).toBe(1);

      for (const evt of events) {
        const parsed = await parseRouting(evt);
        expect(parsed.provider?.ignore).toEqual(["epsilon"]);
        expect(parsed.provider?.sort).toBe("price");
      }

      await cleanup?.();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("cleanup during 4 parked requests aborts the refresh and releases every request", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));

    // An endpoints fetch that only settles when aborted: the refresh stays
    // genuinely in flight until cleanup's controller.abort() reaches it, which
    // is the exact state a plugin reload or server shutdown creates.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);

      const handler = hooks.get("http.request")!.handler;

      // Four events land and all four park waiting for the same never-arriving
      // ranking. This mirrors the race where a reload/shutdown happens while
      // requests are still waiting on their first ranking.
      const events = [0, 1, 2, 3].map(() => ({
        request: openRouterRequest(),
        model: { providerID: "openrouter" },
        kind: "primary",
      }));
      const settled = events.map((evt) =>
        handler(evt).then(
          () => true,
          () => false,
        ),
      );
      await sleep(20);

      // Cleanup must not hang on the parked refreshes: abort releases the
      // refresh task, and the parked handlers fail open on their own.
      await cleanup?.();
      const outcomes = await Promise.all(settled);
      expect(outcomes).toEqual([true, true, true, true]);
      expect(unhandled).toEqual([]);

      // The abort is not a refresh failure: no request was mutated, so each one
      // went out exactly as it arrived.
      for (const evt of events) {
        const parsed = await parseRouting(evt);
        expect(parsed.provider).toBeUndefined();
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);
});
