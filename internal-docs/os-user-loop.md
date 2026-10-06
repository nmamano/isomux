# Slice loop: the server gets its own OS user

Board task 01f5038c. Worktree `loop-os-user` (`~/nil/isomux-worktrees/loop-os-user`). Read this whole file at the start of every slice.

## North star

The server process runs as one OS user (the server user). Agents, terminals, apps, scheduled runs and everything else the office starts run as a second OS user (the agent user). Members and agents keep sharing the agent user with each other. The agent user cannot read or change the server's state directory, its credentials or the server code. This closes section 3.2 of docs/security-audit.md as far as the server is concerned.

## Rulings (final)

1. Nil, 2026-10-05: the split is server user vs agent user. Per-member OS users are not the goal (a collaboration tradeoff with no correct answer).
2. The task text of 01f5038c (one `isomux` user runs everything, the owner elevates with `su`) predates ruling 1. Ruling 1 wins.
3. The isomux repo is public and has self-hosters. Existing installs keep working with no action. A change for this office box lands on a generic surface (deploy/install.sh, server code, docs), never as a fix for this box alone.
4. No human-approval gates on agent actions; no arbitrary resource caps (Isomux design philosophy).
5. In scope: a directory fence on the routes that make the server read a file at a path an agent names (`resolveEditorPath` in server/file-editor.ts: POST /api/agents/:id/read-file and the JSON `{path}` form of PUT /api/apps/:name/thumbnail from task a5ab665e). Once the server has its own user, those routes must not read what the agent user cannot.
6. The office box (auntie) moves to the split only with Nil present: it needs sudo and a restart. The loop ships code, installer and docs; the box migration is PARKED FOR NIL.
7. Never restart the running office server. Never use sudo. Real two-user tests run in a container (Docker is available to office processes) or in a throwaway ISOMUX_HOME, never against the live office.
8. Isomux PM, 2026-10-06, on the design (internal-docs/os-user-split-design.md, section 10), all as designed unless stated:
   - The state layout, `split.json`, `SHARE_ROOT` and the identity rule (section 3.1.2).
   - The upload move with compatibility symlinks.
   - The switch `ISOMUX_AGENT_RUNNER` and the rig-only gate `ISOMUX_SPLIT_RIG=1` until the last slice.
   - The server user is `isomux-server`. The image gets a fixed uid that the slice proves is free in the base image.
   - The container switch is the env var `ISOMUX_SPLIT=1` on the same image.
   - Kubernetes, self-hosted-by-owner and macOS stay single-user by default in this loop.
   - Agent-reference pages stop pointing agents at state files in every mode, not only in split mode: discovery.md and cronjobs.md point at API routes. Reuse an existing route where one exists; add the smallest route where none does. `logDir` stays in the response.
10. Isomux PM, 2026-10-06 (slice 2): the trusted checks walk the whole code tree at every split-mode start, not depth 2 (bun install leaves dependency files at mode 0666; the full walk took 2.8 s on the rig). Slice 6 normalizes modes (no group or other write) in the image, the installer and every update. This replaces design section 2.4 "Depth".
11. Isomux PM, 2026-10-06 (slice 2): the image uid and gid for isomux-server are 10001 (gid 999 is systemd-journal in the image).
9. The design's PARKED FOR NIL items (P1 docker/sudo on this box, P2 served code on this box, P3 split by default on fresh installs) wait for Nil. No slice depends on them before the last one.

## Decision protocol

- Worker and reviewer settle implementation choices inside a slice.
- Isomux PM settles anything that changes scope, a public interface, a state layout or a ruling. Ask the PM; do not pick.
- A product tradeoff with no clear answer goes into the slice report as PARKED FOR NIL with a recommendation; the loop continues on the rest.

## Gates (every hand-off)

