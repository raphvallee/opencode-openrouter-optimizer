import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOptions } from "../src/config.js";
import { OptimizerDb } from "../src/db.js";
import { readBoundedJson, readBoundedText } from "../src/http.js";
import { isOpenRouterModelRef } from "../src/openrouter.js";
import { definePlugin } from "../src/plugin.js";
import { providerSlug } from "../src/ranking.js";

const ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/vendor/model/endpoints";
const STALE_MS = 10 * 3_600_000;

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // disposable temp dir
  }
}

function openRouterRequest(model = "vendor/model"): Request {
  return new Request("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

function makeCtx(options = {}) {
  const hooks = new Map<string, { handler: (event: unknown) => Promise<void> }>();
  const ctx = {
    options,
    event: { subscribe: async function* () {} },
    session: {
      hook: async (name: string, handler: (event: unknown) => Promise<void>) => {
        hooks.set(name, { handler });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, hooks };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** All endpoints fail the uptime filter, so the refresh produces zero survivors. */
function starvedPayload() {
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
          pricing: { prompt: "0.0000001", completion: "0.0000002" },
          provider_name: "A",
          tag: "alpha/fp8",
          supported_parameters: ["tools", "tool_choice"],
          status: 0,
          uptime_last_30m: 0,
        },
      ],
    },
  };
}

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

describe("routing safety invariants", () => {
  let savedEnv: string | undefined;
  let savedFetch: typeof globalThis.fetch;
  let dirs: string[];

  const cleanupFetchAndEnv = () => {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
    else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
  };

  afterEach(() => {
    cleanupFetchAndEnv();
    for (const dir of dirs ?? []) removeDir(dir);
    dirs = [];
  });

  const useDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "optimizer-security-"));
    dirs.push(dir);
    return dir;
  };

  test("zero survivors still enforce the user's extraIgnore, never sort", async () => {
    savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    savedFetch = globalThis.fetch;
    const realFetch = withStatsFallback(savedFetch);
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL) {
        return Promise.resolve(new Response(JSON.stringify(starvedPayload()), { status: 200 }));
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    const { ctx, hooks } = makeCtx();
    const plugin = definePlugin({
      dbPath: ":memory:",
      keepAtLeastN: 0,
      extraIgnore: ["chutes"],
      statsRun: async () => JSON.stringify({ models: [] }),
    } as never);
    const cleanup = await plugin.setup!(ctx as never);
    const handler = hooks.get("http.request")!.handler;

    const evt = {
      request: openRouterRequest(),
      model: { providerID: "openrouter", modelID: "vendor/model" },
    };
    await handler(evt);
    const body = JSON.parse(await (evt as { request: Request }).request.text()) as {
      provider?: { ignore?: string[]; sort?: string };
    };
    expect(body.provider?.ignore).toEqual(["chutes"]);
    expect(body.provider?.sort).toBeUndefined();
    await cleanup?.();
  }, 10_000);

  test("without a sessionID, a routing failure is still loud in the logs", async () => {
    savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    savedFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { ctx, hooks } = makeCtx();
      const plugin = definePlugin({
        dbPath: ":memory:",
        rankingWaitMs: 200,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      const evt = {
        request: openRouterRequest(),
        model: { providerID: "openrouter", modelID: "vendor/model" },
        // no sessionID: nothing may be written to a transcript or toast
      };
      await handler(evt);
      const logged = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("could not route");
      await cleanup?.();
    } finally {
      warnSpy.mockRestore();
    }
  }, 10_000);

  test("a wholesale collapse of survivors is not persisted over a healthy snapshot", async () => {
    const dir = useDir();
    const dbPath = join(dir, "optimizer.db");
    const stale = Date.now() - STALE_MS;

    savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    savedFetch = globalThis.fetch;

    const seed = new OptimizerDb(dbPath);
    seed.saveRefresh(
      "vendor/model",
      { survivors: ["alpha"], blacklist: [], computedAt: stale, mode: "cheapest" },
      stale,
    );
    seed.close();

    const realFetch = withStatsFallback(savedFetch);
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === ENDPOINTS_URL) {
        return Promise.resolve(new Response(JSON.stringify(starvedPayload()), { status: 200 }));
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    const { ctx, hooks } = makeCtx();
    const plugin = definePlugin({
      dbPath,
      keepAtLeastN: 0,
      statsRun: async () => JSON.stringify({ models: [] }),
    } as never);
    const cleanup = await plugin.setup!(ctx as never);
    const handler = hooks.get("http.request")!.handler;

    const evt = {
      request: openRouterRequest(),
      model: { providerID: "openrouter", modelID: "vendor/model" },
    };
    await handler(evt);
    // The refresh happens in the background; give it a moment to finish.
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(25);
      const check = new OptimizerDb(dbPath);
      const row = check.getFetch("vendor/model");
      const persisted = row?.last_fetched ?? 0;
      check.close();
      if (persisted > stale) break;
    }
    const check = new OptimizerDb(dbPath);
    const row = check.getFetch("vendor/model")!;
    expect(JSON.parse(row.survivors_json!)).toEqual(["alpha"]);
    expect(row.last_fetched!).toBeGreaterThan(stale);
    check.close();
    await cleanup?.();
  }, 15_000);
});

