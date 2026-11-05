import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OptimizerDb } from "../src/db.js";
import { definePlugin } from "../src/plugin.js";

/** Windows keeps SQLite WAL handles briefly after close; removal is best-effort. */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // The temp dir is disposable; a lingering lock must not fail the test.
  }
}

const ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/vendor/model/endpoints";

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
 * Wrap a fetch mock so the plugin's optional Tool Call Error Rate probe (frontend stats
 * routes) never reaches the real network. Empty rows leave the ranking unchanged.
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

describe("http.request hook", () => {
  test("first request waits for the ranking and already carries the blacklist", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL && (init?.signal as AbortSignal | undefined)?.aborted !== true) {
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        // Never spawn the real opencode CLI in tests: empty stats, merge falls back.
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);

      const handler = hooks.get("http.request")!.handler;

      // Request 1: never-fetched model. It must wait for the ranking instead of going out
      // unrouted, so the session does not switch providers after the first prompt and pay
      // the cache-write charge twice.
      const evt1 = {
        request: openRouterRequest(),
        model: { providerID: "openrouter" },
        kind: "primary",
      };
      await handler(evt1);
      const parsed1 = JSON.parse(await (evt1 as { request: Request }).request.text()) as {
        provider?: { ignore?: string[]; sort?: string };
      };
      expect(parsed1.provider?.ignore).toEqual(["epsilon"]);
      expect(parsed1.provider?.sort).toBe("price");

      // The ranking is cached now: the next request routes without waiting on a refresh.
      const evt2 = {
        request: openRouterRequest(),
        model: { providerID: "openrouter", modelID: "vendor/model" },
        kind: "primary",
      };
      await handler(evt2);
      const parsed2 = JSON.parse(await (evt2 as { request: Request }).request.text()) as {
        provider?: { ignore?: string[]; sort?: string };
      };
      expect(parsed2.provider?.ignore).toEqual(["epsilon"]);
      expect(parsed2.provider?.sort).toBe("price");

      // Non-OpenRouter providers are untouched.
      const evt3 = {
        request: new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-anything", messages: [] }),
        }),
        model: { providerID: "anthropic" },
        kind: "primary",
      };
      await handler(evt3);
      expect(
        JSON.parse(await (evt3 as { request: Request }).request.text()).provider,
      ).toBeUndefined();

      await cleanup?.();
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("injects sort: price when every provider survives (empty blacklist)", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      // topN 4 with 4 healthy providers: all survive, blacklist is empty, but the
      // request must still carry provider.sort = "price".
      const { ctx, hooks } = makeCtx({ topN: 4 });
      const plugin = definePlugin({
        dbPath: ":memory:",
        topN: 4,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      let routed: { sort?: string; ignore?: string[] } | undefined;
      for (let attempt = 0; attempt < 40 && !routed; attempt++) {
        await sleep(25);
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { sort?: string; ignore?: string[] };
        };
        if (parsed.provider?.sort) routed = parsed.provider;
      }
      expect(routed?.sort).toBe("price");
      expect(routed?.ignore).toBeUndefined();

      await cleanup?.();
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("blacklists providers with unparseable pricing instead of trusting them", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    const junkPayload = endpointsPayload();
    junkPayload.data.endpoints.push({
      name: "Z | m",
      model_id: "vendor/model",
      context_length: 128_000,
      max_completion_tokens: 32_768,
      max_prompt_tokens: null,
      pricing: { prompt: "", completion: "" },
      provider_name: "Z",
      tag: "zeta/fp8",
      supported_parameters: ["tools", "tool_choice"],
      status: 0,
      uptime_last_30m: 100,
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(junkPayload), { status: 200 }));
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      let ignore: string[] | undefined;
      for (let attempt = 0; attempt < 40 && !ignore; attempt++) {
        await sleep(25);
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { ignore?: string[] };
        };
        if (parsed.provider?.ignore && parsed.provider.ignore.length > 0)
          ignore = parsed.provider.ignore;
      }
      expect(ignore).toContain("zeta");

      await cleanup?.();
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("debug logging names the topN providers kept when routing", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      return realFetch(input as never, init);
    }) as typeof fetch;

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        debug: true,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      const evt1 = {
        request: openRouterRequest(),
        model: { providerID: "openrouter" },
        kind: "primary",
      };
      await handler(evt1);

      // Poll until the background refresh has written a ranking, then route once more.
      let keepLine: string | undefined;
      for (let attempt = 0; attempt < 40 && !keepLine; attempt++) {
        await sleep(25);
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);
        keepLine = logs.find((line) => line.includes("keeping 3 = ["));
      }

      expect(keepLine).toContain("(cheapest)");
      expect(keepLine).toContain("alpha ($");
      expect(keepLine).toContain("beta ($");
      expect(keepLine).toContain("gamma ($");
      expect(keepLine).not.toContain("epsilon");
      expect(logs.some((line) => line.includes("blocking 1"))).toBe(true);

      await cleanup?.();
    } finally {
      spy.mockRestore();
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("debugBlacklistReasons groups providers by identical reason sets", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    const groupedPayload = () => ({
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
          // Two providers sharing the same filter failure group on "uptime".
          {
            name: "U1 | m",
            model_id: "vendor/model",
            context_length: 128_000,
            max_completion_tokens: 32_768,
            max_prompt_tokens: null,
            pricing: { prompt: "0.0000001", completion: "0.0000002" },
            provider_name: "U1",
            tag: "u-one/fp8",
            supported_parameters: ["tools", "tool_choice"],
            status: 0,
            uptime_last_30m: 40,
          },
          {
            name: "U2 | m",
            model_id: "vendor/model",
            context_length: 128_000,
            max_completion_tokens: 32_768,
            max_prompt_tokens: null,
            pricing: { prompt: "0.0000001", completion: "0.0000002" },
            provider_name: "U2",
            tag: "u-two/fp8",
            supported_parameters: ["tools", "tool_choice"],
            status: 0,
            uptime_last_30m: 50,
          },
          // A provider whose reason set differs from both groups.
          {
            name: "C | m",
            model_id: "vendor/model",
            context_length: 24_000,
            max_completion_tokens: 32_768,
            max_prompt_tokens: null,
            pricing: { prompt: "0.0000001", completion: "0.0000002" },
            provider_name: "C",
            tag: "c-small/fp8",
            supported_parameters: ["tools", "tool_choice"],
            status: 0,
            uptime_last_30m: 99,
          },
        ],
      },
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(groupedPayload()), { status: 200 }));
      return realFetch(input as never, init);
    }) as typeof fetch;

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        debug: true,
        debugBlacklistReasons: true,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      const evt1 = {
        request: openRouterRequest(),
        model: { providerID: "openrouter" },
        kind: "primary",
      };
      await handler(evt1);

      // Poll until the background refresh has written a ranking with reasons.
      let reasonsHeader: string | undefined;
      for (let attempt = 0; attempt < 40 && !reasonsHeader; attempt++) {
        await sleep(25);
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);
        reasonsHeader = logs.find((line) => line.includes("providers blocked for vendor/model"));
      }

      // epsilon alone loses the price race; u-one/u-two share the uptime filter failure
      // and are grouped; c-small has its own context failure. One group per line,
      // indented under the header to show they belong to the routing request. Every
      // cause is shown with the threshold it enforces, and every provider carries only
      // the value that missed it, in the same order as the causes, ordered from the
      // closest miss to the hardest failure.
      expect(reasonsHeader).toContain("providers blocked for vendor/model");
      const groupLines = logs.filter(
        (line) =>
          line.includes(": u-two") || line.includes(": epsilon") || line.includes(": c-small"),
      );
      expect(
        groupLines.some((line) => line.includes("not-cheapest (top 3): epsilon ($0.021600)")),
      ).toBe(true);
      // u-two (50%) missed the 90% bar by less than u-one (40%): it leads the group.
      expect(
        groupLines.some((line) => line.includes("uptime (min 90%): u-two (50%), u-one (40%)")),
      ).toBe(true);
      expect(groupLines.some((line) => line.includes("context (min 64000): c-small (24000)"))).toBe(
        true,
      );
      expect(groupLines.some((line) => line.includes("unknown"))).toBe(false);

      await cleanup?.();
    } finally {
      spy.mockRestore();
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);
});

