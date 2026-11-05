/**
 * Probe: run the real ranking logic against a real model's endpoints and print
 * the blacklist grouped by reason set, the way debugBlacklistReasons does.
 * Usage: bun run scripts/probe-reasons.ts <model-slug>
 */

import { argv } from "bun";

import { DEFAULT_OPTIONS } from "../src/config.js";
import { fetchModelEndpoints } from "../src/openrouter.js";
import type { RequestProfile } from "../src/pricing.js";
import { blacklistMissSeverity, formatBlacklistValue, rankProviders } from "../src/ranking.js";

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
const groups = new Map<string, Array<{ slug: string; values: string; severity: number }>>();
for (const slug of ranking.blacklist) {
  const reasons = ranking.blacklistReasons?.[slug] ?? [];
  const key =
    reasons.map((entry) => `${entry.reason} (${entry.threshold})`).join(" + ") || "unknown";
  const values = reasons
    .flatMap((entry) =>
      entry.value === undefined ? [] : [formatBlacklistValue(entry.reason, entry.value)],
    )
    .join(", ");
  const list = groups.get(key) ?? [];
  list.push({ slug, values, severity: blacklistMissSeverity(reasons) });
  groups.set(key, list);
}
for (const [key, members] of [...groups.entries()].sort()) {
  const sorted = [...members].sort((a, b) => a.severity - b.severity || (a.slug < b.slug ? -1 : 1));
  const slugs = sorted
    .map((member) => (member.values ? `${member.slug} (${member.values})` : member.slug))
    .join(", ");
  console.log(`  ${key}: ${slugs}`);
}
