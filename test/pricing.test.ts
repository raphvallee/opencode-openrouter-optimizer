import { describe, expect, test } from "bun:test";

import {
  effectiveRates,
  hasKnownPricing,
  isFreePricing,
  perRequestCost,
  requestCost,
  totalCost,
} from "../src/pricing.js";

const pricing = {
  prompt: "0.0000002", // $0.20/M
  completion: "0.0000005", // $0.50/M
  input_cache_read: "0.0000001",
  input_cache_write: "0.0000004",
  discount: 0,
};

describe("effectiveRates", () => {
  test("applies the endpoint discount d to every rate", () => {
    const rates = effectiveRates({ ...pricing, discount: 0.25 });
    expect(rates.inputRate).toBeCloseTo(0.0000002 * 0.75);
    expect(rates.outputRate).toBeCloseTo(0.0000005 * 0.75);
    expect(rates.readRate).toBeCloseTo(0.0000001 * 0.75);
    expect(rates.writeRate).toBeCloseTo(0.0000004 * 0.75);
    expect(rates.discount).toBeCloseTo(0.25);
  });

  test("readRate falls back to inputRate without a cache-read price", () => {
    const rates = effectiveRates({ prompt: pricing.prompt, completion: pricing.completion });
    expect(rates.readRate).toBe(rates.inputRate);
  });

  test("writeRate defaults to 0 when unavailable", () => {
    const rates = effectiveRates({ prompt: pricing.prompt, completion: pricing.completion });
    expect(rates.writeRate).toBe(0);
  });

  test("unparseable cache-read prices fall back to the input rate", () => {
    for (const input_cache_read of ["", "N/A", "free", -1]) {
      const rates = effectiveRates({
        prompt: pricing.prompt,
        completion: pricing.completion,
        input_cache_read,
      });
      expect(rates.readRate).toBeCloseTo(rates.inputRate);
    }
  });

  test("malformed discount is ignored", () => {
    const rates = effectiveRates({ ...pricing, discount: 2 });
    expect(rates.discount).toBe(0);
    expect(rates.inputRate).toBe(0.0000002);
  });

  test("discount of exactly 1 is applied, not rejected", () => {
    const rates = effectiveRates({ ...pricing, discount: 1 });
    expect(rates.discount).toBe(1);
    expect(rates.inputRate).toBe(0);
    expect(rates.outputRate).toBe(0);
  });
});

describe("perRequestCost", () => {
  test("matches a hand-computed example", () => {
    // T_in = 10000, T_out = 2000, h = 0.4
    // input  = 10000 * (0.4 * 1e-7 + 0.6 * (2e-7 + 4e-7)) = 10000 * (4e-8 + 3.6e-7) = 0.004
    // output = 2000 * 5e-7 = 0.001
    const profile = { avgInput: 10_000, avgOutput: 2_000, cacheHitRate: 0.4, numRequests: 50 };
    const perRequest = perRequestCost(effectiveRates(pricing), profile);
    expect(perRequest).toBeCloseTo(0.005);
    expect(totalCost(perRequest, 50)).toBeCloseTo(0.25);
  });

  test("h = 1 bills only cache reads", () => {
    const rates = effectiveRates(pricing);
    const perRequest = perRequestCost(rates, {
      avgInput: 1000,
      avgOutput: 0,
      cacheHitRate: 1,
      numRequests: 1,
    });
    expect(perRequest).toBeCloseTo(1000 * rates.readRate);
  });

  test("h = 0 bills input + write", () => {
    const rates = effectiveRates(pricing);
    const perRequest = perRequestCost(rates, {
      avgInput: 1000,
      avgOutput: 0,
      cacheHitRate: 0,
      numRequests: 1,
    });
    expect(perRequest).toBeCloseTo(1000 * (rates.inputRate + rates.writeRate));
  });

  test("requestCost is the combined entrypoint", () => {
    const profile = { avgInput: 500, avgOutput: 100, cacheHitRate: 0, numRequests: 1 };
    const { perRequest, rates } = requestCost(pricing, profile);
    expect(rates.inputRate).toBeCloseTo(0.0000002);
    expect(perRequest).toBeCloseTo(500 * 0.0000002 + 500 * 0.0000004 + 100 * 0.0000005);
  });

  test("unparseable cache-read prices bill cached input at the input rate", () => {
    const profile = { avgInput: 1000, avgOutput: 0, cacheHitRate: 1, numRequests: 1 };
    for (const input_cache_read of ["", "N/A", "free", -1]) {
      const { perRequest } = requestCost(
        { prompt: "0.000001", completion: "0.000002", input_cache_read },
        profile,
      );
      expect(perRequest).toBeCloseTo(1000 * 0.000001);
    }
  });

  test("requestCost refuses unknown cache-write pricing instead of silently billing $0", () => {
    const profile = { avgInput: 1000, avgOutput: 0, cacheHitRate: 0, numRequests: 1 };
    expect(() =>
      requestCost(
        { prompt: "0.000001", completion: "0.000002", input_cache_write: "N/A" },
        profile,
      ),
    ).toThrow();
  });
});

