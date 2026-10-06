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

## Decision protocol

- Worker and reviewer settle implementation choices inside a slice.
- Isomux PM settles anything that changes scope, a public interface, a state layout or a ruling. Ask the PM; do not pick.
- A product tradeoff with no clear answer goes into the slice report as PARKED FOR NIL with a recommendation; the loop continues on the rest.

## Gates (every hand-off)

The room prompt gates (build:ui, scoped tests, eslint on touched files, `bunx tsc --noEmit`). Add the route-table tests (server/test-support/routes-table.test.ts, routes-agents-manifest.test.ts) when a route changes, identity-tokens.test.ts when a scope changes, and server/backends/opencode/authority-broker.prompt-routes.test.ts when an agent-reference page or the system prompt names a route. Container tests that need Docker are named in the slice report with their run command and result.

## Slices

- [ ] Slice 1: design doc (no product code)
- [ ] Slice 2+: cut from the approved design; the PM writes each pickup below

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
