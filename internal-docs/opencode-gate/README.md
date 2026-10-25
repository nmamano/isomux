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

## OpenCode 2.1.4 gate (2026-10-25)

The second run of the gate, for the move to `@opencode/cli` 2.1.4 (task
`4840abc5`), is [`report-2.1.4.md`](report-2.1.4.md). Its evidence is in
`evidence/2.1.4/` and its probe scripts in `harness-2.1.4/`. The scripts are a
frozen record of that run and have no package manifest, so no dependency alert
attaches to them; the report gives the install line for the exact pin. They
are outside the root `tsconfig.json` include and the ESLint scope.

[`release-note-2.1.4.md`](release-note-2.1.4.md) is the GitHub Release note of
the release that carries the OpenCode 2 cut-over (tasks `e47be82a`, `4b354a81`,
`6018743c`, `75904a56`, `bd218a3f`). The file holds only the note: cut that
release with `scripts/release.sh --notes-file
internal-docs/opencode-gate/release-note-2.1.4.md`.
