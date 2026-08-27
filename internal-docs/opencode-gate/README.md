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

Install with `bun install --frozen-lockfile` in this directory. Do not run an
install from the repository root for this gate.