describe("database safety", () => {
  const useDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "optimizer-db-"));
    return dir;
  };

  test("a foreign sqlite file is refused and left byte-identical", () => {
    const dir = useDir();
    try {
      const path = join(dir, "foreign.db");
      const foreign = new Database(path, { create: true });
      foreign.exec("CREATE TABLE app (id INTEGER)");
      foreign.exec("INSERT INTO app VALUES (1), (2)");
      foreign.close();
      expect(() => new OptimizerDb(path)).toThrow(/FOREIGNDB|not an optimizer database/i);
      const check = new Database(path);
      expect(check.query("SELECT count(*) AS n FROM app").get()).toEqual({ n: 2 });
      const tables = check.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables).toEqual([{ name: "app" }]);
      check.close();
    } finally {
      removeDir(dir);
    }
  });

  test("a garbage file is quarantined and replaced by a fresh optimizer db", () => {
    const dir = useDir();
    try {
      const path = join(dir, "broken.db");
      writeFileSync(path, "this is not a sqlite file at all, just garbage bytes");
      const db = new OptimizerDb(path);
      expect(() => db.getFetch("vendor/model")).not.toThrow();
      db.close();
      const movedAside = readdirSync(dir).filter((name) => /\.corrupt-\d+$/.test(name));
      expect(movedAside.length).toBeGreaterThan(0);
      const check = new Database(path);
      const tables = check
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.some((table) => table.name === "fetches")).toBe(true);
      check.close();
    } finally {
      removeDir(dir);
    }
  });

  test("an owned legacy db with a usage table is recognized and migrated", () => {
    const dir = useDir();
    try {
      const path = join(dir, "legacy.db");
      const legacy = new Database(path, { create: true });
      legacy.exec(
        "CREATE TABLE fetches (model TEXT PRIMARY KEY, last_fetched INTEGER, rankings_json TEXT, updated_at INTEGER)",
      );
      legacy.exec("CREATE TABLE usage (tally TEXT)");
      legacy.exec(
        "INSERT INTO fetches (model, last_fetched, rankings_json, updated_at) VALUES ('vendor/model', 1, '{}', 2)",
      );
      legacy.close();
      const db = new OptimizerDb(path);
      expect(db.getFetch("vendor/model")?.model).toBe("vendor/model");
      db.close();
      const check = new Database(path);
      const tables = check
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.some((table) => table.name === "usage")).toBe(false);
      expect(tables.some((table) => table.name === "fetches")).toBe(true);
      check.close();
    } finally {
      removeDir(dir);
    }
  });

  test("future disk timestamps are clamped instead of pinning a stale snapshot fresh", () => {
    const dir = useDir();
    try {
      const path = join(dir, "clamp.db");
      const db = new OptimizerDb(path);
      const stale = Date.now() - STALE_MS;
      db.saveRefresh(
        "vendor/model",
        { survivors: ["a"], blacklist: ["b"], computedAt: stale, mode: "cheapest" },
        stale,
      );
      db.close();
      const raw = new Database(path);
      raw.run(
        "UPDATE fetches SET last_fetched = 99999999999999, retry_after = 99999999999999, computed_at = 99999999999999 WHERE model = 'vendor/model'",
      );
      raw.close();
      const reopened = new OptimizerDb(path);
      const state = reopened.loadRoutingStates(false).find((row) => row.model === "vendor/model")!;
      expect(state.lastFetched!).toBeLessThanOrEqual(Date.now());
      expect(state.retryAfter!).toBeLessThanOrEqual(Date.now());
      expect(state.routing?.computedAt).toBeLessThanOrEqual(Date.now());
      reopened.close();
    } finally {
      removeDir(dir);
    }
  });

  test("nonconforming survivors make the whole snapshot unreadable; empty stays valid", () => {
    const dir = useDir();
    try {
      const path = join(dir, "strict.db");
      const seed = new OptimizerDb(path);
      seed.saveRefresh(
        "vendor/model",
        { survivors: ["a"], blacklist: ["b"], computedAt: 10, mode: "cheapest" },
        20,
      );
      seed.close();
      const raw = new Database(path);
      raw.run("UPDATE fetches SET survivors_json = '[\"a\", 123]' WHERE model = 'vendor/model'");
      raw.close();
      const db = new OptimizerDb(path);
      expect(
        db.loadRoutingStates(false).find((r) => r.model === "vendor/model")?.routing,
      ).toBeUndefined();
      db.close();

      const raw2 = new Database(path);
      raw2.run("UPDATE fetches SET survivors_json = '[\"BAD SLUG\"]' WHERE model = 'vendor/model'");
      raw2.close();
      const db2 = new OptimizerDb(path);
      expect(
        db2.loadRoutingStates(false).find((r) => r.model === "vendor/model")?.routing,
      ).toBeUndefined();
      db2.close();

      const raw3 = new Database(path);
      raw3.run("UPDATE fetches SET survivors_json = '[]' WHERE model = 'vendor/model'");
      raw3.close();
      const db3 = new OptimizerDb(path);
      expect(
        db3.loadRoutingStates(false).find((r) => r.model === "vendor/model")?.routing?.survivors,
      ).toEqual([]);
      db3.close();
    } finally {
      removeDir(dir);
    }
  });
});

