# Slice loop: the server gets its own OS user

Board tasks 01f5038c (the split) and b38ddd02 (secrets, co-designed: [secrets-design.md](secrets-design.md)). Parked worktrees `loop-os-user` (slice 4) and `loop-os-user-b` (slice 6). Read this whole file at the start of every slice.

## North star

The server process runs as one OS user (the server user). Agents, terminals, apps, scheduled runs and everything else the office starts run as a second OS user (the agent user). Members and agents keep sharing the agent user with each other. The agent user cannot read or change the server's state directory, its credentials or the server code. This closes section 3.2 of docs/security-audit.md as far as the server is concerned.

## Rulings (final)

1. Nil, 2026-10-05: the split is server user vs agent user. Per-member OS users are not the goal (a collaboration tradeoff with no correct answer).
2. The task text of 01f5038c (one `isomux` user runs everything, the owner elevates with `su`) predates ruling 1. Ruling 1 wins.
3. The isomux repo is public and has self-hosters. Existing installs keep working with no action. A change for this office box lands on a generic surface (deploy/install.sh, server code, docs), never as a fix for this box alone.
4. No human-approval gates on agent actions; no arbitrary resource caps (Isomux design philosophy).
5. In scope: a directory fence on the routes that make the server read a file at a path an agent names (`resolveEditorPath` in server/file-editor.ts: POST /api/agents/:id/read-file and the JSON `{path}` form of PUT /api/apps/:name/thumbnail from task a5ab665e). Once the server has its own user, those routes must not read what the agent user cannot.
6. The office box that dogfoods the split moves only with Nil present: it needs sudo and a restart. The loop ships code, installer and docs; the box migration is PARKED FOR NIL.
7. Never restart the running office server. Never use sudo. Real two-user tests run in a container (Docker is available to office processes) or in a throwaway ISOMUX_HOME, never against the live office.
8. Isomux PM, 2026-10-06, on the design (internal-docs/os-user-split-design.md, section 10), all as designed unless stated:
   - The state layout, `split.json`, `SHARE_ROOT` and the identity rule (section 3.1.2).
   - The upload move with compatibility symlinks.
   - The switch `ISOMUX_AGENT_RUNNER` and the rig-only gate `ISOMUX_SPLIT_RIG=1` until the last slice.
   - The server user is `isomux-server`. The image gets a fixed uid that the slice proves is free in the base image.
   - The container switch is the env var `ISOMUX_SPLIT=1` on the same image.
   - Kubernetes, self-hosted-by-owner and macOS stay single-user by default in this loop.
   - Agent-reference pages stop pointing agents at state files in every mode, not only in split mode: discovery.md and cronjobs.md point at API routes. Reuse an existing route where one exists; add the smallest route where none does. `logDir` stays in the response.
