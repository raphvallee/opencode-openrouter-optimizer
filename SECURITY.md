# Security Policy

## Supported versions

Only the latest published version of `opencode-openrouter-optimizer` receives
security fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities privately; do not open a public issue.

- Preferred: open a private GitHub Security Advisory on this repository
  ("Security" tab -> "Report a vulnerability").
- Alternative: email the maintainer; see the repository owner's GitHub profile.

Include the version, a minimal reproduction (for example, a crafted OpenRouter
endpoint response), and the impact you observed. You should get an
acknowledgement within 7 days.

Please note: the plugin is fail-open by design. If you find a path that fails
open **silently** (no toast, transcript message or log line), that is in scope
and counts as a vulnerability.

## Scope

- Routing logic, request mutation, and cache integrity
- Credential and environment handling (for example `OPENROUTER_MANAGEMENT_KEY`)
- CI/publish pipeline and published artifacts
