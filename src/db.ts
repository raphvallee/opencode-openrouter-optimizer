/** bun:sqlite access layer: per-model fetch/ranking state, hot routing snapshot. */

import { Database, type Statement } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, lstatSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { baseModelSlug } from "./openrouter.js";
import { stripControlChars } from "./sanitize.js";
import type { BlacklistReason } from "./ranking.js";

/**
 * Normalized cross-provider model key: lowercase, dots -> dashes, variant suffixes
 * (":free", "#think") stripped. Used for usage accumulation and suffix matching,
 * so "claude-sonnet-4.5" and "claude-sonnet-4-5" and "anthropic/claude-sonnet-4.5:beta"
 * all line up per family.
 */
export function normalizeModelKey(modelId: string): string {
  const sliced = baseModelSlug((modelId ?? "").trim());
  return sliced.toLowerCase().replace(/\./g, "-");
}

export interface FetchRow {
  model: string;
  last_fetched: number | null;
  last_attempt: number | null;
  attempts: number;
  retry_after: number | null;
  survivors_json: string | null;
  blacklist_json: string | null;
  mode: string | null;
  computed_at: number | null;
  details_json: string | null;
  blacklist_reasons_json: string | null;
  updated_at: number;
}

/** Compact routing snapshot: the only data the request path needs. */
export interface RoutingSnapshot {
  survivors: string[];
  blacklist: string[];
  computedAt: number;
  mode?: "free" | "cheapest";
}

/** Full snapshot used by tests, inspection and debug logging. */
export interface RankingSnapshot extends RoutingSnapshot {
  rankings: unknown[];
  blacklistReasons?: Record<string, BlacklistReason[]>;
}

/** In-memory state for one model: fetch bookkeeping plus the compact routing. */
export interface RoutingState {
  model: string;
  lastFetched: number | null;
  lastAttempt: number | null;
  attempts: number;
  retryAfter: number | null;
  routing?: RoutingSnapshot;
  details?: unknown[];
  blacklistReasons?: Record<string, BlacklistReason[]>;
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
    blacklist_reasons_json TEXT,
    updated_at INTEGER
  );
