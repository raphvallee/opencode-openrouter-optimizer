/** bun:sqlite access layer: per-model fetch/ranking state, hot routing snapshot. */

import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { baseModelSlug } from "./openrouter"

/**
 * Normalized cross-provider model key: lowercase, dots -> dashes, variant suffixes
 * (":free", "#think") stripped. Used for usage accumulation and suffix matching,
 * so "claude-sonnet-4.5" and "claude-sonnet-4-5" and "anthropic/claude-sonnet-4.5:beta"
 * all line up per family.
 */
export function normalizeModelKey(modelId: string): string {
  const sliced = baseModelSlug((modelId ?? "").trim())
  return sliced.toLowerCase().replace(/\./g, "-")
}

export interface FetchRow {
  model: string
  last_fetched: number | null
  last_attempt: number | null
  attempts: number
  retry_after: number | null
  survivors_json: string | null
  blacklist_json: string | null
  mode: string | null
  computed_at: number | null
  details_json: string | null
  updated_at: number
}

/** Compact routing snapshot: the only data the request path needs. */
export interface RoutingSnapshot {
  survivors: string[]
  blacklist: string[]
  computedAt: number
  mode?: "free" | "cheapest"
}

/** Full snapshot used by tests, inspection and debug logging. */
export interface RankingSnapshot extends RoutingSnapshot {
  rankings: unknown[]
}

