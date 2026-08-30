# Codex safety-hook installation and warning path

- Implementation date: 2026-08-29
- Disclosure measurement date: 2026-08-30
- Pinned Codex version: `@openai/codex` 0.144.6
- Merged commit: `6337fee`

This is the Slice 4 implementation and evidence record for task `e2f28dac`. It records the installed checker, per-spawn verification, trusted hook maintenance, warning path, and the limits that the public disclosure must preserve.

## Installation and verification

At boot, Isomux builds or verifies a closure-stamped checker artifact on disk. Staleness is evaluated once per successful server preparation by comparing the embedded stamp with the current source-closure hash. The server keeps only the artifact metadata in memory.

Before every Codex spawn, `JsonRpcLiteClient.start()` resolves the effective `CODEX_HOME`, hashes the installed checker bytes, and compares them with the verified artifact hash. Missing or changed content is repaired from the artifact. The repair path verifies the artifact against its boot hash before copying it. Content mismatch repairs the installed file without rebuilding; a stale source stamp rebuilds the artifact without replacing the checker used by an already running session.

The installer appends one `PreToolUse` matcher with matcher `.*`, one command handler, and no configured timeout. It preserves user hooks and existing positional trust. It performs a narrow read-modify-write of `config.toml`, validates the result with Bun's TOML parser, and verifies the exact command, matcher, absent timeout, enabled state, and trusted hash after writing.

## Trust hash and boot deadline

Codex 0.144.6 does not publish the trust-hash rule as a stable contract. At boot, Isomux starts an unauthenticated scratch App Server and obtains `currentHash` from `hooks/list`. The proven Codex version is a production constant and an always-run test pin, so a dependency bump requires a new measurement.

The scratch process start, initialization, and `hooks/list` request share a 10-second deadline. Full boot preparation, including compilation, closure analysis, source-stamp verification, and the trust measurement, took about 2.41 seconds on 2026-08-29. The deadline therefore has about four times the observed headroom. A timeout rejects preparation, the office logs `artifact unavailable at boot` and continues to listen, and a later Codex spawn retries.

Neither a failed trust measurement nor failed artifact preparation is latched for the process lifetime. Both memoized promises reset after rejection. Each later Codex spawn retries the complete bounded preparation and returns the signed transcript warning if preparation is still unavailable.

## Two Codex hook identities

Codex has two positional hook identities, and they are not interchangeable:

- Trust state uses `<hooksPath>:pre_tool_use:<groupIndex>:<indexWithinGroup>`.
- `hook/completed` uses `displayOrder`, the flat handler position across all `PreToolUse` matcher groups.

They have the same numeric value in a layout with one handler per matcher group. That common layout hid the distinction until the Slice 4 review. A live layout with two user handlers in the first group and Isomux in the second measured matcher-group index 1 and `displayOrder` 2. Reviewer 3 independently measured three user handlers in group 0, one handler in group 1, and Isomux in group 2; Isomux had matcher-group index 2 and `displayOrder` 4.

Production keeps the identities separate. Trust maintenance uses the matcher-group index and the enforced in-group index 0. Warning ownership uses the source path plus the sum of handler counts in all preceding groups. Conflating them can suppress the warning for Isomux's own failed hook or mislabel a user's failed hook as an Isomux safety failure.

## Warning and failure behavior

Pre-spawn installation and trust failures are fail-open. The Codex process still starts, the server logs a cause-specific error, and the adapter enqueues the Nil-signed transcript warning. The adapter uses the installed source path plus flat `displayOrder` to surface technical failures only for the owned hook. A caught checker fault returns the same warning through `systemMessage`.

The signed text is:

> ISOMUX SAFETY WARNING: Safety checks failed for this tool call. Isomux allowed it without guard enforcement. Tell the office owner and check the isomux service logs.

## Live evidence and inferred link

On 2026-08-29, the production installer created a hook that `hooks/list` reported as trusted and enabled. The owned source path and `displayOrder` matched, the hook completed in 172 ms with no error entries, and the allowed Bash command exited successfully with its marker present.

The model declined to issue the protected command in the Slice 4 deny cell. Therefore, Slice 4 did not directly prove that the production-installed hook's deny blocks. The deny claim is a composition: Slice 4 proved the production installer creates a trusted hook that runs and returns a decision, while the Slice 1 live matrix on 2026-08-28 proved that a trusted deny blocked the action in both measured runs with no side effect. The link between the installed decision path and the measured Codex deny contract is inferred.

## Limits and tracked work

This is an honest-agent safety layer, not an operating-system boundary. Same-user file permissions do not isolate the checker from the agents it checks. Task `01f5038c`, **OS isolation: dedicated isomux Linux user**, tracks moving the service away from the owner's user ID so office processes cannot read the owner's personal files by default.

Task `aed42180`, **safety-policy path matching broken both ways**, corrected the measured relative-path under-match and state-root sibling over-match by passing the agent working directory into the policy.

A filesystem-capable MCP remains outside the mapped shell and patch action kinds. On 2026-08-30, Reviewer 3 measured that such an MCP action could write `~/.isomux/agents.json`, read `~/.isomux/codex-home/auth.json`, and replace `~/.isomux/bin/isomux-codex-safety-hook`. Mapping `apply_patch` closed one route, not the class.

Executable replacement at the same path affects the next tool call of a running session. Per-spawn content-hash repair limits replacement to the remainder of that current session. It reduces risk but does not provide tamper resistance or protect a live session.