`;

const MIGRATION_COLUMNS: Array<[string, string]> = [
  ["last_fetched", "INTEGER"],
  ["last_attempt", "INTEGER"],
  ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["retry_after", "INTEGER"],
  ["survivors_json", "TEXT"],
  ["blacklist_json", "TEXT"],
  ["mode", "TEXT"],
  ["computed_at", "INTEGER"],
  ["details_json", "TEXT"],
  ["blacklist_reasons_json", "TEXT"],
];

const SELECT_COLUMNS = `model, last_fetched, last_attempt, attempts, retry_after,
  survivors_json, blacklist_json, mode, computed_at, details_json, blacklist_reasons_json, updated_at`;

const SELECT_COLUMNS_LEAN = `model, last_fetched, last_attempt, attempts, retry_after,
  survivors_json, blacklist_json, mode, computed_at, updated_at`;

/**
 * Resolve the configured path to a stable absolute one. ":memory:" passes through;
 * anything else is resolved against the CWD for relative paths, which is exactly
 * how the filesystem would interpret it anyway.
 */
function openPath(explicit?: string): string {
  if (explicit === ":memory:") return explicit;
  if (explicit) return resolve(explicit);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "openrouter-optimizer.db");
}

/** Provider slugs are short lowercase tags; anything else is damaged data. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Hard ceiling on persisted slug lists, so no refresh can balloon the db or requests. */
const MAX_SLUGS = 512;
/** Disk timestamps may not be more than this far in the future (clock skew). */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** Clamp a stored timestamp into the sane range; unusable values read as "never". */
function cleanTimestamp(value: number | null, now: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  // A future timestamp would make a row look fresh forever; clamp it to now.
  return value > now + MAX_FUTURE_SKEW_MS ? now : value;
}

function parseSlugArray(json: string | null, emptyWhenNull: "empty" | "null"): string[] | null {
  if (json === null) return emptyWhenNull === "empty" ? [] : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SLUGS) return null;
  const seen = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || !isSlug(value)) return null;
    seen.add(value);
  }
  return [...seen];
}

/** Rename a broken database out of the way; keeps it for forensics, never deletes. */
function quarantineFile(file: string): void {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (!existsSync(candidate)) continue;
    try {
      renameSync(candidate, `${candidate}.corrupt-${Date.now()}`);
    } catch {
      // leave it; opening will fail loudly below
    }
  }
}

function warnLocal(message: string, detail?: unknown): void {
  const suffix =
    detail === undefined ? "" : ` ${detail instanceof Error ? detail.message : String(detail)}`;
  console.warn(`[openrouter-optimizer] ${stripControlChars(message)}${stripControlChars(suffix)}`);
}

function parseBlacklist(json: string | null): string[] | null {
  return parseSlugArray(json, "empty");
}

function parseSurvivors(json: string | null): string[] | null {
  return parseSlugArray(json, "null");
}

function parseDetails(json: string | null): unknown[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const out: unknown[] = [];
    for (const entry of parsed.slice(0, 1_000)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.slug !== "string" || !isSlug(record.slug)) continue;
      if (
        record.perRequest !== undefined &&
        (typeof record.perRequest !== "number" || !Number.isFinite(record.perRequest))
      ) {
        continue;
      }
      if (
        record.failedReasons !== undefined &&
        (!Array.isArray(record.failedReasons) ||
          record.failedReasons.some((reason) => typeof reason !== "string" || reason.length > 200))
      ) {
        continue;
      }
      out.push(entry);
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * One persisted block cause: the check, the threshold it enforces, the value
 * it was measured against and how far past the threshold that value is.
 * Debug-only payload: a malformed value just means no reasons are shown, never
 * a routing change.
 */
function parseBlacklistReason(value: unknown): BlacklistReason | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.reason !== "string" ||
    record.reason.length === 0 ||
    record.reason.length > 40 ||
    typeof record.threshold !== "string" ||
    record.threshold.length === 0 ||
    record.threshold.length > 200
  ) {
    return undefined;
  }
  if (
    record.value !== undefined &&
    (typeof record.value !== "number" || !Number.isFinite(record.value))
  )
    return undefined;
  if (
    typeof record.magnitude !== "number" ||
    !Number.isFinite(record.magnitude) ||
    record.magnitude < 0 ||
    record.magnitude > 1
  ) {
    return undefined;
  }
  const parsed: BlacklistReason = {
    reason: record.reason,
    threshold: record.threshold,
    magnitude: record.magnitude,
  };
  if (record.value !== undefined) parsed.value = record.value;
  return parsed;
}

/**
 * slug -> why it was blacklisted, one entry per cause with its threshold, the
 * provider's value and the miss magnitude. A payload in the pre-threshold
 * shape (plain strings) reads as missing so the debug path's bounded re-rank
 * rewrites it in the richer shape on the next refresh.
 */
function parseBlacklistReasons(json: string | null): Record<string, BlacklistReason[]> | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const out = Object.create(null) as Record<string, BlacklistReason[]>;
    let entries = 0;
    for (const [slug, reasons] of Object.entries(parsed)) {
      if (entries >= MAX_SLUGS) return undefined;
      if (!isSlug(slug) || slug === "__proto__") return undefined;
      if (!Array.isArray(reasons) || reasons.length > 32) return undefined;
      const parsedReasons: BlacklistReason[] = [];
      for (const reason of reasons) {
        const parsedReason = parseBlacklistReason(reason);
        if (!parsedReason) return undefined;
        parsedReasons.push(parsedReason);
      }
      out[slug] = parsedReasons;
      entries += 1;
    }
    return out;
  } catch {
    return undefined;
  }
}

function modeOf(value: string | null): "free" | "cheapest" {
  return value === "free" ? "free" : "cheapest";
}

/** Build the in-memory state from a stored row. Parsing stays in one place. */
export function routingStateFromRow(row: FetchRow, withDetails = true): RoutingState {
  const now = Date.now();
  const survivors = parseSurvivors(row.survivors_json);
  const blacklist = parseBlacklist(row.blacklist_json);
  const lastFetched = cleanTimestamp(row.last_fetched, now);
  const lastAttempt = cleanTimestamp(row.last_attempt, now);
  const retryAfter = cleanTimestamp(row.retry_after, now);
  const computedAt = cleanTimestamp(row.computed_at ?? row.updated_at, now);
  const routing: RoutingSnapshot | undefined =
    survivors !== null && blacklist !== null && computedAt !== null
      ? {
          survivors,
          blacklist,
          computedAt,
          mode: modeOf(row.mode),
        }
      : undefined;
  return {
    model: row.model,
    lastFetched,
    lastAttempt,
    attempts: Math.max(0, Number.isFinite(row.attempts) ? row.attempts : 0),
    retryAfter,
    routing,
    details: withDetails ? parseDetails(row.details_json) : undefined,
    blacklistReasons: withDetails ? parseBlacklistReasons(row.blacklist_reasons_json) : undefined,
  };
}

/**
 * Upgrades a pre-compact DB in place: adds the new columns, folds rankings_json into
 * the compact columns, then reclaims the legacy write-only columns. Safe on every open.
 */
function migrate(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(fetches)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const hadLegacy = names.has("rankings_json") || names.has("endpoints_json");

  for (const [name, declaration] of MIGRATION_COLUMNS) {
    if (names.has(name)) continue;
    try {
      db.exec(`ALTER TABLE fetches ADD COLUMN ${name} ${declaration}`);
    } catch {
      // Another process may have won the race; verified below.
    }
  }
  const after = new Set(
    (db.prepare(`PRAGMA table_info(fetches)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const [name] of MIGRATION_COLUMNS) {
    if (!after.has(name)) throw new Error(`optimizer db migration failed: missing column ${name}`);
  }
  if (!hadLegacy) return;

  if (names.has("rankings_json")) {
    try {
      const rows = db
        .prepare(
          `SELECT model, rankings_json, updated_at FROM fetches WHERE rankings_json IS NOT NULL AND survivors_json IS NULL`,
        )
        .all() as Array<{ model: string; rankings_json: string; updated_at: number }>;
      if (rows.length > 0) {
        const update = db.prepare(`
          UPDATE fetches SET survivors_json = ?, blacklist_json = ?, mode = ?, computed_at = ?, details_json = ?, updated_at = ?
          WHERE model = ?
        `);
        const backfill = db.transaction((batch: typeof rows) => {
          for (const row of batch) {
            try {
              const parsed = JSON.parse(row.rankings_json) as {
                survivors?: unknown;
                blacklist?: unknown;
                mode?: unknown;
                computedAt?: unknown;
                rankings?: unknown;
              };
              const survivors = Array.isArray(parsed.survivors) ? parsed.survivors : [];
              const blacklist = Array.isArray(parsed.blacklist) ? parsed.blacklist : [];
              const details = Array.isArray(parsed.rankings) ? parsed.rankings : [];
              update.run(
                JSON.stringify(survivors),
                JSON.stringify(blacklist),
                parsed.mode === "free" ? "free" : "cheapest",
                typeof parsed.computedAt === "number" ? parsed.computedAt : row.updated_at,
                details.length > 0 ? JSON.stringify(details) : null,
                row.updated_at,
                row.model,
              );
            } catch {
              // A corrupt legacy row degrades to "no ranking" and is refreshed lazily.
            }
          }
        });
        backfill(rows);
      }
    } catch {
      // Another process dropped the legacy column while we were migrating.
    }
  }

  // Release the legacy payloads. DROP is best-effort: older SQLite builds keep the
  // columns, but they are now NULL and never selected.
  const legacyColumns = ["rankings_json", "endpoints_json"].filter((name) => names.has(name));
  if (legacyColumns.length > 0) {
    try {
      db.exec(`UPDATE fetches SET ${legacyColumns.map((name) => `${name} = NULL`).join(", ")}`);
    } catch {
      // ignored, another process may have dropped them
    }
    for (const name of legacyColumns) {
      try {
        db.exec(`ALTER TABLE fetches DROP COLUMN ${name}`);
      } catch {
        // ignored
      }
    }
  }
}