The room prompt gates (build:ui, scoped tests, eslint on touched files, `bunx tsc --noEmit`). Add the route-table tests (server/test-support/routes-table.test.ts, routes-agents-manifest.test.ts) when a route changes, identity-tokens.test.ts when a scope changes, and server/backends/opencode/authority-broker.prompt-routes.test.ts when an agent-reference page or the system prompt names a route. Container tests that need Docker are named in the slice report with their run command and result.

## Slices

Loop slice N+1 is design slice N (section 8 of the design).

- [x] Slice 1: design doc. Approved by Reviewer 2 at 6472be7b, merged as one commit. Rulings in item 8.
- [x] Slice 2 (design slice 1): runner, AgentHost, trusted checks, terminal, Node probe, whole diff, tier-1 rig. Approved by Reviewer 3 at b8341b92, merged as one commit. Bun 1.3.11 cannot listen on an inherited fd, so slice 6 uses the RuntimeDirectory layout (design 2.3). Notes: Bun drops a close made inside Bun.listen open() (the runner defers it); Bun's net client reports an immediate peer close as ECONNREFUSED (the rig's raw client is Python); a rig build takes 4-7 min under load; in split mode the welcome agents' default cwd is the server HOME (fix in a later slice).
- [ ] Slice 3 (design slice 2): agent backends, identity rule, tier-2 live tests
- [ ] Slice 4 (design slice 3): fence, agent-space files, routes that replace state reads. Also carries, from slice 3 (Isomux PM, 2026-10-06): the async conversion of `inspectStoredSession` and `checkSessionResumable` for all three backends and their callers (boot, canDemote, pickAutoResumeSessionId), with the Claude transcript and Codex rollout existence checks. Until then a split office keeps the stored session id when the inspect throws.
- [ ] Slice 5 (design slice 4): apps, preview, cron, backups, admin.sock
- [ ] Slice 6 (design slice 5): installer, migration with undo, container split, docs; removes the rig-only gate

## SLICE-1 PICKUP: design

Goal: `internal-docs/os-user-split-design.md`, short and concrete, that the PM can rule on and later slices can implement from. No product code in this slice.

The doc answers, each with file:line evidence from the source:

1. Inventory: every process the server starts (Claude SDK child, Codex app-server, OpenCode server, terminals, apps, cronjob runs, browser, log search, backup, updater, hook builds, probes; find them all, `grep` for spawn sites in server/) and, per process, which user it must run as.
2. Spawn mechanism: how a process running as the server user starts a process as the agent user without giving the agent user a path back. Compare the candidates in a few lines each, for example a sudoers rule limited to `-u <agent user>`, a root-owned socket-activated helper like the installer's container-update helper, or systemd-run. Recommend one.
3. Files: what the server needs to read or write in agent-user space (transcripts the SDKs write, provider sign-ins in provider-homes, app data, worktrees) and what agents need from server space (env files injected at spawn, provider sign-ins). Propose the owner/group/mode model that makes both work.
4. The fence for ruling 5.
5. Each hosting path (installer, self-hosted by its owner, container image): what changes, and what stays single-user if the split does not fit (say why).
6. Migration of an existing install: the command or installer step, what it moves and re-owns, how it is undone, and the steps for this office box (to run later, with Nil).
7. How the slices will be tested for real: a two-user rig (container) that proves an agent-user process cannot read the server state and that the office still works end to end.
8. A slice plan: 3 to 6 vertical slices, each one shippable on its own, with the single-user path unchanged until the switch is turned on.

Traps:
- The docs/security-audit.md section 3 text is the public statement of the current boundary; the design states which lines change.
- The Claude SDK starts its child through the SDK; check how the SDK lets the caller control the spawn before assuming a wrapper works.
- Do not read or scan ~/.claude/projects.

Acceptance: the reviewer approves the doc; the worker reports the approved hash, the slice plan, and any item marked PARKED FOR NIL with a recommendation.

## SLICE-2 PICKUP: the runner and the proof (design slice 1)

Read internal-docs/os-user-split-design.md in full first; it is the spec. Rulings 8 and 9 settle its section 10.