describe("hasKnownPricing", () => {
  test("missing or unparseable prices are unknown, not free", () => {
    expect(hasKnownPricing({ prompt: "0.0000002", completion: "0.0000005" })).toBe(true);
    expect(hasKnownPricing({ prompt: "0", completion: "0" })).toBe(true);
    expect(hasKnownPricing({ prompt: "", completion: "0.0000005" })).toBe(false);
    expect(hasKnownPricing({ prompt: "N/A", completion: "0.0000005" })).toBe(false);
    expect(hasKnownPricing({ prompt: -1, completion: "0.0000005" })).toBe(false);
    expect(hasKnownPricing({ completion: "0.0000005" } as never)).toBe(false);
  });

  test("cache-write prices must be absent or parseable; cache-read prices may be unknown", () => {
    expect(
      hasKnownPricing({ prompt: "0.0000002", completion: "0.0000005", input_cache_write: "0" }),
    ).toBe(true);
    expect(
      hasKnownPricing({ prompt: "0.0000002", completion: "0.0000005", input_cache_write: "N/A" }),
    ).toBe(false);
    expect(
      hasKnownPricing({ prompt: "0.0000002", completion: "0.0000005", input_cache_write: "" }),
    ).toBe(false);
    expect(
      hasKnownPricing({ prompt: "0.0000002", completion: "0.0000005", input_cache_write: -1 }),
    ).toBe(false);
    expect(
      hasKnownPricing({ prompt: "0.0000002", completion: "0.0000005", input_cache_read: "N/A" }),
    ).toBe(true);
    expect(
      hasKnownPricing({ prompt: "0.0000002", completion: "0.0000005", input_cache_read: "" }),
    ).toBe(true);
  });
});

describe("isFreePricing", () => {
  test("unparseable prices are never classified as free", () => {
    expect(isFreePricing({ prompt: "", completion: "" })).toBe(false);
    expect(isFreePricing({ prompt: "free", completion: "0" })).toBe(false);
    expect(isFreePricing({ prompt: "0" } as never)).toBe(false);
  });

  test("a cache-write price makes the endpoint paid even with $0 base prices", () => {
    // The cost model bills uncached write tokens, so a positive cache-write price
    // yields a positive perRequestCost and must not read as "free".
    expect(isFreePricing({ prompt: "0", completion: "0", input_cache_write: "0.0000001" })).toBe(
      false,
    );
    expect(isFreePricing({ prompt: "0", completion: "0", input_cache_write: "0" })).toBe(true);
    expect(isFreePricing({ prompt: "0", completion: "0", input_cache_read: "0.0000001" })).toBe(
      false,
    );
  });

  test("an unparseable cache-read price falls back to the input price", () => {
    expect(isFreePricing({ prompt: "0", completion: "0", input_cache_read: "N/A" })).toBe(true);
    expect(isFreePricing({ prompt: "0.0000002", completion: "0", input_cache_read: "N/A" })).toBe(
      false,
    );
  });

  test("an unparseable cache-write price is unknown pricing, never free", () => {
    expect(isFreePricing({ prompt: "0", completion: "0", input_cache_write: "N/A" })).toBe(false);
    expect(isFreePricing({ prompt: "0", completion: "0", input_cache_write: "" })).toBe(false);
    expect(isFreePricing({ prompt: "0", completion: "0", input_cache_write: -1 })).toBe(false);
  });
});