/**
 * Stat the existing file and refuse anything but an owned regular file. There is a
 * small residual TOCTOU window between this check and the SQLite open; closing it
 * would require passing an O_NOFOLLOW file descriptor into the engine, which
 * bun:sqlite does not expose. Local write access to the data directory is therefore
 * still trusted - the checks catch mistakes, not an active same-uid attacker.
 */
function validateExistingFile(file: string): void {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return; // does not exist yet: fine
  }
  if (!stat.isFile()) {
    throw new Error(`refusing to open the optimizer database at ${file}: not a regular file`);
  }
  if (stat.nlink > 1) {
    throw new Error(
      `refusing to open the optimizer database at ${file}: it has ${stat.nlink} hard links`,
    );
  }
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new Error(
        `refusing to open the optimizer database at ${file}: owned by uid ${stat.uid}, not uid ${uid}`,
      );
    }
  }
}

/** Create the parent directory owner-only; pre-existing dirs are left alone. */
function createParentDirectory(dir: string): void {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed && typeof process.getuid === "function") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort
    }
  }
}

/**
 * A file is "ours" only when its fetches table carries the columns any released
 * version created (current compact rows have blacklist_json; pre-compact rows
 * carry the legacy rankings_json/endpoints_json pair; both have model/updated_at).
 * Anything else is treated as foreign and left untouched.
 */
