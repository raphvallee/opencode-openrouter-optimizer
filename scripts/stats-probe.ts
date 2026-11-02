import { OpenCodeStats, pickProfile } from "../src/stats.js";

const stats = new OpenCodeStats({ ttlMs: 60_000, log: (m) => console.log("log:", m) });
const t0 = performance.now();
const profiles = await stats.get();
console.log(`fetched in ${Math.round(performance.now() - t0)} ms, ${profiles.size} models`);

const target = "z-ai/glm-5.3-flash";
const profile = pickProfile(profiles, target);
console.log(target, "->", profile);
