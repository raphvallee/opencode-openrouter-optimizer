# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Routing-failure toasts are no longer TUI-only: a new `./gui-experimental` part
  (`src/gui.tsx`, built as `dist/gui-experimental.cjs` with the
  `@opencode/plugin/gui` vite preset) runs in every OpenCode Desktop window,
  desktop app and web tabs alike, and raises the same error toast the TUI part
  raises. The shared detection, sanitization and dedupe logic moved to
  `src/failure.ts` so the two parts cannot drift.
- A `noGUI` option (default `false`) turns the GUI part off, the way `noTUI`
  turns the TUI part off; an invalid value is rejected at startup by the server
  part, which also validates unknown option keys.

## [0.2.0] - 2026-11-02

Security release. A full audit was run and its findings are fixed; see
`VULNERABILITY-AUDIT.md` for the audit and remediation status. There are no
breaking changes, but configuration is now stricter: anything invalid changes
nothing silently, it fails startup (or is ignored) loudly.

### Security

- The npm publish workflow cannot be command-injected via its manual `tag`
  input anymore: the value travels in `env`, is validated against
  `^[a-z0-9][a-z0-9._-]{0,127}$` before publish, and the release tag must match
  `package.json`. Actions are pinned to commit SHAs, the toolchain is pinned,
  `permissions: contents: read` and `persist-credentials: false` are set, and
  the release job runs in a protected `release` environment with provenance.
- The spawned `opencode stats` CLI no longer inherits your whole environment
  (including `OPENROUTER_MANAGEMENT_KEY` and cloud credentials); it gets an
  allowlisted runtime environment.
- `managementKeyEnv` cannot point at well-known cloud secrets
  (`AWS_*`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, ...); the value is never echoed,
  and overriding the default prints a warning naming the variable.
- `dbPath` is canonicalized, symlinks are refused, and a database file whose
  fetches table does not look like ours is refused unmodified; a corrupt one
  is quarantined to `*.corrupt-<timestamp>` and recreated. Foreign files are
  never migrated or modified. The database is owner-only (`0600`/`0700` where
  the platform supports it) and reads are capped at 5,000 rows.
- Routing from a poisoned or empty refresh is never persisted over a healthy
  snapshot; the previous ranking is kept until a good refresh lands.
  Disk timestamps are clamped, slugs are validated and capped on write and on
  read, and survivors are validated exactly like the blacklist.
- A routing failure is never silent: without a session it is logged; with a
  session it appears in the transcript and as a toast; the user's
  `extraIgnore` is now applied even when the filters leave zero survivors
  (never with `sort: "price"`).
- Upstream payloads are size-capped (5 MB) and shape-validated before use;
  request bodies are streamed with a 25 MB ceiling; provider slugs are
  validated (`^[a-z0-9][a-z0-9._-]{0,63}$`) everywhere they are built or read.
- Untrusted strings reaching logs, the TUI or transcripts are stripped of
  control characters (no ANSI/OSC injection) and length-capped.
- Discounts of 100%+ are rejected as broken pricing; honored discounts are
  capped at 50%; NaN cannot pass any filter; missing uptime is never read as a
  perfect score, and invalid health data fails closed.
- Authenticated requests to the Activity API use `redirect: "error"`.
- The stats child is capped at 10 MB of stdout / 64 KB of stderr; bodies and
  stats payloads over their caps are aborted, not buffered.

### Added

- `SECURITY.md` (reporting policy) and Dependabot for npm and GitHub Actions.
- 14 security-invariant tests (`test/security.test.ts`), covering routing
  safety, persistence gating, database hardening and input validation.

### Changed

- Configuration validation is stricter: control characters are rejected
  anywhere in string options, values are truncation-capped (200 chars) and
  redacted in errors for `*key*`/`*token*`/`*secret*` names, `extraIgnore`
  entries are validated provider slugs, `rankingWaitMs` is capped at 30 s,
  `ttlHours` at 720, `statsCacheMinutes` at 1440 and `statsDays` at 365.

## [0.1.0] - 2026-11-02

First published release.

### Added

- Cost-ranked OpenRouter routing. Per model, the plugin fetches the provider
  endpoints and their prices, ranks the survivors by expected cost, keeps the
  cheapest ones routable and injects the rest into `provider.ignore` on every
  request.
- Free mode: providers that serve a model for free stay routable, paid
  providers are blacklisted, and the free status is judged at the workload's
  context length.
- A rescue floor (`keepAtLeastN`) that keeps the least-bad providers routable
  when the quality filters would otherwise starve the routing.
- Quality filters on context window, completion cap, uptime and tool-call
  error rate.
- A usage-aware cost model that merges OpenCode statistics with OpenRouter
  Activity data and applies context-tiered endpoint pricing.
- A TUI part that raises an error toast for every routing failure, next to a
  `Routing failure` message in the session transcript.
- A sqlite-backed snapshot of the routing state, shared by every OpenCode
  instance and project.
- A publishable npm package: the plugin compiles to ESM JavaScript with type
  declarations in `dist/`, the server part is exported at `.` and the TUI part
  at `./tui`, and `build`, `clean`, `verify`, `prepack` and `prepublishOnly`
  scripts keep the published tarball reproducible.
- GitHub Actions workflows for continuous integration and for publishing to npm
  on a GitHub release.

### Changed

- The public entry point moved from `index.ts` to `src/index.ts`, matching the
  layout OpenCode expects from a plugin package.
- Relative imports carry their `.js` extension, so the compiled output is
  valid Node ESM and not only Bun-loadable source.