function hasOurTables(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(fetches)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((column) => column.name));
    const hasIdentity = names.has("model") && names.has("updated_at");
    const hasOurMarker =
      names.has("blacklist_json") || names.has("rankings_json") || names.has("endpoints_json");
    return hasIdentity && hasOurMarker;
  } catch {
    return false;
  }
}

/** Open and verify the db; `expectRecognized` rejects foreign files unmodified. */
function openVerifiedDb(file: string, expectRecognized: boolean): Database {
  const db = new Database(file, { create: true });
  try {
    const row = db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
    const check = row ? Object.values(row)[0] : "ok";
    if (check !== "ok") {
      throw new Error(`database fails PRAGMA quick_check: ${String(check)}`);
    }
    if (expectRecognized && !hasOurTables(db)) {
      throw new Error(
        `FOREIGNDB: ${file} is not an optimizer database (missing optimizer columns); set "dbPath" to a different file, nothing was modified`,
      );
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // best effort
    }
    throw error;
  }
}

/** Owner-only permissions on the file and any existing WAL/SHM sidecars (POSIX). */
function hardenFilePermissions(file: string): void {
  if (file === ":memory:" || typeof process.getuid !== "function") return;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(candidate, 0o600);
    } catch {
      // best effort; platform may not support chmod
    }
  }
}

export class OptimizerDb {
  private readonly db: Database;
  private readonly selectFetch: Statement;
  private readonly selectAll: Statement;
  private readonly selectAllLean: Statement;
  private readonly insertFetchRow: Statement;
  private readonly saveRefreshStmt: Statement;
  private readonly recordFailureStmt: Statement;
  private readonly upsertRanking: Statement;
  private readonly touchFetch: Statement;
  private readonly resetUnreadableStmt: Statement;
  private closed = false;

  /** Marks a file that "looks like a database but is not ours"; never quarantined. */
  private static isForeignDb(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith("FOREIGNDB:");
  }