describe("tiered pricing (context-size overrides)", () => {
  // OpenAI: GPT-6 Luna's real rates: base tier below 272K prompt tokens, a pricier
  // long-context tier strictly above it.
  const luna = {
    prompt: "0.00000005", // $0.05/M
    completion: "0.00000025", // $0.25/M
    input_cache_read: "0.000000005",
    input_cache_write: "0.0000000625",
    discount: 0,
    overrides: [
      {
        min_prompt_tokens: 272_000,
        prompt: "0.0000001", // $0.10/M
        completion: "0.000000375", // $0.375/M
        input_cache_read: "0.00000001",
        input_cache_write: "0.000000125",
      },
    ],
  };

  test("applies the long-context tier above the threshold", () => {
    const rates = effectiveRates(luna, 300_000);
    expect(rates.inputRate).toBeCloseTo(0.0000001);
    expect(rates.outputRate).toBeCloseTo(0.000000375);
    expect(rates.readRate).toBeCloseTo(0.00000001);
    expect(rates.writeRate).toBeCloseTo(0.000000125);
  });

  test("stays on the base tier at or below the threshold (strictly greater)", () => {
    for (const contextSize of [0, 271_999, 272_000]) {
      const rates = effectiveRates(luna, contextSize);
      expect(rates.inputRate).toBeCloseTo(0.00000005);
      expect(rates.outputRate).toBeCloseTo(0.00000025);
      expect(rates.readRate).toBeCloseTo(0.000000005);
      expect(rates.writeRate).toBeCloseTo(0.0000000625);
    }
  });

  test("without a context size the base tier is used", () => {
    const rates = effectiveRates(luna);
    expect(rates.inputRate).toBeCloseTo(0.00000005);
    expect(rates.outputRate).toBeCloseTo(0.00000025);
  });

  test("the endpoint discount applies to tier rates too", () => {
    const rates = effectiveRates({ ...luna, discount: 0.5 }, 300_000);
    expect(rates.inputRate).toBeCloseTo(0.00000005);
    expect(rates.outputRate).toBeCloseTo(0.0000001875);
  });

  test("keys an override omits inherit the base price", () => {
    const rates = effectiveRates(
      {
        prompt: "0.00000005",
        completion: "0.00000025",
        input_cache_read: "0.000000005",
        input_cache_write: "0.0000000625",
        overrides: [{ min_prompt_tokens: 100_000, prompt: "0.0000001", completion: "0.0000002" }],
      },
      200_000,
    );
    expect(rates.inputRate).toBeCloseTo(0.0000001);
    expect(rates.outputRate).toBeCloseTo(0.0000002);
    expect(rates.readRate).toBeCloseTo(0.000000005);
    expect(rates.writeRate).toBeCloseTo(0.0000000625);
  });

  test("later applicable entries win per key", () => {
    const rates = effectiveRates(
      {
        prompt: "0.00000005",
        completion: "0.00000025",
        overrides: [
          { min_prompt_tokens: 100_000, prompt: "0.0000001", completion: "0.0000005" },
          { min_prompt_tokens: 200_000, prompt: "0.0000002" },
        ],
      },
      300_000,
    );
    expect(rates.inputRate).toBeCloseTo(0.0000002);
    expect(rates.outputRate).toBeCloseTo(0.0000005);
  });

  test("time-windowed entries never apply; the base price is the documented default", () => {
    const rates = effectiveRates(
      {
        prompt: "0.00000005",
        completion: "0.00000025",
        overrides: [
          { utc_start: 0, utc_end: 1600, prompt: "0.0000005", completion: "0.000001" },
          { utc_start: 1600, utc_end: 0, prompt: "0.0000001", completion: "0.0000005" },
        ],
      },
      300_000,
    );
    expect(rates.inputRate).toBeCloseTo(0.00000005);
    expect(rates.outputRate).toBeCloseTo(0.00000025);
  });

  test("entries with unknown condition keys are skipped", () => {
    const rates = effectiveRates(
      {
        prompt: "0.00000005",
        completion: "0.00000025",
        overrides: [
          { min_prompt_tokens: 100_000, some_future_condition: true, prompt: "0.000001" } as never,
        ],
      },
      300_000,
    );
    expect(rates.inputRate).toBeCloseTo(0.00000005);
  });

  test("an override with a malformed threshold never applies", () => {
    const rates = effectiveRates(
      {
        prompt: "0.00000005",
        completion: "0.00000025",
        overrides: [
          { min_prompt_tokens: "N/A" as never, prompt: "0.000001", completion: "0.000002" },
        ],
      },
      300_000,
    );
    expect(rates.inputRate).toBeCloseTo(0.00000005);
    expect(rates.outputRate).toBeCloseTo(0.00000025);
  });

  test("an applicable override with unparseable prices is unknown pricing", () => {
    const broken = {
      prompt: "0.00000005",
      completion: "0.00000025",
      overrides: [{ min_prompt_tokens: 272_000, prompt: "N/A", completion: "0.000000375" }],
    };
    expect(hasKnownPricing(broken, 300_000)).toBe(false);
    expect(hasKnownPricing(broken, 100_000)).toBe(true);
    // Without a context size the check is conservative: every billable entry counts.
    expect(hasKnownPricing(broken)).toBe(false);
    const profile = { avgInput: 300_000, avgOutput: 0, cacheHitRate: 0, numRequests: 1 };
    expect(() => requestCost(broken, profile)).toThrow();
  });

  test("an applicable override with an unparseable cache-write price is unknown pricing", () => {
    const broken = {
      prompt: "0.00000005",
      completion: "0.00000025",
      overrides: [{ min_prompt_tokens: 272_000, input_cache_write: "" }],
    };
    expect(hasKnownPricing(broken, 300_000)).toBe(false);
    expect(hasKnownPricing(broken, 100_000)).toBe(true);
  });

  test("an override with an unparseable cache-read price falls back to the tier input rate", () => {
    const rates = effectiveRates(
      {
        prompt: "0.00000005",
        completion: "0.00000025",
        overrides: [{ min_prompt_tokens: 272_000, prompt: "0.0000001", input_cache_read: "N/A" }],
      },
      300_000,
    );
    expect(rates.readRate).toBeCloseTo(rates.inputRate);
    expect(rates.inputRate).toBeCloseTo(0.0000001);
  });

  test("requestCost bills the whole request at the tier the profile's context size picks", () => {
    // h = 0: input side is (inputRate + writeRate) per token.
    // Below the threshold: 200000 * (5e-8 + 6.25e-8) = 0.0225
    // Above the threshold: 300000 * (1e-7 + 1.25e-7) = 0.0675
    const below = { avgInput: 200_000, avgOutput: 0, cacheHitRate: 0, numRequests: 10 };
    const above = { avgInput: 300_000, avgOutput: 0, cacheHitRate: 0, numRequests: 10 };
    expect(requestCost(luna, below).perRequest).toBeCloseTo(0.0225);
    expect(requestCost(luna, above).perRequest).toBeCloseTo(0.0675);
    expect(totalCost(requestCost(luna, above).perRequest, 10)).toBeCloseTo(0.675);
  });

  test("free classification follows the tier the workload bills", () => {
    // Free below the threshold, paid above it.
    const freeBelow = {
      prompt: "0",
      completion: "0",
      overrides: [{ min_prompt_tokens: 100_000, prompt: "0.0000001", completion: "0" }],
    };
    expect(isFreePricing(freeBelow)).toBe(true);
    expect(isFreePricing(freeBelow, 50_000)).toBe(true);
    expect(isFreePricing(freeBelow, 100_000)).toBe(true);
    expect(isFreePricing(freeBelow, 200_000)).toBe(false);
    // Paid at the base tier, free above it.
    const freeAbove = {
      prompt: "0.0000001",
      completion: "0.0000002",
      overrides: [{ min_prompt_tokens: 100_000, prompt: "0", completion: "0" }],
    };
    expect(isFreePricing(freeAbove)).toBe(false);
    expect(isFreePricing(freeAbove, 200_000)).toBe(true);
  });
});