10. Isomux PM, 2026-10-06 (slice 2): the trusted checks walk the whole code tree at every split-mode start, not depth 2 (bun install leaves dependency files at mode 0666; the full walk took 2.8 s on the rig). Slice 7 normalizes modes (no group or other write) in the image, the installer and every update. This replaces design section 2.4 "Depth".
11. Isomux PM, 2026-10-06 (slice 2): the image uid and gid for isomux-server are 10001 (gid 999 is systemd-journal in the image).
9. The design's PARKED FOR NIL items (P1 the agent user holds docker or sudo, P2 served code agent-writable, P3 split by default on fresh installs) wait for Nil. No slice depends on them before the last one.
12. Isomux PM, 2026-10-06 (slice 3, option B): the async conversion of `inspectStoredSession` and `checkSessionResumable` and their callers moves to slice 4, with the transcript and rollout checks. Ruling 10 was applied in slice 3.
13. Isomux PM, 2026-10-06, speed rules: one rig run per hand-off. The reviewer re-runs only the mutants for code that changed in that round. Slices 4 and 6 ran in parallel (worktrees `loop-os-user` and `loop-os-user-b`); the second to merge rebases.
14. Isomux PM, 2026-10-06 (slice 6 backups): the runner `tar` holds all of `AGENT_ROOT` with the credential exclusions, and the server `tar` takes `SHARE_ROOT/files`. A split backup holds what a single-user backup holds. The restore steps must work or be updated.
15. Nil, 2026-10-12: the split and the secrets system are co-designed in one lane; the split comes first. Design: [secrets-design.md](secrets-design.md); its PARKED FOR NIL items (D1-D5) wait for Nil.

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
- [x] Slice 3 (design slice 2): agent backends, identity rule. Approved by Reviewer 2 at 3c631f37, merged as one commit. Task d32356f2 reproduced and fixed. Bun 1.3.11 chmod drops the setgid bit, so the share uses chmod(1). Tier-2 live run: `scripts/split-rig-tier2.sh <rev>` copies the operator's Claude and Codex sign-ins into a throwaway rig container; PARKED FOR NIL, to run once on the slice-7 candidate.
- [ ] Slice 4 (design slice 3, part 1): session checks and resume paths in agent space. Parked at d14b92fa, never reviewed (see RESUME PLAN). Denied access in the OpenCode inspector (an `existsSync` false under a mode-000 directory reads as missing, server/backends/opencode/storage.ts) must be indeterminate in split mode, never missing; the reproducer becomes a test.
- [ ] Slice 5 (design slice 3, part 2): fence, agent-space files, routes that replace state reads. Also owns `moveClaudeSessionFile` (the cwd-change transcript rename and its reversal), per the slice 4 ruling.
- [ ] Slice 6 (design slice 4): apps, preview, cron, backups, admin.sock, OOM stamping of runner children (measure first). Parked at 3ccfe186, work in progress (see RESUME PLAN).
- [ ] Slice 7 (design slice 5): installer, migration with undo, container split, code-tree mode normalization, docs; removes the rig-only gate
- [ ] Secrets S1-S4 (secrets-design.md section 7): proxy tracer; members turn it on; git and CLIs; SSH

## RESUME PLAN (2026-10-12)

Measured with `git merge-tree --write-tree main <tip>` on main at bc2b9614, which shows the conflicts of a squashed rebase. No parked worktree was changed.

| Branch | Behind main | Branch diff | Conflicts | Files changed on both sides |
|---|---|---|---|---|
| Slice 4, d14b92fa (3 commits) | 153 commits | 33 files, +1792/-576 | 4 files, 7 hunks: agent-host.ts (1, imports), agent-manager.ts (2, the wake path), command-handlers.ts (2, the send dependency and the `/usage` Codex card), auth-detect.test.ts (2) | 17 |
| Slice 6, 3ccfe186 (6 commits, one a merge of main) | 152 commits | 23 files, +2089/-256 | 3 files, 5 hunks: backup.ts (2), backup.test.ts (2, 393 conflict lines), isomux-office.ts (1, the app supervisor pick) | 11 |
| Slice 6 on top of slice 4 | | | 2 more files: scripts/split-rig.sh, server/agent-runner/runner.ts | |

The markers are the small part. Main also changed these areas since the park:
- Sign-in handling (852fc577, adc43856): slice 4 fixed the Codex signed-out text in split mode; keep only what main does not already do.
- The office SQLite audit store (174c4542), which backups snapshot: the split backup (ruling 14) must keep the snapshot.
- The container image dropped Node and the separate Claude install (10ab025a): the rig builds from that Dockerfile, so its stubs need a re-check.

Recommendation: rebase, do not redo. Squash each branch to one commit first (slice 6 holds a merge commit), then rebase onto main, so each branch has one conflict round. Order: slice 4 (rebase, sign-in re-check, one rig run, its first review), then slice 6 on top (full tier-1 rig, review), then slice 5, then slice 7, then the secrets slices. Redo slice 4 only if its review finds that the async session checks no longer fit main's wake path.

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

## SLICE-4 PICKUP: session checks and resume paths (design slice 3, part 1)

Goal: in split mode, every check the server makes on a stored session reads agent space through the runner and never mistakes "denied" for "missing". After this slice a split office resumes Claude, Codex and OpenCode sessions as a single-user office does.