/** In-memory state for one model: fetch bookkeeping plus the compact routing. */
export interface RoutingState {
  model: string
  lastFetched: number | null
  lastAttempt: number | null
  attempts: number
  retryAfter: number | null
  routing?: RoutingSnapshot
  details?: unknown[]
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fetches (
    model TEXT PRIMARY KEY,
    last_fetched INTEGER,
    last_attempt INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER,
    survivors_json TEXT,
    blacklist_json TEXT,
    mode TEXT,
    computed_at INTEGER,
    details_json TEXT,
    updated_at INTEGER
  );
`

const MIGRATION_COLUMNS: Array<[string, string]> = [
  ["last_attempt", "INTEGER"],
  ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["retry_after", "INTEGER"],
  ["survivors_json", "TEXT"],
  ["blacklist_json", "TEXT"],
  ["mode", "TEXT"],
  ["computed_at", "INTEGER"],
  ["details_json", "TEXT"],
]

const SELECT_COLUMNS = `model, last_fetched, last_attempt, attempts, retry_after,
  survivors_json, blacklist_json, mode, computed_at, details_json, updated_at`

const SELECT_COLUMNS_LEAN = `model, last_fetched, last_attempt, attempts, retry_after,
  survivors_json, blacklist_json, mode, computed_at, updated_at`

function openPath(explicit?: string): string {
  if (explicit) return explicit
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode")
  return join(base, "openrouter-optimizer.db")
}

function parseBlacklist(json: string | null): string[] | null {
  if (json === null) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    // A blacklist entry that is not a string means the row is damaged. Treat the
    // whole snapshot as unreadable so the next request re-ranks instead of silently
    // dropping a provider from the blacklist and re-allowing its traffic.
    if (parsed.some((value) => typeof value !== "string")) return null
    return parsed as string[]
  } catch {
    return null
  }
}

/**
 * Strict variant for survivors_json. Corrupt or non-array JSON returns null
 * instead of [], so a damaged row reads as "never ranked": routing becomes
 * undefined and the next request forces a re-rank, instead of a phantom
 * zero-survivor ranking silently passing requests through unrouted for the
 * whole TTL. A legitimately empty ranking still parses as [] and keeps its
 * routing snapshot.
 */
function parseSurvivors(json: string | null): string[] | null {
  if (json === null) return null
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : null
  } catch {
    return null
  }
}

function parseDetails(json: string | null): unknown[] | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function modeOf(value: string | null): "free" | "cheapest" {
  return value === "free" ? "free" : "cheapest"
}

/** Build the in-memory state from a stored row. Parsing stays in one place. */
export function routingStateFromRow(row: FetchRow, withDetails = true): RoutingState {
  const survivors = parseSurvivors(row.survivors_json)
  const blacklist = parseBlacklist(row.blacklist_json)
  const routing: RoutingSnapshot | undefined =
    survivors !== null && blacklist !== null
      ? {
          survivors,
          blacklist,
          computedAt: row.computed_at ?? row.updated_at,
          mode: modeOf(row.mode),
        }
      : undefined
  return {
    model: row.model,
    lastFetched: row.last_fetched,
    lastAttempt: row.last_attempt,
    attempts: row.attempts ?? 0,
    retryAfter: row.retry_after,
    routing,
    details: withDetails ? parseDetails(row.details_json) : undefined,
  }
}

/**
 * Upgrades a pre-compact DB in place: adds the new columns, folds rankings_json into
 * the compact columns, then reclaims the legacy write-only columns. Safe on every open.
 */
function migrate(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(fetches)`).all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))
  const hadLegacy = names.has("rankings_json") || names.has("endpoints_json")

  for (const [name, declaration] of MIGRATION_COLUMNS) {
    if (names.has(name)) continue
    try {
      db.exec(`ALTER TABLE fetches ADD COLUMN ${name} ${declaration}`)
    } catch {
      // Another process may have won the race; verified below.
    }
  }
  const after = new Set(
    (db.prepare(`PRAGMA table_info(fetches)`).all() as Array<{ name: string }>).map((column) => column.name),
  )
  for (const [name] of MIGRATION_COLUMNS) {
    if (!after.has(name)) throw new Error(`optimizer db migration failed: missing column ${name}`)
  }
  if (!hadLegacy) return

  if (names.has("rankings_json")) {
    try {
      const rows = db
        .prepare(`SELECT model, rankings_json, updated_at FROM fetches WHERE rankings_json IS NOT NULL AND survivors_json IS NULL`)
        .all() as Array<{ model: string; rankings_json: string; updated_at: number }>
      if (rows.length > 0) {
        const update = db.prepare(`
          UPDATE fetches SET survivors_json = ?, blacklist_json = ?, mode = ?, computed_at = ?, details_json = ?, updated_at = ?
          WHERE model = ?
        `)
        const backfill = db.transaction((batch: typeof rows) => {
          for (const row of batch) {
            try {
              const parsed = JSON.parse(row.rankings_json) as {
                survivors?: unknown
                blacklist?: unknown
                mode?: unknown
                computedAt?: unknown
                rankings?: unknown
              }
              const survivors = Array.isArray(parsed.survivors) ? parsed.survivors : []
              const blacklist = Array.isArray(parsed.blacklist) ? parsed.blacklist : []
              const details = Array.isArray(parsed.rankings) ? parsed.rankings : []
              update.run(
                JSON.stringify(survivors),
                JSON.stringify(blacklist),
                parsed.mode === "free" ? "free" : "cheapest",
                typeof parsed.computedAt === "number" ? parsed.computedAt : row.updated_at,
                details.length > 0 ? JSON.stringify(details) : null,
                row.updated_at,
                row.model,
              )
            } catch {
              // A corrupt legacy row degrades to "no ranking" and is refreshed lazily.
            }
          }
        })
        backfill(rows)
      }
    } catch {
      // Another process dropped the legacy column while we were migrating.
    }
  }

  // Release the legacy payloads. DROP is best-effort: older SQLite builds keep the
  // columns, but they are now NULL and never selected.
  const legacyColumns = ["rankings_json", "endpoints_json"].filter((name) => names.has(name))
  if (legacyColumns.length > 0) {
    try {
      db.exec(`UPDATE fetches SET ${legacyColumns.map((name) => `${name} = NULL`).join(", ")}`)
    } catch {
      // ignored, another process may have dropped them
    }
    for (const name of legacyColumns) {
      try {
        db.exec(`ALTER TABLE fetches DROP COLUMN ${name}`)
      } catch {
        // ignored
      }
    }
  }
}

export class OptimizerDb {
  private readonly db: Database
  private readonly selectFetch: Statement
  private readonly selectAll: Statement
  private readonly selectAllLean: Statement
  private readonly insertFetchRow: Statement
  private readonly saveRefreshStmt: Statement
  private readonly recordFailureStmt: Statement
  private readonly upsertRanking: Statement
  private readonly touchFetch: Statement
  private closed = false

