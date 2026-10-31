/** Dump the optimizer DB: fetch/ranking state. Usage: bun run scripts/inspect.ts [--db path] */

import { argv } from "bun"
import { OptimizerDb, routingStateFromRow } from "../src/db"

const flagIndex = argv.indexOf("--db")
const path = flagIndex !== -1 ? argv[flagIndex + 1] : undefined
const db = new OptimizerDb(path)

const state = db.state()
const now = Date.now()

console.log("== fetch/rank state ==")
for (const row of state.fetches) {
  const entry = routingStateFromRow(row, false)
  const survivors = entry.routing?.survivors ?? []
  const blacklistSize = entry.routing?.blacklist.length ?? 0
  const mode = entry.routing?.mode ?? "cheapest"
  const age = row.last_fetched === null ? "never" : `${Math.round((now - row.last_fetched) / 3_600_000)}h ago`
  const retry =
    entry.retryAfter && entry.retryAfter > now ? `  retry in ${Math.round((entry.retryAfter - now) / 1000)}s` : ""
  const attempts = entry.attempts > 0 ? `  attempts: ${entry.attempts}` : ""
  console.log(
    `${row.model}\n  last_fetched: ${age}  mode: ${mode}  survivors: [${survivors.join(", ")}]  blacklist: ${blacklistSize}${attempts}${retry}`,
  )
}

db.close()