Scope:
- Make `Backend.inspectStoredSession` and `checkSessionResumable` async for all three backends and convert their callers: the boot restore (an async pre-pass), `canDemote` (resolve, then re-check without an await between the check and the change), `pickAutoResumeSessionId` (12 call sites in agent-manager, one in cronjob-manager).
- The Claude transcript existence and tail reads (claude.ts, agent-manager.ts, cwd-utils.ts) and the Codex rollout walk (cwd-utils.ts) go through AgentHost. In the slice-3 rig, a fork works but the resume after it fails: that must pass here.
- Denied access is indeterminate, never missing: EACCES, EPERM, and an existsSync false where stat would deny. Keep the stored id. Reproducer from review: /tmp/os3-review-r1/inspect-permission.ts (copy it into a test before /tmp loses it).
- Codex sign-in state (`isCodexAuthenticated`) and the `bin/codex` wrapper write move to agent space. In a slice-3 dry run, a signed-out Codex agent in split mode got the Claude sign-in text: fix it.
- Unchecked from slice 3: in 2 of 3 dry runs without credentials, a Codex agent's session ended before any log entry and the message was not logged. Check single-user mode first. If it happens there too, it is a separate bug: report it and do not fix it in this slice.
- Fix the two comments that still say the stdin bound is 1 MiB (frames.ts, client.ts); the measured bound is under 2 MiB.

Traps: single-user behavior must not change; the auto-resume and demote paths have tests that pin their no-await guards, so read them before converting. Write your state to a file in /tmp as you go and hand off near 50% context.

Acceptance: the rig resumes a Claude, a Codex and an OpenCode session after a split-office restart (stub binaries), keeps the stored id under a denied directory, and shows the Codex signed-out text for a signed-out Codex agent; the single-user scoped tests pass. The reviewer re-runs the rig on the approved hash.

Decide with the reviewer: the shape of the boot pre-pass; how the stub binaries model a resumable session.
Locked: rulings 1-11 and the design.

## SLICE-6 PICKUP (appended 2026-10-12 from the park notes): apps, preview, cron, backups, admin.sock, OOM stamping (design slice 4)

Historical: the pickup as written on 2026-10-06, when slice 6 ran in parallel with slice 4. The RESUME PLAN above supersedes its order: slice 6 now rebases onto slice 4 and runs after it.

Runs in parallel with slice 4, in its own worktree `loop-os-user-b`. Isomux PM merges both; the second to merge rebases.

Read internal-docs/os-user-split-design.md in full first; rulings 1-11 in internal-docs/os-user-loop.md settle its open items. Slices 1-3 are on main.

Goal: design slice 4 (section 8, item 4).
- Apps: `systemctl --user` and `journalctl --user` (app-supervisor.ts, `createSystemdHost().run`) and the app launcher and unit files run through AgentHost, so apps run under the agent user's manager. The container supervisor's client call goes through the runner (control.sock belongs to the agent user). The app unit-name identity follows design 3.1.2 (slice 3 added the identity rule; reuse it).
- Preview capture (preview-capture.ts): headless Chrome runs as the agent user; the PNG comes back through the runner.
- Cron runs: confirm each cron run's agent spawn already goes through the slice-3 backends, and fix any path that does not.
- Backups (Isomux PM ruling, 2026-10-06): app data moves to agent space, and backups keep it. The runner streams a tar of the app data into the same archive; the credential exclusions (backup.ts) stay.
- admin.sock: in split mode it also refuses the agent uid, and refuses to start if ISOMUX_RECOVERY_UID equals the agent uid.
- OOM stamping (server/oom-stamp.ts walks only server descendants): first measure in the rig whether runner children miss the stamp. If they do, the runner stamps its own children.

Speed rules (Isomux PM, 2026-10-06): one rig run per hand-off, not three. The reviewer re-runs only the mutants for code that changed in that round. Avoid touching agent-manager.ts session-resume code: slice 4 owns it.

Traps: single-user behavior must not change. Write your state to a file in /tmp as you go and hand off near 50% context.

Acceptance: the rig shows an app process, a preview Chrome and a cron run's agent as the agent uid; a backup archive holds app data written by the agent user and no credential file; admin.sock refuses the agent uid; the OOM finding is measured and, if real, fixed. Single-user scoped tests pass. The reviewer re-runs the rig on the approved hash.

Decide with the reviewer: how the tar stream is framed into the archive.
Locked: rulings 1-11 and the design.
