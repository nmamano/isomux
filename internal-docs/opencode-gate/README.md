# OpenCode feasibility gate

This directory holds the evidence and report of the OpenCode feasibility
gate, the first deliverable of task `6a43cd2f`. It does not contain a
production adapter. The runnable harness, its `package.json` and lockfile
were removed on 2026-09-13 (Nil): its pinned V2 beta carried two Dependabot
advisories that no published version can clear, and the measurement is
complete. Recover the harness from git history (commit ab0fe75d or earlier)
if the gate ever needs re-running.

The gate uses only scratch repositories and profiles under `/tmp`. It drives
model-dependent checks through a deterministic local OpenAI-compatible mock.
It does not use a real provider credential.

Pinned targets on 2026-08-27:

- OpenCode V2 CLI beta: `0.0.0-beta-202608110357`
- OpenCode V2 client beta: `0.0.0-beta-18314`
- OpenCode V1 CLI and SDK stable baseline: `1.18.23`

Those pins were a frozen historical record of the 2026-08-27 measurement.
The V2 beta alias carried two advisories: `opencode-ai` below `1.1.10` has a
critical web UI XSS, and below `1.0.216` a high unauthenticated HTTP server
RCE; every `0.0.0-beta-*` version is below both, so no V2 bump could clear
them, which is why the pins were removed rather than bumped. The office
backend uses OpenCode `1.18.23`, outside both ranges.