describe("validation of untrusted input", () => {
  test("providerSlug canonicalizes, validates and never throws", () => {
    expect(providerSlug({ tag: "DeepInfra/FP8" } as never)).toBe("deepinfra");
    expect(providerSlug({ tag: 42 } as never)).toBe("");
    expect(providerSlug({ tag: "__proto__/turbo" } as never)).toBe("");
    expect(providerSlug({ tag: `${"a".repeat(65)}/x` } as never)).toBe("");
    expect(providerSlug({ tag: "valid-slug/x" } as never)).toBe("valid-slug");
    expect(providerSlug({ tag: "güt/fp8" } as never)).toBe("");
    expect(providerSlug({ provider_name: "X |", tag: undefined } as never)).toBe("x");
  });

  test("an unbounded model id is never persisted or routed", async () => {
    const savedEnv = process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.OPENROUTER_MANAGEMENT_KEY;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      )) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "optimizer-security-"));
    try {
      const dbPath = join(dir, "unbounded.db");
      const { ctx, hooks } = makeCtx();
      const plugin = definePlugin({
        dbPath,
        statsRun: async () => JSON.stringify({ models: [] }),
      } as never);
      const cleanup = await plugin.setup!(ctx as never);
      const handler = hooks.get("http.request")!.handler;

      const hugeModel = `a/${"x".repeat(10_000)}`;
      expect(isOpenRouterModelRef(hugeModel)).toBe(false);
      const request = new Request("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: hugeModel, messages: [] }),
      });
      const evt = { request, model: { providerID: "openrouter", modelID: hugeModel } };
      await handler(evt);
      const body = JSON.parse(await (evt as { request: Request }).request.text()) as {
        provider?: unknown;
      };
      expect(body.provider).toBeUndefined();
      const db = new OptimizerDb(dbPath);
      expect(db.state().fetches).toEqual([]);
      db.close();
      await cleanup?.();
    } finally {
      globalThis.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
      else process.env.OPENROUTER_MANAGEMENT_KEY = savedEnv;
      removeDir(dir);
    }
  }, 10_000);

  test("readBoundedText caps streamed bodies instead of buffering them fully", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
        for (let i = 0; i < 16; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    await expect(readBoundedText(stream, 512 * 1024, "test body")).rejects.toThrow(/exceeds/);
    const small = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    await expect(readBoundedText(small, 1024, "test body")).resolves.toBe("hello");
  });

  test("readBoundedJson aborts on oversized bodies instead of buffering them", async () => {
    const declared = new Response("{}", { headers: { "content-length": "999999999" } });
    await expect(readBoundedJson(declared)).rejects.toThrow(/exceeds/);

    const streamed = new Response("x".repeat(6 * 1024 * 1024));
    await expect(readBoundedJson(streamed, 5 * 1024 * 1024)).rejects.toThrow(/exceeds/);
  });

  test("config rejects shell-ish commands, secret env names and unbounded numbers", () => {
    expect(() => resolveOptions({ statsCommand: "a; rm -rf /" })).toThrow(/statsCommand/);
    expect(() => resolveOptions({ statsCommand: "./opencode" })).toThrow(/statsCommand/);
    expect(() => resolveOptions({ managementKeyEnv: "AWS_SECRET_ACCESS_KEY" })).toThrow(
      /managementKeyEnv/,
    );
    expect(() => resolveOptions({ rankingWaitMs: 999_000 })).toThrow(/rankingWaitMs/);
    expect(() => resolveOptions({ ttlHours: 9999 })).toThrow(/ttlHours/);
    expect(resolveOptions({ managementKeyEnv: "MY_MANAGEMENT_KEY" }).managementKeyEnv).toBe(
      "MY_MANAGEMENT_KEY",
    );
    expect(resolveOptions({ statsCommand: "/usr/local/bin/opencode" }).statsCommand).toBe(
      "/usr/local/bin/opencode",
    );
  });

  test("extraIgnore entries are lower-cased and slug-validated", () => {
    expect(resolveOptions({ extraIgnore: [" chutes ", "EXTRA"] }).extraIgnore).toEqual([
      "chutes",
      "extra",
    ]);
    expect(() => resolveOptions({ extraIgnore: ["bad slug!"] })).toThrow(/extraIgnore/);
  });
});