describe("hot path", () => {
  test("a hook error is contained: requests pass through after the DB is closed", async () => {
    const { ctx, hooks } = makeCtx({});
    const plugin = definePlugin({
      dbPath: ":memory:",
      statsRun: async () => JSON.stringify({ models: [] }),
    } as never);
    const cleanup = await plugin.setup!(ctx as never);
    await cleanup?.();

    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const handler = hooks.get("http.request")!.handler;
      const evt = {
        request: openRouterRequest(),
        model: { providerID: "openrouter", modelID: "vendor/model" },
        kind: "primary",
      };
      // stateFor hits the closed DB, the hook guard catches it and the request passes through.
      await handler(evt);
      expect(JSON.parse(await (evt as { request: Request }).request.text()).model).toBe(
        "vendor/model",
      );
      expect(warnings.some((line) => line.includes("routing skipped"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("uses the event model ref and leaves the body untouched when no blacklist exists", async () => {
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        topN: 4,
        injectSort: false,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      // First request: no ranking yet. It waits for the refresh and reads the body to
      // learn which model to rank. With all four providers surviving and sort injection
      // off, there is nothing to inject, so the request goes out unmodified.
      const evt1 = {
        request: openRouterRequest(),
        model: { providerID: "openrouter", modelID: "vendor/model" },
        kind: "primary",
      };
      await handler(evt1);
      expect(
        JSON.parse(await (evt1 as { request: Request }).request.text()).provider,
      ).toBeUndefined();

      // Ranking is cached now. The event ref fast path must not clone, parse or rebuild.
      const req = openRouterRequest();
      const originalClone = req.clone;
      let clones = 0;
      Object.defineProperty(req, "clone", {
        value: () => {
          clones++;
          return originalClone.call(req);
        },
      });

      const evt2 = {
        request: req,
        model: { providerID: "openrouter", modelID: "vendor/model" },
        kind: "primary",
      };
      await handler(evt2);

      expect(clones).toBe(0);
      expect(JSON.parse(await (evt2 as { request: Request }).request.text()).model).toBe(
        "vendor/model",
      );

      await cleanup?.();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("a slow first refresh times out and the request passes through unmodified", async () => {
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    let refreshFinished = false;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL) {
        // Deliberately slower than rankingWaitMs: the request must not wait for it.
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            refreshFinished = true;
            resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
          }, 200);
        });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        rankingWaitMs: 20,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      const evt = {
        request: openRouterRequest(),
        model: { providerID: "openrouter" },
        kind: "primary",
      };
      await handler(evt);
      // The wait is bounded: the request is released while the refresh is still running.
      expect(refreshFinished).toBe(false);
      expect(
        JSON.parse(await (evt as { request: Request }).request.text()).provider,
      ).toBeUndefined();

      await cleanup?.();
    } finally {
      globalThis.fetch = savedFetch;
    }
  }, 10_000);

  test("does not retry a failed refresh on the next request (backoff)", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    let endpointCalls = 0;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/endpoints")) {
        endpointCalls++;
        return Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      const evt1 = {
        request: openRouterRequest("vendor/backoff"),
        model: { providerID: "openrouter" },
        kind: "primary",
      };
      await handler(evt1);
      for (
        let attempt = 0;
        attempt < 40 && !warnings.some((line) => line.includes("refresh failed"));
        attempt++
      ) {
        await sleep(25);
      }
      expect(endpointCalls).toBe(1);

      const evt2 = {
        request: openRouterRequest("vendor/backoff"),
        model: { providerID: "openrouter" },
        kind: "primary",
      };
      await handler(evt2);
      await sleep(50);
      expect(endpointCalls).toBe(1);

      await cleanup?.();
    } finally {
      spy.mockRestore();
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("a corrupt stored ranking is re-ranked on the next request instead of passing through unrouted", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    const dir = mkdtempSync(join(tmpdir(), "optimizer-plugin-"));
    const dbPath = join(dir, "state.db");
    let endpointCalls = 0;

    try {
      // Seed a valid ranking, then corrupt it out-of-band, the way disk
      // corruption or an interrupted write would.
      const seed = new OptimizerDb(dbPath);
      seed.saveRefresh(
        "vendor/model",
        { survivors: [], blacklist: [], computedAt: Date.now() },
        Date.now(),
      );
      seed.close();
      const raw = new Database(dbPath);
      raw.run("UPDATE fetches SET survivors_json = '{not json' WHERE model = 'vendor/model'");
      raw.close();

      const warnings: string[] = [];
      const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
      });

      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === ENDPOINTS_URL) {
          endpointCalls++;
          return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
        }
        return realFetch(input as never, init);
      }) as typeof fetch;

      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);

      try {
        // Warm-up already saw the damage and said so.
        expect(warnings.some((line) => line.includes("stored ranking is unreadable"))).toBe(true);

        const handler = hooks.get("http.request")!.handler;
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);

        // The corrupt row reads as "never ranked", so the request waited for a
        // forced re-rank instead of passing through unrouted for the whole TTL.
        expect(endpointCalls).toBe(1);
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { ignore?: string[]; sort?: string };
        };
        expect(parsed.provider?.ignore).toEqual(["epsilon"]);
      } finally {
        spy.mockRestore();
        await cleanup?.();
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
      removeDir(dir);
    }
  }, 10_000);

  test("an unreadable stored ranking is discarded once, not reported on every start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optimizer-plugin-"));
    const dbPath = join(dir, "state.db");

    try {
      // A row that claims a fresh fetch but carries no ranking: the shape an
      // interrupted write leaves behind.
      const seed = new OptimizerDb(dbPath);
      seed.saveRefresh(
        "vendor/model",
        { survivors: ["alpha"], blacklist: [], computedAt: Date.now() },
        Date.now(),
      );
      seed.close();
      const raw = new Database(dbPath);
      raw.run(
        "UPDATE fetches SET survivors_json = NULL, blacklist_json = NULL WHERE model = 'vendor/model'",
      );
      raw.close();

      const warnings: string[] = [];
      const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
      });

      try {
        const { ctx } = makeCtx({});
        const plugin = definePlugin({
          dbPath,
          statsRun: async () => JSON.stringify({ models: [] }),
        } as never);
        const cleanup = await plugin.setup!(ctx as never);
        await cleanup?.();

        expect(warnings.some((line) => line.includes("stored ranking is unreadable"))).toBe(true);

        // The damaged row was reset, so it no longer claims to be freshly ranked.
        const check = new OptimizerDb(dbPath);
        const row = check.getFetch("vendor/model");
        expect(row?.last_fetched).toBeNull();
        expect(row?.survivors_json).toBeNull();
        check.close();

        // Second start: the row is clean now, so nothing is reported again.
        warnings.length = 0;
        const { ctx: secondCtx } = makeCtx({});
        const second = definePlugin({
          dbPath,
          statsRun: async () => JSON.stringify({ models: [] }),
        } as never);
        const secondCleanup = await second.setup!(secondCtx as never);
        await secondCleanup?.();

        expect(warnings.some((line) => line.includes("stored ranking is unreadable"))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    } finally {
      removeDir(dir);
    }
  }, 10_000);

  test("a non-JSON body passes through untouched and warns once", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    let endpointCalls = 0;
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL) {
        endpointCalls++;
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      try {
        const handler = hooks.get("http.request")!.handler;
        const evt = {
          request: new Request("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "not json at all",
          }),
          model: { providerID: "openrouter", modelID: "vendor/model" },
          kind: "primary",
        };
        await handler(evt);
        // Untouched: the original body goes out byte-for-byte.
        expect(await (evt as { request: Request }).request.text()).toBe("not json at all");
        // The refresh starts before parsing, so a non-JSON body still builds a ranking.
        for (let i = 0; i < 40 && endpointCalls === 0; i++) await sleep(25);
        expect(endpointCalls).toBeGreaterThan(0);
        // The skip is loud, not debug-only.
        expect(warnings.some((line) => line.includes("request body is not JSON"))).toBe(true);
      } finally {
        try {
          await cleanup?.();
        } finally {
          spy.mockRestore();
        }
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("a missing permaslug skips the tool call error rate probe and still routes", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const urls: string[] = [];
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    // Endpoint names without the "Provider | permaslug" tail: no permaslug can
    // be recovered, so the frontend stats probe must never be attempted.
    const noPermaslugPayload = {
      data: {
        id: "vendor/model",
        name: "Vendor Model",
        endpoints: [
          {
            name: "A",
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
            name: "B",
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
        ],
      },
    };
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(noPermaslugPayload), { status: 200 }));
      // Any stats attempt would land here and fail the assertions below.
      if (url.includes("/api/frontend/")) {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      return savedFetch.bind(globalThis)(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      try {
        const handler = hooks.get("http.request")!.handler;
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);
        // The filter cannot run without a permaslug; that skip is warned, not silent.
        expect(urls.some((u) => u.includes("/api/frontend/"))).toBe(false);
        expect(warnings.some((line) => line.includes("tool call error rate skipped"))).toBe(true);
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { ignore?: string[]; sort?: string };
        };
        expect(parsed.provider?.sort).toBe("price");
      } finally {
        try {
          await cleanup?.();
        } finally {
          spy.mockRestore();
        }
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("a failed tool call error rate probe warns once and still routes", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      if (url.includes("/api/frontend/v1/stats/")) {
        return Promise.resolve(new Response("stats unavailable", { status: 503 }));
      }
      return savedFetch.bind(globalThis)(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      try {
        const handler = hooks.get("http.request")!.handler;
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);
        expect(warnings.some((line) => line.includes("tool call error rate unavailable"))).toBe(
          true,
        );
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { ignore?: string[]; sort?: string };
        };
        expect(parsed.provider?.ignore).toEqual(["epsilon"]);
      } finally {
        try {
          await cleanup?.();
        } finally {
          spy.mockRestore();
        }
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("a one-provider model sends the request unmodified and skips the tool error rate probe", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const urls: string[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    // Failing health (uptime 40, a context below the floor) would normally be
    // blacklisted; with one provider the optimizer never looks. The endpoint
    // carries a permaslug tail, so a probe would be attempted if it ran.
    const singleProviderPayload = {
      data: {
        id: "vendor/model",
        name: "Vendor Model",
        endpoints: [
          {
            name: "A | vendor/model",
            model_id: "vendor/model",
            context_length: 24_000,
            max_completion_tokens: 8_192,
            max_prompt_tokens: null,
            pricing: { prompt: "0.0000001", completion: "0.0000002" },
            provider_name: "A",
            tag: "alpha/fp8",
            supported_parameters: ["tools", "tool_choice"],
            status: 0,
            uptime_last_30m: 40,
          },
        ],
      },
    };
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url === ENDPOINTS_URL)
        return Promise.resolve(
          new Response(JSON.stringify(singleProviderPayload), { status: 200 }),
        );
      // Any probe attempt lands here and fails the assertions below.
      if (url.includes("/api/frontend/")) {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      return savedFetch.bind(globalThis)(input as never, init);
    }) as typeof fetch;

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        debug: true,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      try {
        const handler = hooks.get("http.request")!.handler;
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);
        // One provider, nothing to route around: no probe, no ranking work.
        expect(urls.some((u) => u.includes("/api/frontend/"))).toBe(false);
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { ignore?: string[]; sort?: string };
        };
        expect(parsed.provider).toBeUndefined();
        // The ranking is recorded: the cached route passes through the same way.
        const evt2 = {
          request: openRouterRequest(),
          model: { providerID: "openrouter", modelID: "vendor/model" },
          kind: "primary",
        };
        await handler(evt2);
        expect(
          JSON.parse(await (evt2 as { request: Request }).request.text()).provider,
        ).toBeUndefined();
        // A bypassed model prices nothing, so there is no guesswork warning.
        expect(warnings.some((line) => line.includes("no usage data available"))).toBe(false);
        // ... and the debug log says why the request went out unmodified.
        expect(
          logs.some((line) => line.includes("(bypassed)") && line.includes("goes out unmodified")),
        ).toBe(true);
      } finally {
        try {
          await cleanup?.();
        } finally {
          spy.mockRestore();
          logSpy.mockRestore();
        }
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("a missing management key and empty usage data are warned once", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch.bind(globalThis));
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/models/vendor/model/endpoints")) {
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      }
      if (url.includes("/models/vendor/other/endpoints")) {
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      try {
        const handler = hooks.get("http.request")!.handler;
        // Two models, two refreshes: the key notice fires once, the
        // no-usage-data notice once per model.
        await handler({
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        });
        await handler({
          request: openRouterRequest("vendor/other"),
          model: { providerID: "openrouter" },
          kind: "primary",
        });

        expect(
          warnings.filter((line) => line.includes("OPENROUTER_MANAGEMENT_KEY is not set")).length,
        ).toBe(1);
        expect(warnings.filter((line) => line.includes("no usage data available")).length).toBe(2);
      } finally {
        spy.mockRestore();
        await cleanup?.();
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("providers rescued by the floor are warned about and still routed", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    // Every provider fails the uptime filter: alpha misses it by 10 points, beta by
    // 40. The floor keeps the one that fails least hard.
    const rescuedPayload = {
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
            uptime_last_30m: 80,
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
            uptime_last_30m: 50,
          },
        ],
      },
    };
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(rescuedPayload), { status: 200 }));
      return savedFetch.bind(globalThis)(input as never, init);
    }) as typeof fetch;

    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
        // The optional probe would only add noise to the warnings.
        maxToolCallErrorRate: 100,
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      try {
        const handler = hooks.get("http.request")!.handler;
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);

        // The user has to know that a provider which failed the filters is used.
        const notice = warnings.find((line) => line.includes("left too few providers standing"));
        expect(notice).toBeDefined();
        expect(notice).toContain("alpha (uptime)");
        // Only the provider that fails least hard stands; the other stays blocked.
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { ignore?: string[]; sort?: string };
        };
        expect(parsed.provider?.ignore).toEqual(["beta"]);
        expect(parsed.provider?.sort).toBe("price");
      } finally {
        spy.mockRestore();
        await cleanup?.();
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);

  test("an unrecognized activity envelope degrades loudly and still routes", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    process.env.OPENROUTER_MANAGEMENT_KEY = "test-key";
    const savedFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL)
        return Promise.resolve(new Response(JSON.stringify(endpointsPayload()), { status: 200 }));
      if (url.includes("/activity")) {
        return Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
      }
      return savedFetch.bind(globalThis)(input as never, init);
    }) as typeof fetch;

    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      const { ctx, hooks } = makeCtx({});
      const plugin = definePlugin({
        dbPath: ":memory:",
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      try {
        const handler = hooks.get("http.request")!.handler;
        const evt = {
          request: openRouterRequest(),
          model: { providerID: "openrouter" },
          kind: "primary",
        };
        await handler(evt);

        // The drift surfaces through the existing activity-failure warning.
        expect(warnings.some((line) => line.includes("activity fetch failed"))).toBe(true);
        // And the request is still routed from the remaining sources.
        const parsed = JSON.parse(await (evt as { request: Request }).request.text()) as {
          provider?: { ignore?: string[]; sort?: string };
        };
        expect(parsed.provider?.ignore).toEqual(["epsilon"]);
      } finally {
        spy.mockRestore();
        await cleanup?.();
      }
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
    }
  }, 10_000);
});
