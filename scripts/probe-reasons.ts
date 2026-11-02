/**
 * Probe: run the real ranking logic against a real model's endpoints and print
 * the blacklist grouped by reason set, the way debugBlacklistReasons does.
 * Usage: bun run scripts/probe-reasons.ts <model-slug>
 */

import { argv } from "bun";

import { DEFAULT_OPTIONS } from "../src/config.js";
import { fetchModelEndpoints } from "../src/openrouter.js";
import type { RequestProfile } from "../src/pricing.js";
import { rankProviders } from "../src/ranking.js";

const model = argv[2] ?? "deepseek/deepseek-chat-v3.1";
// The fallback profile the plugin uses before any usage stats exist.
const profile: RequestProfile = {
  avgInput: 20_000,
  avgOutput: 800,
  cacheHitRate: 0.2,
  numRequests: 0,
};

const endpoints = await fetchModelEndpoints(model);
const ranking = rankProviders(endpoints.endpoints, profile, DEFAULT_OPTIONS);

console.log(`model: ${model}  mode: ${ranking.mode}`);
console.log(`survivors (${ranking.survivors.length}): ${ranking.survivors.join(", ")}`);
console.log(`blacklist (${ranking.blacklist.length}):`);
const groups = new Map<string, string[]>();
for (const slug of ranking.blacklist) {
  const reasons = ranking.blacklistReasons?.[slug] ?? [];
  const key = [...reasons].sort().join(" + ") || "unknown";
  const list = groups.get(key) ?? [];
  list.push(slug);
  groups.set(key, list);
}
for (const [key, slugs] of [...groups.entries()].sort()) {
  console.log(`  ${key}: ${slugs.join(", ")}`);
}
