# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