Goal: design slice 1 (section 8, item 1). `server/agent-runner/`, its protocol and fixed entries, the `AgentHost` interface with `LocalAgentHost` and `RunnerAgentHost`, the trusted checks and the runner diagnostic (section 2.4). Move the terminal (#7), the Node probe (#7b) and the whole `/isomux-diff` (#11) onto `AgentHost`. Bring up the tier-1 rig (section 7) with the boundary, trusted-check, false-denial and diff tests.

Mechanics and traps:
- Single-user behavior must not change: `LocalAgentHost` is today's code path, and the existing suite runs unchanged with `ISOMUX_AGENT_RUNNER` unset.
- Split mode starts only with `ISOMUX_SPLIT_RIG=1` as well. No doc, installer or release text mentions split mode in this slice.
- Check whether Bun can listen on an inherited socket fd (section 2.3) and report the result; the unit design follows it in slice 6.
- Every denial assertion checks the exact errno (EACCES or EPERM). Agent-side checks run with `docker exec -u <agent>`, never through the runner.
- Keep the rig small: one script and one gated test file, as the design says. No rig framework.
- Container builds can balloon: fence heavy runs with `systemd-run --user --scope -p MemoryMax=...`.

Acceptance: the tier-1 tests named above pass in the rig, the single-user scoped tests pass, the reviewer re-runs the rig on the approved hash, and the report names the rig command, its result and the inherited-fd finding.

Decide with the reviewer: the frame format, the fixed-entry layout, the test split between unit tests and the rig.
Locked: rulings 1-9 and the design.

## SLICE-3 PICKUP: the agent backends (design slice 2)

Read internal-docs/os-user-split-design.md in full first; rulings 8-11 settle its open items.

Goal: design slice 2 (section 8, item 2). Claude (the `spawnClaudeCodeProcess` hook in `buildSdkOpts`, the one-shot and probe call sites, the session store load and append through the runner), Codex (`JsonRpcLiteClient.start`, the safety hook built into `SHARE_ROOT/bin`, the hooks.json and config.toml merge in agent space) and OpenCode (the start and stop helpers, profile files, `inspectOpenCodeDatabase` as a fixed entry, the authority socket in `SHARE_ROOT/authority/` with the agent uid as its expected peer) all go through `AgentHost`. Add the identity rule of design section 3.1.2.

Mechanics and traps:
- Single-user behavior must not change: the existing backend tests run unchanged with `ISOMUX_AGENT_RUNNER` unset.
- Task d32356f2: Codex `forkSessionBeforeMessage` and `getSessionMessages` start the app-server with no cwd and no env (adapter.ts). Reproduce it in single-user mode first; if it is real, fix it here, since these spawns move onto AgentHost in this slice anyway, and name the result.
- The rig proves each backend's spawn as the agent user with stub provider binaries (a fake `claude`, `codex` and `opencode` that report `id -u` and exercise the path) - no live provider credentials. The design's tier-2 live tests need a provider sign-in mounted into the rig: that is PARKED FOR NIL (it uses Nil's credentials); write the command, do not run it.
- The OpenCode ancestry walk across two users is unchecked in the design (section 3.4): prove it in the rig with a real authority request from a stub child.
- This slice is large. Write your state to a file in /tmp as you go, and hand off to a fresh session near 50% context at a natural break, with the hand-off brief naming that file.

Acceptance: the stub-backend rig tests prove each spawn runs as the agent uid, the session store reads and writes through the runner (a forked transcript is owned by the agent user), the safety hook runs from the share as the agent user, and an OpenCode authority request crosses the two users. The single-user scoped backend tests pass. The reviewer re-runs the rig on the approved hash. Report the rig command and result, the d32356f2 finding, and the tier-2 command left for Nil.

Decide with the reviewer: the adapter shapes for SpawnedProcess and the Codex client; how the stub binaries live in the rig.
Locked: rulings 1-11 and the design.
