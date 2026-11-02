import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OptimizerDb } from "../src/db.js";

/** Windows keeps SQLite WAL handles briefly after close; removal is best-effort. */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // The temp dir is disposable; a lingering lock must not fail the test.
  }
}

describe("OptimizerDb", () => {
  test("ensureFetchRow leaves last_fetched null on first sight", () => {
    const db = new OptimizerDb(":memory:");
    try {
      const row = db.ensureFetchRow("vendor/model", 123);
      expect(row.last_fetched).toBeNull();
      expect(db.ensureFetchRow("vendor/model", 456).model).toBe("vendor/model");
    } finally {
      db.close();
    }
  });

  test("recordFetch then setRanking round-trips and recordFetch preserves prior rankings", () => {
    const db = new OptimizerDb(":memory:");
    try {
      db.ensureFetchRow("vendor/model", 100);
      db.recordFetch("vendor/model", [{ model_id: "vendor/model", name: "x" } as never], 200);
      expect(db.getFetch("vendor/model")?.last_fetched).toBe(200);
      expect(db.getRankings("vendor/model")).toBeUndefined();

      db.setRanking("vendor/model", {
        rankings: [{ slug: "a" }],
        survivors: ["a"],
        blacklist: ["b"],
        computedAt: 300,
      });
      const ranking = db.getRankings("vendor/model");
      expect(ranking?.survivors).toEqual(["a"]);
      expect(ranking?.blacklist).toEqual(["b"]);

      // A subsequent fetch (TTL refresh) keeps the old rankings until re-ranked.
      db.recordFetch("vendor/model", [{ model_id: "vendor/model", name: "y" } as never], 400);
      expect(db.getRankings("vendor/model")?.survivors).toEqual(["a"]);
      expect(db.getFetch("vendor/model")?.last_fetched).toBe(400);
    } finally {
      db.close();
    }
  });

  test("saveRefresh writes compact routing and resets failure state in one call", () => {
    const db = new OptimizerDb(":memory:");
    try {
      db.ensureFetchRow("vendor/model", 1);
      db.recordFailure("vendor/model", 2, 5_000);
      expect(db.getFetch("vendor/model")?.attempts).toBe(1);

      db.saveRefresh(
        "vendor/model",
        { survivors: ["a"], blacklist: ["b"], computedAt: 10, mode: "cheapest" },
        20,
        [{ slug: "a", perRequest: 0.1 }],
      );
      const row = db.getFetch("vendor/model")!;
      expect(row.last_fetched).toBe(20);
      expect(row.last_attempt).toBe(20);
      expect(row.attempts).toBe(0);
      expect(row.retry_after).toBeNull();

      const ranking = db.getRankings("vendor/model");
      expect(ranking?.survivors).toEqual(["a"]);
      expect(ranking?.blacklist).toEqual(["b"]);
      expect(ranking?.rankings).toEqual([{ slug: "a", perRequest: 0.1 }]);

      // The default (non-debug) refresh stores no detail payload.
      db.saveRefresh("vendor/lean", { survivors: ["a"], blacklist: [], computedAt: 30 }, 30);
      expect(db.getFetch("vendor/lean")?.details_json).toBeNull();
      expect(
        db.loadRoutingStates(false).find((state) => state.model === "vendor/lean")?.details,
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("saveRefresh stores blacklist reasons and loadRoutingStates reads them back", () => {
    const db = new OptimizerDb(":memory:");
    try {
      db.saveRefresh(
        "vendor/model",
        { survivors: ["a"], blacklist: ["b", "c"], computedAt: 10, mode: "cheapest" },
        20,
        undefined,
        { b: ["uptime", "not-cheapest"], c: ["pricing"] },
      );
      const states = db.loadRoutingStates();
      expect(states.find((state) => state.model === "vendor/model")?.blacklistReasons).toEqual({
        b: ["uptime", "not-cheapest"],
        c: ["pricing"],
      });
      expect(db.getRankings("vendor/model")?.blacklistReasons).toEqual({
        b: ["uptime", "not-cheapest"],
        c: ["pricing"],
      });
      // A lean load skips the debug payload but keeps routing intact.
      const lean = db.loadRoutingStates(false).find((state) => state.model === "vendor/model");
      expect(lean?.routing).toEqual({
        survivors: ["a"],
        blacklist: ["b", "c"],
        computedAt: 10,
        mode: "cheapest",
      });
      expect(lean?.blacklistReasons).toBeUndefined();

      // Refreshes without reasons clear the column instead of keeping stale data.
      db.saveRefresh("vendor/model", { survivors: ["a"], blacklist: [], computedAt: 30 }, 40);
      expect(db.getFetch("vendor/model")?.blacklist_reasons_json).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a corrupt blacklist_reasons_json reads as missing reasons without breaking routing", () => {
    const dir = mkdtempSync(join(tmpdir(), "optimizer-db-"));
    const path = join(dir, "corrupt-reasons.db");
    const db = new OptimizerDb(path);
    try {
      db.saveRefresh(
        "vendor/model",
        { survivors: ["a"], blacklist: ["b"], computedAt: 10, mode: "cheapest" },
        20,
        undefined,
        { b: ["uptime"] },
      );
      const raw = new Database(path);
      raw.run(
        "UPDATE fetches SET blacklist_reasons_json = '{not json' WHERE model = 'vendor/model'",
      );
      raw.close();

      const state = db.loadRoutingStates().find((row) => row.model === "vendor/model")!;
      // Reasons are debug-only payload: their corruption never affects routing.
      expect(state.routing).toEqual({
        survivors: ["a"],
        blacklist: ["b"],
        computedAt: 10,
        mode: "cheapest",
      });
      expect(state.blacklistReasons).toBeUndefined();
    } finally {
      db.close();
      removeDir(dir);
    }
  });

  test("a corrupt survivors_json reads as never ranked, a valid empty one as zero survivors", () => {
    const dir = mkdtempSync(join(tmpdir(), "optimizer-db-"));
    const path = join(dir, "corrupt.db");
    const db = new OptimizerDb(path);
    try {
      db.saveRefresh("vendor/model", { survivors: ["a"], blacklist: ["b"], computedAt: 10 }, 20);
      db.saveRefresh("vendor/empty", { survivors: [], blacklist: [], computedAt: 10 }, 20);
      // Corrupt one row out-of-band, the way disk corruption would.
      const raw = new Database(path);
      raw.run("UPDATE fetches SET survivors_json = '{not json' WHERE model = 'vendor/model'");
      raw.close();

      const states = db.loadRoutingStates(false);
      const corrupt = states.find((state) => state.model === "vendor/model")!;
      // The row still claims to be fresh, but routing is gone: the plugin then
      // forces a re-rank on the next request instead of passing requests
      // through unrouted for the whole TTL.
      expect(corrupt.lastFetched).toBe(20);
      expect(corrupt.routing).toBeUndefined();
      // A legitimately empty ranking keeps its routing snapshot.
      const empty = states.find((state) => state.model === "vendor/empty")!;
      expect(empty.routing).toEqual({
        survivors: [],
        blacklist: [],
        computedAt: 10,
        mode: "cheapest",
      });
    } finally {
      db.close();
      removeDir(dir);
    }
  });

  test("a corrupt blacklist_json reads as never ranked instead of an empty blacklist", () => {
    const dir = mkdtempSync(join(tmpdir(), "optimizer-db-"));
    const path = join(dir, "corrupt-blacklist.db");
    const db = new OptimizerDb(path);
    try {
      db.saveRefresh("vendor/model", { survivors: ["a"], blacklist: ["b"], computedAt: 10 }, 20);
      // Corrupt the blacklist out-of-band, the way disk corruption would.
      const raw = new Database(path);
      raw.run("UPDATE fetches SET blacklist_json = '{not json' WHERE model = 'vendor/model'");
      raw.close();

      const states = db.loadRoutingStates(false);
      const corrupt = states.find((state) => state.model === "vendor/model")!;
      // The row still claims to be fresh, but routing is gone: the plugin then
      // forces a re-rank instead of silently treating the blacklist as empty
      // and re-allowing the providers it was meant to block.
      expect(corrupt.lastFetched).toBe(20);
      expect(corrupt.routing).toBeUndefined();
    } finally {
      db.close();
      removeDir(dir);
    }
  });

  test("recordFailure increments attempts and stores the backoff deadline", () => {
    const db = new OptimizerDb(":memory:");
    try {
      db.ensureFetchRow("vendor/model", 1);
      db.recordFailure("vendor/model", 100, 5_000);
      expect(db.getFetch("vendor/model")).toMatchObject({
        attempts: 1,
        last_attempt: 100,
        retry_after: 5_000,
      });

      db.recordFailure("vendor/model", 200, 9_000);
      expect(db.getFetch("vendor/model")).toMatchObject({
        attempts: 2,
        last_attempt: 200,
        retry_after: 9_000,
      });
    } finally {
      db.close();
    }
  });

  test("loadRoutingStates returns the cached compact view", () => {
    const db = new OptimizerDb(":memory:");
    try {
      db.saveRefresh(
        "vendor/model",
        { survivors: ["a"], blacklist: ["b"], computedAt: 10, mode: "free" },
        20,
      );
      const states = db.loadRoutingStates();
      expect(states).toHaveLength(1);
      expect(states[0].routing).toEqual({
        survivors: ["a"],
        blacklist: ["b"],
        computedAt: 10,
        mode: "free",
      });
      expect(states[0].lastFetched).toBe(20);
    } finally {
      db.close();
    }
  });

  test("migrates a legacy rankings_json/endpoints_json database in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "optimizer-db-"));
    const path = join(dir, "legacy.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE fetches (
        model TEXT PRIMARY KEY,
        last_fetched INTEGER,
        endpoints_json TEXT,
        rankings_json TEXT,
        updated_at INTEGER
      );
    `);
    legacy
      .prepare(
        `INSERT INTO fetches (model, last_fetched, endpoints_json, rankings_json, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "vendor/model",
        123,
        JSON.stringify([{ model_id: "vendor/model" }]),
        JSON.stringify({
          rankings: [{ slug: "a", perRequest: 0.1 }],
          survivors: ["a"],
          blacklist: ["b"],
          computedAt: 456,
          mode: "cheapest",
        }),
        789,
      );
    legacy.close();

    const db = new OptimizerDb(path);
    try {
      const row = db.getFetch("vendor/model")!;
      expect(row.last_fetched).toBe(123);
      expect(row.survivors_json).toBe(JSON.stringify(["a"]));
      expect(row.blacklist_json).toBe(JSON.stringify(["b"]));
      expect(row.computed_at).toBe(456);
      expect(row.details_json).toBe(JSON.stringify([{ slug: "a", perRequest: 0.1 }]));
      expect(db.getRankings("vendor/model")?.rankings).toEqual([{ slug: "a", perRequest: 0.1 }]);
    } finally {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
      } catch {
        // Windows can hold the WAL handle briefly; the temp dir is safe to leave behind.
      }
    }
  });
});
