import { describe, expect, test } from "bun:test";

import { DEFAULT_OPTIONS, resolveOptions } from "../src/config.js";

describe("resolveOptions", () => {
  test("returns defaults when no options are passed", () => {
    expect(resolveOptions()).toEqual(DEFAULT_OPTIONS);
    expect(resolveOptions({})).toEqual(DEFAULT_OPTIONS);
  });

  test("accepts valid option values, including numeric strings", () => {
    const options = resolveOptions({
      ttlHours: "12",
      topN: 4,
      keepAtLeastN: "2",
      minContextLength: 128_000,
      maxToolCallErrorRate: 5,
      injectSort: false,
      rankingWaitMs: 0,
      fallbackCacheHitRate: 0.5,
      extraIgnore: [" chutes ", "epsilon"],
      managementKeyEnv: "CUSTOM_KEY",
      statsCommand: " opencode ",
      statsDays: 7,
      statsCacheMinutes: 0,
      noTUI: "true",
      debug: "true",
    });
    expect(options.ttlHours).toBe(12);
    expect(options.topN).toBe(4);
    expect(options.keepAtLeastN).toBe(2);
    expect(options.minContextLength).toBe(128_000);
    expect(options.maxToolCallErrorRate).toBe(5);
    expect(options.injectSort).toBe(false);
    expect(options.rankingWaitMs).toBe(0);
    expect(options.fallbackCacheHitRate).toBe(0.5);
    expect(options.noTUI).toBe(true);
    expect(options.extraIgnore).toEqual(["chutes", "epsilon"]);
    expect(options.managementKeyEnv).toBe("CUSTOM_KEY");
    expect(options.statsCommand).toBe("opencode");
    expect(options.statsDays).toBe(7);
    expect(options.statsCacheMinutes).toBe(0);
    expect(options.debug).toBe(true);
  });

  test("rejects unknown keys with the key name and a case-insensitive suggestion", () => {
    expect(() => resolveOptions({ topn: 2 })).toThrow(
      /unknown option\(s\) "topn" \(did you mean "topN"\?\)/,
    );
    expect(() => resolveOptions({ unknownThing: true })).toThrow(
      /unknown option\(s\) "unknownThing"/,
    );
  });

  test("rejects invalid boolean values instead of silently using the default", () => {
    expect(() => resolveOptions({ injectSort: 0 })).toThrow(
      /option "injectSort" must be a boolean/,
    );
    expect(() => resolveOptions({ debug: "yes" })).toThrow(/option "debug" must be a boolean/);
    expect(() => resolveOptions({ noTUI: 0 })).toThrow(/option "noTUI" must be a boolean/);
    expect(() => resolveOptions({ noTUI: "yes" })).toThrow(/option "noTUI" must be a boolean/);
  });

  test("rejects non-numeric and out-of-range numbers", () => {
    expect(() => resolveOptions({ ttlHours: "6 hours" })).toThrow(
      /option "ttlHours" must be a finite number/,
    );
    expect(() => resolveOptions({ topN: 0 })).toThrow(/option "topN" must be >= 1/);
    expect(() => resolveOptions({ topN: 2.5 })).toThrow(/option "topN" must be an integer/);
    expect(() => resolveOptions({ keepAtLeastN: -1 })).toThrow(
      /option "keepAtLeastN" must be >= 0/,
    );
    expect(() => resolveOptions({ keepAtLeastN: 1.5 })).toThrow(
      /option "keepAtLeastN" must be an integer/,
    );
    expect(() => resolveOptions({ minUptimePercent: 101 })).toThrow(
      /option "minUptimePercent" must be <= 100/,
    );
    expect(() => resolveOptions({ maxToolCallErrorRate: -1 })).toThrow(
      /option "maxToolCallErrorRate" must be >= 0/,
    );
    expect(() => resolveOptions({ fallbackCacheHitRate: 2 })).toThrow(
      /option "fallbackCacheHitRate" must be <= 1/,
    );
  });

  test("keepAtLeastN defaults to 1 and accepts 0 to disable the fallback", () => {
    expect(DEFAULT_OPTIONS.keepAtLeastN).toBe(1);
    expect(resolveOptions({}).keepAtLeastN).toBe(1);
    expect(resolveOptions({ keepAtLeastN: 0 }).keepAtLeastN).toBe(0);
  });

  test("rejects non-array and non-string extraIgnore entries", () => {
    expect(() => resolveOptions({ extraIgnore: "chutes" })).toThrow(
      /option "extraIgnore" must be an array/,
    );
    expect(() => resolveOptions({ extraIgnore: ["ok", ""] })).toThrow(
      /option "extraIgnore\[1\]" must be a non-empty string/,
    );
    expect(() => resolveOptions({ extraIgnore: ["ok", 3 as never] })).toThrow(
      /option "extraIgnore\[1\]" must be a non-empty string/,
    );
  });

  test("rejects empty strings for string options", () => {
    expect(() => resolveOptions({ managementKeyEnv: "  " })).toThrow(
      /option "managementKeyEnv" must be a non-empty string/,
    );
    expect(() => resolveOptions({ statsCommand: "" })).toThrow(
      /option "statsCommand" must be a non-empty string/,
    );
    expect(() => resolveOptions({ dbPath: "" })).toThrow(
      /option "dbPath" must be a non-empty string when set/,
    );
  });

  test("rejects a non-function statsRun and non-object input", () => {
    expect(() => resolveOptions({ statsRun: "not a function" as never })).toThrow(
      /option "statsRun" must be a function/,
    );
    expect(() => resolveOptions(null)).toThrow(/plugin options must be an object/);
    expect(() => resolveOptions([])).toThrow(/plugin options must be an object/);
    expect(() => resolveOptions("options" as never)).toThrow(/plugin options must be an object/);
  });
});
