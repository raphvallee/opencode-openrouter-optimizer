/** Live smoke check (network): bun run scripts/selfcheck.ts [model-slug] */

import { DEFAULT_OPTIONS } from "../src/config.js";
import { fetchModelEndpoints } from "../src/openrouter.js";
import { rankProviders } from "../src/ranking.js";

const model = process.argv[2] ?? "meta-llama/llama-3.3-70b-instruct";
const data = await fetchModelEndpoints(model);
console.log(`model: ${data.id} (${data.endpoints.length} endpoints)`);

// Typical mid-size coding-agent profile for the smoke test.
const profile = { avgInput: 20_000, avgOutput: 800, cacheHitRate: 0.4, numRequests: 42 };
const ranking = rankProviders(data.endpoints, profile, DEFAULT_OPTIONS);

console.log(`mode: ${ranking.mode}`);
console.log(`survivors:  [${ranking.survivors.join(", ")}]`);
console.log(`blacklist:  [${ranking.blacklist.join(", ")}]`);
for (const rank of ranking.rankings.slice(0, 5)) {
  const priceInNano = `${Math.round(rank.perRequest * 1e9)}e-9`;
  console.log(
    `#${rank.rank} ${rank.slug.padEnd(15)} up=${rank.slugUptime} ctx=${rank.endpoint.context_length} out=${rank.endpoint.max_completion_tokens} tools=${rank.endpoint.supported_parameters.includes("tools")} perRequest=${priceInNano}`,
  );
}
