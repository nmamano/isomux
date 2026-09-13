# OpenCode feasibility gate

This directory contains the reproducible harness and evidence for the first
deliverable of task `6a43cd2f`. It does not contain a production adapter.

The gate uses only scratch repositories and profiles under `/tmp`. It drives
model-dependent checks through a deterministic local OpenAI-compatible mock.
It does not use a real provider credential.

Pinned targets on 2026-08-27:

- OpenCode V2 CLI beta: `0.0.0-beta-202608110357`
- OpenCode V2 client beta: `0.0.0-beta-18314`
- OpenCode V1 CLI and SDK stable baseline: `1.18.23`

These pins are a frozen historical record of the 2026-08-27 measurement and
will not be bumped. Only the V2 beta alias is affected: `opencode-ai` below
`1.1.10` carries a critical web UI XSS, and below `1.0.216` it carries a high
unauthenticated HTTP server RCE. The `beta` dist-tag still points at the pinned
`0.0.0-beta-202608110357`, and that line has published nothing since
2026-08-11. Every `0.0.0-beta-*` version is below `1.1.10`, so no V2 bump can
leave the affected ranges. Run this harness only in its scratch environment,
and do not expose its server. The office backend uses OpenCode `1.18.23`, which
is outside both affected ranges.

Install with `bun install --frozen-lockfile` in this directory. Do not run an
install from the repository root for this gate.
