import { describe, expect, test } from "bun:test"
import { effectiveRates, perRequestCost, requestCost, totalCost } from "../src/pricing"

const pricing = {
  prompt: "0.0000002", // $0.20/M
  completion: "0.0000005", // $0.50/M
  input_cache_read: "0.0000001",
  input_cache_write: "0.0000004",
  discount: 0,
}

describe("effectiveRates", () => {
  test("applies the endpoint discount d to every rate", () => {
    const rates = effectiveRates({ ...pricing, discount: 0.25 })
    expect(rates.inputRate).toBeCloseTo(0.0000002 * 0.75)
    expect(rates.outputRate).toBeCloseTo(0.0000005 * 0.75)
    expect(rates.readRate).toBeCloseTo(0.0000001 * 0.75)
    expect(rates.writeRate).toBeCloseTo(0.0000004 * 0.75)
    expect(rates.discount).toBeCloseTo(0.25)
  })

  test("readRate falls back to inputRate without a cache-read price", () => {
    const rates = effectiveRates({ prompt: pricing.prompt, completion: pricing.completion })
    expect(rates.readRate).toBe(rates.inputRate)
  })

  test("writeRate defaults to 0 when unavailable", () => {
    const rates = effectiveRates({ prompt: pricing.prompt, completion: pricing.completion })
    expect(rates.writeRate).toBe(0)
  })

  test("malformed discount is ignored", () => {
    const rates = effectiveRates({ ...pricing, discount: 2 })
    expect(rates.discount).toBe(0)
    expect(rates.inputRate).toBe(0.0000002)
  })
})

describe("perRequestCost", () => {
  test("matches a hand-computed example", () => {
    // T_in = 10000, T_out = 2000, h = 0.4
    // input  = 10000 * (0.4 * 1e-7 + 0.6 * (2e-7 + 4e-7)) = 10000 * (4e-8 + 3.6e-7) = 0.004
    // output = 2000 * 5e-7 = 0.001
    const profile = { avgInput: 10_000, avgOutput: 2_000, cacheHitRate: 0.4, numRequests: 50 }
    const perRequest = perRequestCost(effectiveRates(pricing), profile)
    expect(perRequest).toBeCloseTo(0.005)
    expect(totalCost(perRequest, 50)).toBeCloseTo(0.25)
  })

  test("h = 1 bills only cache reads", () => {
    const rates = effectiveRates(pricing)
    const perRequest = perRequestCost(rates, { avgInput: 1000, avgOutput: 0, cacheHitRate: 1, numRequests: 1 })
    expect(perRequest).toBeCloseTo(1000 * rates.readRate)
  })

  test("h = 0 bills input + write", () => {
    const rates = effectiveRates(pricing)
    const perRequest = perRequestCost(rates, { avgInput: 1000, avgOutput: 0, cacheHitRate: 0, numRequests: 1 })
    expect(perRequest).toBeCloseTo(1000 * (rates.inputRate + rates.writeRate))
  })

  test("requestCost is the combined entrypoint", () => {
    const profile = { avgInput: 500, avgOutput: 100, cacheHitRate: 0, numRequests: 1 }
    const { perRequest, rates } = requestCost(pricing, profile)
    expect(rates.inputRate).toBeCloseTo(0.0000002)
    expect(perRequest).toBeCloseTo(500 * 0.0000002 + 500 * 0.0000004 + 100 * 0.0000005)
  })
})