  constructor(path?: string) {
    const file = openPath(path)
    const dir = dirname(file)
    if (file !== ":memory:" && dir && dir !== ".") mkdirSync(dir, { recursive: true })
    this.db = new Database(file, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec("PRAGMA synchronous = NORMAL;")
    this.db.exec("PRAGMA busy_timeout = 3000;")
    this.db.exec(SCHEMA)
    migrate(this.db)
    // Usage is no longer tracked by the plugin (dropped in favor of OpenCode's own
    // `stats --json` data); remove the legacy table from pre-existing DB files.
    this.db.exec("DROP TABLE IF EXISTS usage;")

    this.selectFetch = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM fetches WHERE model = ?`)
    this.selectAll = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM fetches`)
    this.selectAllLean = this.db.prepare(`SELECT ${SELECT_COLUMNS_LEAN} FROM fetches`)
    this.insertFetchRow = this.db.prepare(`INSERT OR IGNORE INTO fetches (model, updated_at) VALUES (?, ?)`)
    this.touchFetch = this.db.prepare(`
      INSERT INTO fetches (model, last_fetched, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        last_fetched = excluded.last_fetched,
        updated_at = excluded.updated_at
    `)
    this.saveRefreshStmt = this.db.prepare(`
      INSERT INTO fetches
        (model, last_fetched, last_attempt, attempts, retry_after,
         survivors_json, blacklist_json, mode, computed_at, details_json, updated_at)
      VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        last_fetched = excluded.last_fetched,
        last_attempt = excluded.last_attempt,
        attempts = 0,
        retry_after = NULL,
        survivors_json = excluded.survivors_json,
        blacklist_json = excluded.blacklist_json,
        mode = excluded.mode,
        computed_at = excluded.computed_at,
        details_json = excluded.details_json,
        updated_at = excluded.updated_at
    `)
    this.recordFailureStmt = this.db.prepare(`
      INSERT INTO fetches (model, last_attempt, attempts, retry_after, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        last_attempt = excluded.last_attempt,
        attempts = fetches.attempts + 1,
        retry_after = excluded.retry_after,
        updated_at = excluded.updated_at
    `)
    this.upsertRanking = this.db.prepare(`
      INSERT INTO fetches (model, survivors_json, blacklist_json, mode, computed_at, details_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        survivors_json = excluded.survivors_json,
        blacklist_json = excluded.blacklist_json,
        mode = excluded.mode,
        computed_at = excluded.computed_at,
        details_json = excluded.details_json,
        updated_at = excluded.updated_at
    `)
  }

  /** Throwing early beats a confusing "database is closed" sqlite error mid-statement. */
  private assertOpen(): void {
    if (this.closed) throw new Error("optimizer db is closed")
  }

  /** Exact model row; last_fetched === null means "prices were never fetched". */
  getFetch(model: string): FetchRow | undefined {
    this.assertOpen()
    return this.selectFetch.get(model) as FetchRow | undefined
  }

  /** One INSERT OR IGNORE plus one SELECT, instead of SELECT/INSERT/SELECT. */
  ensureFetchRow(model: string, now: number): FetchRow {
    this.assertOpen()
    this.insertFetchRow.run(model, now)
    return this.selectFetch.get(model) as FetchRow
  }

  /** All persisted model states, used to warm the in-process routing cache. */
  loadRoutingStates(withDetails = true): RoutingState[] {
    const statement = withDetails ? this.selectAll : this.selectAllLean
    return (statement.all() as FetchRow[]).map((row) => routingStateFromRow(row, withDetails))
  }

  /** Compact routing for one model, or undefined when nothing was ranked yet. */
  getRouting(model: string): RoutingSnapshot | undefined {
    const row = this.getFetch(model)
    return row ? routingStateFromRow(row).routing : undefined
  }

  /** Persist one successful refresh in a single UPSERT (QW-8). */
  saveRefresh(model: string, routing: RoutingSnapshot, now: number, details?: unknown[]): void {
    this.assertOpen()
    this.saveRefreshStmt.run(
      model,
      now,
      now,
      JSON.stringify(routing.survivors),
      JSON.stringify(routing.blacklist),
      routing.mode ?? "cheapest",
      routing.computedAt,
      details && details.length > 0 ? JSON.stringify(details) : null,
      now,
    )
  }

  /** Persist a failed attempt with its backoff deadline. */
  recordFailure(model: string, now: number, retryAfter: number): void {
    this.assertOpen()
    this.recordFailureStmt.run(model, now, retryAfter, now)
  }

  /** Legacy-compatible fetch write: last_fetched only, no endpoint payload. */
  recordFetch(model: string, _endpoints: unknown, now: number): void {
    this.assertOpen()
    this.touchFetch.run(model, now, now)
  }

  getRankings(model: string): RankingSnapshot | undefined {
    const row = this.getFetch(model)
    if (!row) return undefined
    const state = routingStateFromRow(row)
    if (!state.routing) return undefined
    return { ...state.routing, rankings: state.details ?? [] }
  }

  /** Rankings write used by tests and tooling; the plugin uses saveRefresh. */
  setRanking(model: string, ranking: RankingSnapshot): void {
    this.upsertRanking.run(
      model,
      JSON.stringify(ranking.survivors),
      JSON.stringify(ranking.blacklist),
      ranking.mode ?? "cheapest",
      ranking.computedAt,
      ranking.rankings.length > 0 ? JSON.stringify(ranking.rankings) : null,
      Date.now(),
    )
  }

  state(): { fetches: FetchRow[] } {
    return { fetches: this.selectAll.all() as FetchRow[] }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