  constructor(path?: string) {
    const file = openPath(path);
    const isMemory = file === ":memory:";
    const existed = isMemory ? false : existsSync(file) && lstatSync(file).size > 0;
    if (!isMemory) {
      validateExistingFile(file);
      const dir = dirname(file);
      if (dir && dir !== ".") createParentDirectory(dir);
    }
    let db: Database;
    try {
      db = openVerifiedDb(file, existed);
    } catch (error) {
      if (OptimizerDb.isForeignDb(error) || isMemory || !existed) throw error;
      // Broken file (not a database, or fails quick_check): move it aside and
      // start fresh. The broken file is kept for forensics, never deleted.
      warnLocal(
        `database at ${file} is unreadable; moved aside and recreated from scratch.`,
        error,
      );
      quarantineFile(file);
      db = openVerifiedDb(file, false);
    }
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    migrate(this.db);
    // Usage is no longer tracked by the plugin (dropped in favor of OpenCode's own
    // `stats --json` data); remove the legacy table from pre-existing DB files.
    this.db.exec("DROP TABLE IF EXISTS usage;");
    hardenFilePermissions(file);

    this.selectFetch = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM fetches WHERE model = ?`);
    this.selectAll = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM fetches LIMIT 5000`);
    this.selectAllLean = this.db.prepare(`SELECT ${SELECT_COLUMNS_LEAN} FROM fetches LIMIT 5000`);
    this.insertFetchRow = this.db.prepare(
      `INSERT OR IGNORE INTO fetches (model, updated_at) VALUES (?, ?)`,
    );
    this.touchFetch = this.db.prepare(`
      INSERT INTO fetches (model, last_fetched, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        last_fetched = excluded.last_fetched,
        updated_at = excluded.updated_at
    `);
    // details_json / blacklist_reasons_json use COALESCE so a refresh that
    // carries no debug payload (the zero-survivors fallback calls saveRefresh
    // with undefined) preserves the stored metadata instead of wiping it; an
    // actual refresh with a payload overwrites it normally.
    this.saveRefreshStmt = this.db.prepare(`
      INSERT INTO fetches
        (model, last_fetched, last_attempt, attempts, retry_after,
         survivors_json, blacklist_json, mode, computed_at, details_json, blacklist_reasons_json, updated_at)
      VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        last_fetched = excluded.last_fetched,
        last_attempt = excluded.last_attempt,
        attempts = 0,
        retry_after = NULL,
        survivors_json = excluded.survivors_json,
        blacklist_json = excluded.blacklist_json,
        mode = excluded.mode,
        computed_at = excluded.computed_at,
        details_json = COALESCE(excluded.details_json, fetches.details_json),
        blacklist_reasons_json = COALESCE(excluded.blacklist_reasons_json, fetches.blacklist_reasons_json),
        updated_at = excluded.updated_at
    `);
    this.recordFailureStmt = this.db.prepare(`
      INSERT INTO fetches (model, last_attempt, attempts, retry_after, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        last_attempt = excluded.last_attempt,
        attempts = fetches.attempts + 1,
        retry_after = excluded.retry_after,
        updated_at = excluded.updated_at
    `);
    this.upsertRanking = this.db.prepare(`
      INSERT INTO fetches (model, survivors_json, blacklist_json, mode, computed_at, details_json, blacklist_reasons_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        survivors_json = excluded.survivors_json,
        blacklist_json = excluded.blacklist_json,
        mode = excluded.mode,
        computed_at = excluded.computed_at,
        details_json = excluded.details_json,
        blacklist_reasons_json = excluded.blacklist_reasons_json,
        updated_at = excluded.updated_at
    `);
    // A row that claims a fresh ranking but carries none must stop claiming it:
    // "fresh" without a ranking routes nothing while it looks fresh for the
    // whole TTL. Reset it to "never ranked" so the next request re-ranks it.
    this.resetUnreadableStmt = this.db.prepare(`
      UPDATE fetches SET
        last_fetched = NULL,
        last_attempt = NULL,
        attempts = 0,
        retry_after = NULL,
        survivors_json = NULL,
        blacklist_json = NULL,
        mode = NULL,
        computed_at = NULL,
        updated_at = ?
      WHERE model = ?
    `);
  }

  /** Throwing early beats a confusing "database is closed" sqlite error mid-statement. */
  private assertOpen(): void {
    if (this.closed) throw new Error("optimizer db is closed");
  }

  /** Exact model row; last_fetched === null means "prices were never fetched". */
  getFetch(model: string): FetchRow | undefined {
    this.assertOpen();
    return this.selectFetch.get(model) as FetchRow | undefined;
  }

  /** One INSERT OR IGNORE plus one SELECT, instead of SELECT/INSERT/SELECT. */
  ensureFetchRow(model: string, now: number): FetchRow {
    this.assertOpen();
    this.insertFetchRow.run(model, now);
    return this.selectFetch.get(model) as FetchRow;
  }

  /** All persisted model states, used to warm the in-process routing cache. */
  loadRoutingStates(withDetails = true): RoutingState[] {
    const statement = withDetails ? this.selectAll : this.selectAllLean;
    return (statement.all() as FetchRow[]).map((row) => routingStateFromRow(row, withDetails));
  }

  /** Compact routing for one model, or undefined when nothing was ranked yet. */
  getRouting(model: string): RoutingSnapshot | undefined {
    const row = this.getFetch(model);
    return row ? routingStateFromRow(row).routing : undefined;
  }

  /** Persist one successful refresh in a single UPSERT (QW-8). */
  saveRefresh(
    model: string,
    routing: RoutingSnapshot,
    now: number,
    details?: unknown[],
    blacklistReasons?: Record<string, BlacklistReason[]>,
  ): void {
    this.assertOpen();
    const survivors = [...new Set(routing.survivors)].filter(isSlug).slice(0, MAX_SLUGS);
    const blacklist = [...new Set(routing.blacklist)].filter(isSlug).slice(0, MAX_SLUGS);
    const detailsJson =
      details && details.length > 0 ? JSON.stringify(details.slice(0, 1_000)) : null;
    const reasonsJson =
      blacklistReasons && Object.keys(blacklistReasons).length > 0
        ? JSON.stringify(blacklistReasons)
        : null;
    const MAX_PAYLOAD = 256 * 1024;
    const detailsOut = detailsJson && detailsJson.length > MAX_PAYLOAD ? null : detailsJson;
    const reasonsOut = reasonsJson && reasonsJson.length > MAX_PAYLOAD ? null : reasonsJson;
    this.saveRefreshStmt.run(
      model,
      now,
      now,
      JSON.stringify(survivors),
      JSON.stringify(blacklist),
      routing.mode ?? "cheapest",
      routing.computedAt,
      detailsOut,
      reasonsOut,
      now,
    );
  }

  /** Persist a failed attempt with its backoff deadline. */
  recordFailure(model: string, now: number, retryAfter: number): void {
    this.assertOpen();
    this.recordFailureStmt.run(model, now, retryAfter, now);
  }

  /**
   * Reset a row whose stored ranking is unreadable (corrupt JSON, or a fetch
   * that was recorded without its ranking). The row keeps its identity, but it
   * stops claiming to be freshly ranked: a stale "fresh" marker on a row with
   * no ranking is what makes the plugin warn about it on every start.
   */
  resetUnreadableRanking(model: string): void {
    this.assertOpen();
    this.resetUnreadableStmt.run(Date.now(), model);
  }

  /** Legacy-compatible fetch write: last_fetched only, no endpoint payload. */
  recordFetch(model: string, _endpoints: unknown, now: number): void {
    this.assertOpen();
    this.touchFetch.run(model, now, now);
  }

  getRankings(model: string): RankingSnapshot | undefined {
    const row = this.getFetch(model);
    if (!row) return undefined;
    const state = routingStateFromRow(row);
    if (!state.routing) return undefined;
    return {
      ...state.routing,
      rankings: state.details ?? [],
      blacklistReasons: state.blacklistReasons,
    };
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
      ranking.blacklistReasons && Object.keys(ranking.blacklistReasons).length > 0
        ? JSON.stringify(ranking.blacklistReasons)
        : null,
      Date.now(),
    );
  }

  /** `state()` is for tooling; never returns an unbounded scan either. */
  state(): { fetches: FetchRow[] } {
    return { fetches: this.selectAll.all() as FetchRow[] };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
